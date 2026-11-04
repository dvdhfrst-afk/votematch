/**
 * research-bodies-cron — picks N un-verified bodies + dispatches the
 * appropriate per-level agent for each. Designed for scale-out: starts
 * with small batches (10/day) once we trust the templates, ramps up as
 * confidence grows.
 *
 * Trigger: cron 'X X * * *' OR manual event 'research-bodies.manual'.
 *
 * Schedule discipline:
 *   - concurrency:1 — only one cron tick at a time
 *   - retries:0 — failed bodies stay un-verified; next tick picks them up
 *
 * Cost guard:
 *   - daily budget cap (BODY_RESEARCH_DAILY_BUDGET) — count successful
 *     researches today; if at cap, skip the tick
 *   - per-body retries are bounded by template; agent SDK handles its own
 */
import { inngest } from '../client';
import { createClient } from '@supabase/supabase-js';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { findTemplate } from '../../body-research/templates/_registry';
import { writeAgentResult } from '../../body-research/write';
import { writeTenures, type SeatToWrite } from '../../body-research/write-tenures';
import { pageFetchMcpServer, PAGE_FETCH_SERVER_NAME } from '../../agent-tools/page-fetch';
import { planAuthEnv } from '../../load-env';
import type { AgentInput, AgentResult } from '../../body-research/types';

const RESULTS_DIR_REL = 'data/body-research/results';
const DAILY_BUDGET = parseInt(process.env.BODY_RESEARCH_DAILY_BUDGET ?? '10', 10);

interface CronResult {
  attempted: number;
  ok: number;
  failed: number;
  skipped_no_template: number;
  todays_budget: number;
  bodies: Array<{ id: string; canonical_name: string; status: string; reason?: string }>;
}

