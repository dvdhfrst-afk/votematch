# Adapter escalations

Council #44, 2026-05-03. Replaces the extended-backoff approach (which would
have just postponed the same dumb failures forever) with a triage queue.

## Rule

After **2 consecutive failure outcomes** (`failed` | `unproductive` | 0-row
`partial`), an adapter is parked: `adapter_status.status = 'escalated'`,
`next_check_at` pushed to year 2099. continuous-ingest's task queue skips it
indefinitely.

A row is written to `adapter_escalations` carrying:

- the last 3 failure rows (status, error_summary, finished_at)
- the source URL extracted from the most recent error_summary
- empty slots for the higher-tier diagnosis: `root_cause`, `diagnosis`,
  `suggested_fix`, `resolution_pr`, `lesson`

A Sentry alert fires with `status='escalated'` and the escalation_id in
`error_summary`.

## Workflow

```
adapter run #1 fails (no_data) → consecutive_no_data = 1, next_check = +5min
adapter run #2 fails (no_data) → ESCALATE
                                  ├── INSERT adapter_escalations row
                                  ├── adapter_status.status = 'escalated'
                                  ├── next_check_at = '2099-01-01'
                                  └── reportIngestionFailure(status='escalated')
adapter never re-fires until escalation closed
```

## Triage (operator-driven, hybrid mode)

Two paths, depending on whether you're at the keyboard:

### Manual (interactive, in your Claude Code session)

```bash
# 1. See what's waiting
npx tsx --env-file=.env.local scripts/investigate-adapter.ts --list

# 2. Pull the dossier for one (markdown form, easy to read)
npx tsx --env-file=.env.local scripts/investigate-adapter.ts \
  --name cf-new-york-sboe-cf --markdown

# 3. (You research with web tools, identify the fix, optionally open a PR.)

# 4. Annotate the escalation row
npx tsx --env-file=.env.local scripts/investigate-adapter.ts \
  --name cf-new-york-sboe-cf \
  --root-cause url_drift \
  --diagnose 'SoS site moved CampaignFinance.html → /campaign-finance' \
  --suggested-fix 'Update URL in src/lib/adapters/state-cf/ny.ts:42'

# 5. Once fix lands, close the escalation and put adapter back in rotation
npx tsx --env-file=.env.local scripts/resolve-adapter.ts \
  --name cf-new-york-sboe-cf \
  --status resolved \
  --pr https://github.com/.../pull/1234
```

### Scheduled (hybrid — research-only, no merge)

Run `triage-escalations.ts` from a cron/routine. It:

1. dumps a markdown brief per open escalation into `tmp/escalation-briefs/`
2. flips each one's `triage_status` to `investigating` so the next run
   doesn't re-dossier it

The Claude Code routine that called this script reads the briefs, researches
each one, calls `investigate-adapter.ts --diagnose ...` to write back its
findings, and optionally opens a draft PR. Operator reviews + merges.

```bash
# In a /schedule routine prompt:
npx tsx --env-file=.env.local scripts/triage-escalations.ts
# → routine reads tmp/escalation-briefs/*.md and acts on them
```

## Teaching the lower runner — `host_playbook`

When a fix generalizes ("elections.ny.gov returns 403 to undici TLS regardless
of headers — applies to every BB call against this host"), capture the lesson
in `host_playbook` so it persists across adapters:

```bash
npx tsx --env-file=.env.local scripts/resolve-adapter.ts \
  --name cf-new-york-sboe-cf \
  --status resolved \
  --pr https://github.com/.../pull/1234 \
  --teach \
  --host elections.ny.gov \
  --pattern undici_403_use_curl \
  --description 'WAF fingerprints undici TLS handshake' \
  --mitigation 'politeFetch curl fallback already handles this. If you see 403 here in a non-politeFetch path, that is a bug.' \
  --applies-to state-cf,candidacies
```

The runner consults `host_playbook` on startup so future adapter calls touching
that host apply the mitigation preemptively. This is the persistence layer for
"the higher LLM teaches the lower."

## Tables

- `adapter_escalations` — one row per failure incident
- `host_playbook` — generalized cross-adapter lessons

Schema: see [migration 20260503000001_adapter_escalations.sql](../../../supabase/migrations/20260503000001_adapter_escalations.sql).

## Triage status values

| triage_status | meaning |
| --- | --- |
| `open` | just enqueued; no triage started |
| `investigating` | a triage agent has claimed it / is working on it |
| `resolved` | fix applied; adapter back in rotation |
| `wontfix` | upstream is permanently dead; adapter stays parked |
| `transient` | network blip / brief outage; no fix needed; back in rotation |

## Why not just add more backoff tiers?

Because exponential backoff on a permanently-broken URL is just "fail forever,
slower." A 24h or 7-day retry on a URL that returns 404 doesn't help anyone —
it hides the bug. The escalation queue surfaces the failure to a triage agent
that can do something about it (URL rotation, parser update, mark dormant).