export const researchBodiesCron = inngest.createFunction(
  {
    id: 'research-bodies-cron',
    concurrency: [{ limit: 1 }],
    retries: 0,
    triggers: [
      // Daily at 13:00 UTC (08:00 ET). Starts the day's research batch.
      // Adjust schedule as confidence in templates increases.
      { cron: '0 13 * * *' },
      { event: 'research-bodies.manual' },
    ],
  },
  async ({ step, event }: { step: any; event: any }) => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) return { skipped: 'missing supabase env' };

    const limit: number = event?.data?.limit ?? DAILY_BUDGET;
    const dryRun: boolean = !!event?.data?.dryRun;
    const runId = new Date().toISOString().slice(0, 19).replace(/[:T-]/g, '').slice(0, 14);

    return await step.run('research', async () => {
      const sb = createClient(url, key, { auth: { persistSession: false } });
      const resultsDir = resolve(process.cwd(), RESULTS_DIR_REL);
      try { mkdirSync(resultsDir, { recursive: true }); } catch { /* ignore */ }

      // Pick N oldest-unverified bodies. Order by created_at to avoid
      // skipping the same bodies forever (round-robin through the catalog).
      const { data: candidates, error: pickErr } = await sb
        .from('governing_bodies')
        .select('id, canonical_name, chamber_type, jurisdiction_id')
        .eq('size_authoritative', false)
        .order('created_at')
        .limit(limit);
      if (pickErr) return { error: pickErr.message };
      const bodies = (candidates as any[]) ?? [];
      if (bodies.length === 0) return { attempted: 0, message: 'No un-verified bodies remaining' };

      const result: CronResult = {
        attempted: bodies.length,
        ok: 0, failed: 0, skipped_no_template: 0,
        todays_budget: limit,
        bodies: [],
      };

      for (const body of bodies) {
        try {
          // Load full AgentInput
          const { data: jurRow } = await sb.from('jurisdictions').select('name, type, fips_state').eq('id', body.jurisdiction_id).single();
          const j = jurRow as any;
          const { data: officesData } = await sb.from('offices').select('id, canonical_name, seat_designation').eq('governing_body_id', body.id).limit(500);
          const attached = (officesData as any[]) ?? [];
          const input: AgentInput = {
            body_id: body.id,
            canonical_name: body.canonical_name,
            chamber_type: body.chamber_type,
            jurisdiction_name: j?.name ?? '(unknown)',
            jurisdiction_type: j?.type ?? '(unknown)',
            fips_state: j?.fips_state ?? null,
            attached_offices: attached,
          };
          const template = findTemplate(input);
          if (!template) {
            result.skipped_no_template++;
            result.bodies.push({ id: body.id, canonical_name: body.canonical_name, status: 'skipped', reason: 'no template' });
            continue;
          }

          const resultPath = join(resultsDir, `${body.id}.json`).replace(/\\/g, '/');
          const prompt = template.buildPrompt(input).replace('${RESULT_PATH}', resultPath);
          const expectedSize = Math.max(attached.length, 10);
          const maxTurns = expectedSize > 200 ? 40 : expectedSize > 50 ? 24 : 16;
          const iter = query({
            prompt,
            options: {
              // Plan auth, scoped to the spawned agent: blank the metered-auth
              // vars in the CHILD env only. This shared Next.js/Inngest process
              // also hosts the metered API paths, so never delete them from
              // process.env here — see planAuthEnv() in lib/load-env.
              env: planAuthEnv(),
              permissionMode: 'bypassPermissions',
              mcpServers: { [PAGE_FETCH_SERVER_NAME]: pageFetchMcpServer },
              // WebFetch removed deliberately — all HTTP routes through our
              // in-process smart_fetch (plain HTTP via politeFetch).
              allowedTools: [
                'WebSearch',
                'Read',
                'Write',
                `mcp__${PAGE_FETCH_SERVER_NAME}__smart_fetch`,
              ],
              model: 'sonnet',
              effort: 'low',
              maxTurns,
            },
          });
          let usage: any = null;
          for await (const msg of iter) {
            const m = msg as Record<string, unknown>;
            if (m.type === 'result') {
              const u = (m.usage ?? {}) as Record<string, number | undefined>;
              usage = {
                num_turns: m.num_turns,
                duration_ms: m.duration_ms,
                duration_api_ms: m.duration_api_ms,
                stop_reason: m.stop_reason,
                subtype: m.subtype,
                input_tokens: u.input_tokens ?? 0,
                output_tokens: u.output_tokens ?? 0,
                cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
                cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
              };
              try {
                const fs = await import('node:fs');
                fs.appendFileSync(
                  join(resultsDir, '_usage.jsonl'),
                  JSON.stringify({ run_id: runId, body_id: body.id, template: template.slug, ts: new Date().toISOString(), ...usage }) + '\n'
                );
              } catch {}
              break;
            }
          }
          if (!existsSync(resultPath)) {
            result.failed++;
            result.bodies.push({ id: body.id, canonical_name: body.canonical_name, status: 'failed', reason: 'no result file' });
            continue;
          }
          const agentRes = JSON.parse(readFileSync(resultPath, 'utf-8')) as AgentResult;
          const wr = await writeAgentResult(sb, agentRes, { bodyId: body.id, templateSlug: template.slug, runId, dryRun });
          // Promote seats to tenures
          if (agentRes.seats && agentRes.seats.length > 0) {
            const seatsToWrite: SeatToWrite[] = [];
            for (const seat of agentRes.seats) {
              if (!seat.current_officeholder) continue;
              const sd = (seat.seat_designation ?? '').toLowerCase();
              const matched = attached.find((o: any) => {
                const oSeat = (o.seat_designation ?? '').toLowerCase();
                const oName = (o.canonical_name ?? '').toLowerCase();
                return oSeat === sd || oName.includes(sd) || sd.includes(oSeat);
              });
              if (matched) seatsToWrite.push({ office_id: matched.id, seat_designation: seat.seat_designation, current_officeholder: seat.current_officeholder });
            }
            if (seatsToWrite.length > 0 && !dryRun) {
              await writeTenures(sb, seatsToWrite, { templateSlug: template.slug, runId, dryRun });
            }
          }
          result.ok++;
          result.bodies.push({ id: body.id, canonical_name: body.canonical_name, status: wr.bodyUpdated ? 'verified' : 'dry_run' });
        } catch (e) {
          result.failed++;
          result.bodies.push({ id: body.id, canonical_name: body.canonical_name, status: 'failed', reason: e instanceof Error ? e.message.slice(0, 120) : String(e).slice(0, 120) });
        }
      }
      return result;
    });
  },
);
