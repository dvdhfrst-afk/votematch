/**
 * Digest generation — the retention engine's "product."
 *
 * For a given subscriber, produce a structured list of items (DigestItem union
 * in types/retention.ts), then render to HTML. Personalization is keyed on:
 *   - subscriber.state           → election reminders + state rulemakings
 *   - subscriber.interest_tags   → filter federal_comment_windows + bill topics
 *   - followed federal members   → votes they cast since last digest
 *   - followed ballot measures   → status changes
 */
import { createServiceClient } from '@/lib/supabase/server';
import type {
  Subscriber,
  DigestItem,
  FederalVote,
  FederalVotePosition,
  FederalMember,
  FederalCommentWindow,
  StateRulemakingEvent,
  BallotMeasure,
  MunicipalMeeting,
} from '@/types/retention';

// ---------------------------------------------------------------------------
// Item collection
// ---------------------------------------------------------------------------

export async function collectDigestItems(
  subscriber: Subscriber,
  since?: Date,
): Promise<DigestItem[]> {
  const supabase = await createServiceClient();
  const sinceIso = (since ?? subtractDays(new Date(), 30)).toISOString();
  const items: DigestItem[] = [];

  // 1) Federal votes from followed members
  const { data: follows } = await supabase
    .from('subscriber_follows')
    .select('target_type, target_id')
    .eq('subscriber_id', subscriber.id)
    .is('ended_at', null);

  const followedMembers = (follows ?? [])
    .filter((f: any) => f.target_type === 'federal_member')
    .map((f: any) => f.target_id as string);

  if (followedMembers.length > 0) {
    const { data: positions } = await supabase
      .from('federal_vote_positions')
      .select('vote_id, bioguide_id, position, federal_votes!inner(*), federal_members!inner(*)')
      .in('bioguide_id', followedMembers)
      .gte('federal_votes.vote_date', sinceIso)
      .order('federal_votes.vote_date', { ascending: false })
      .limit(20);

    for (const row of (positions ?? []) as any[]) {
      const vote = row.federal_votes as FederalVote;
      const member = row.federal_members as FederalMember;
      items.push({
        kind: 'federal_vote',
        member_name: member.full_name ?? `${member.first_name ?? ''} ${member.last_name ?? ''}`.trim(),
        bioguide_id: member.bioguide_id,
        position: row.position,
        bill_identifier:
          vote.bill_type && vote.bill_number ? `${vote.bill_type.toUpperCase()} ${vote.bill_number}` : '—',
        bill_title: vote.question ?? vote.description ?? '',
        vote_date: vote.vote_date,
        url: vote.url,
      });
    }
  }

  // 2) Federal comment windows matching interest_tags (deadline within 30 days)
  if (subscriber.interest_tags.length > 0) {
    const horizon = addDays(new Date(), 30).toISOString().slice(0, 10);
    const { data: windows } = await supabase
      .from('federal_comment_windows')
      .select('*')
      .overlaps('topic_tags', subscriber.interest_tags)
      .gte('comment_end_date', new Date().toISOString().slice(0, 10))
      .lte('comment_end_date', horizon)
      .limit(5);

    for (const w of (windows ?? []) as FederalCommentWindow[]) {
      items.push({
        kind: 'comment_window',
        agency: w.agency_name ?? w.agency_id ?? 'Federal agency',
        title: w.title,
        comment_end_date: w.comment_end_date ?? '',
        topic_tags: w.topic_tags,
        url: w.url,
      });
    }
  }

  // 3) State-specific items (only verified)
  const { data: stateRules } = await supabase
    .from('state_rulemaking_events')
    .select('*')
    .eq('state', subscriber.state)
    .eq('verified', true)
    .gte('comment_end_date', new Date().toISOString().slice(0, 10))
    .order('comment_end_date', { ascending: true })
    .limit(3);

  for (const r of (stateRules ?? []) as StateRulemakingEvent[]) {
    items.push({
      kind: 'state_rulemaking',
      state: r.state,
      agency: r.agency ?? '—',
      title: r.title,
      comment_end_date: r.comment_end_date ?? '',
      url: r.source_url,
    });
  }

  const { data: measures } = await supabase
    .from('ballot_measures')
    .select('*')
    .eq('state', subscriber.state)
    .eq('verified', true)
    .gte('updated_at', sinceIso)
    .limit(5);

  for (const m of (measures ?? []) as BallotMeasure[]) {
    items.push({
      kind: 'ballot_measure_update',
      state: m.state,
      title: m.title,
      old_status: m.status,
      new_status: m.status,
      url: m.source_url,
    });
  }

  const { data: meetings } = await supabase
    .from('municipal_meetings')
    .select('*')
    .eq('state', subscriber.state)
    .eq('verified', true)
    .gte('meeting_datetime', new Date().toISOString())
    .lte('meeting_datetime', addDays(new Date(), 14).toISOString())
    .limit(5);

  for (const meet of (meetings ?? []) as MunicipalMeeting[]) {
    items.push({
      kind: 'municipal_meeting',
      jurisdiction: meet.jurisdiction,
      title: meet.title ?? `${meet.jurisdiction_type ?? 'Meeting'}`,
      meeting_datetime: meet.meeting_datetime,
      topic_tags: meet.topic_tags,
      url: meet.source_url,
    });
  }

  return items;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** App origin for in-email links. Matches the retention mailer's default. */
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://ballotbridge.org';

/**
 * Build the standing question-of-the-day/week POINTER block. It links back to
 * the on-device guide, where the question is fetched and answered LOCALLY. The
 * email never contains or requests an opinion (work-order Phase 2B): it is a
 * pointer only. Always present, so every digest carries the re-engagement loop.
 */
export function renderDailyPromptItem(period: string): string {
  const item: Extract<DigestItem, { kind: 'daily_prompt' }> = {
    kind: 'daily_prompt',
    period,
    url: `${APP_URL}/guide?prompt=1`,
  };
  return renderItem(item);
}

export function renderDigestHtml(opts: {
  subscriberId: string;
  state: string;
  items: DigestItem[];
  period: string;
}): { subject: string; html: string } {
  const count = opts.items.length;
  const subject = count === 0
    ? `Your ${opts.period} civic digest — ${opts.state} — quiet period`
    : `Your ${opts.period} civic digest — ${count} update${count === 1 ? '' : 's'} for ${opts.state}`;

  const intro = count === 0
    ? `<p>No federal votes from your followed representatives and no high-priority public-comment windows this period. Your ballot status remains active.</p>`
    : `<p>Here's what moved on the issues you've flagged since your last update. Each item links to the original source.</p>`;

  const itemsHtml = opts.items.map(renderItem).join('\n');

  // Question-of-the-week pointer: a standing re-engagement block that keeps the
  // voter's on-device stance current. Opinion-free; it only links to the guide.
  const promptHtml = renderDailyPromptItem(opts.period);

  return {
    subject,
    html: `
      <h1 style="font-size: 24px; margin-bottom: 16px;">${esc(opts.state)} civic digest</h1>
      ${intro}
      <div style="margin-top: 24px;">${itemsHtml}</div>
      <div style="margin-top: 24px;">${promptHtml}</div>
      <p style="color: #666; font-size: 14px; margin-top: 32px;">
        This digest is generated from official public sources (Congress.gov, Regulations.gov, state government portals). Each item below the federal level is AI-extracted from its public source and linked back for verification. Classifications are algorithmic, not verified facts. See <a href="https://ballotbridge.org/corrections">corrections</a> if you spot an error.
      </p>
    `,
  };
}

function renderItem(item: DigestItem): string {
  switch (item.kind) {
    case 'federal_vote':
      return `
        <div style="padding: 16px; border-left: 3px solid #e5e5e5; margin-bottom: 16px;">
          <div style="font-weight: 600;">${esc(item.member_name)} voted <span style="color: ${voteColor(item.position)};">${esc(item.position)}</span> on ${esc(item.bill_identifier)}</div>
          <div style="color: #555; margin: 6px 0;">${esc(item.bill_title)}</div>
          <div style="font-size: 13px; color: #888;">${esc(new Date(item.vote_date).toLocaleDateString())}${
            item.url ? ` · <a href="${esc(item.url)}" style="color: #888;">source</a>` : ''
          }</div>
        </div>`;

    case 'comment_window':
      return `
        <div style="padding: 16px; border-left: 3px solid #e5e5e5; margin-bottom: 16px;">
          <div style="font-weight: 600;">Comment window open — ${esc(item.agency)}</div>
          <div style="color: #555; margin: 6px 0;">${esc(item.title)}</div>
          <div style="font-size: 13px; color: #888;">Deadline: ${esc(item.comment_end_date)}${
            item.url ? ` · <a href="${esc(item.url)}" style="color: #888;">comment on Regulations.gov</a>` : ''
          }</div>
        </div>`;

    case 'state_rulemaking':
      return `
        <div style="padding: 16px; border-left: 3px solid #e5e5e5; margin-bottom: 16px;">
          <div style="font-weight: 600;">${esc(item.state)} rule — ${esc(item.agency)}</div>
          <div style="color: #555; margin: 6px 0;">${esc(item.title)}</div>
          <div style="font-size: 13px; color: #888;">Deadline: ${esc(item.comment_end_date)} · <a href="${esc(item.url)}" style="color: #888;">source</a></div>
        </div>`;

    case 'ballot_measure_update':
      return `
        <div style="padding: 16px; border-left: 3px solid #e5e5e5; margin-bottom: 16px;">
          <div style="font-weight: 600;">${esc(item.state)} ballot measure update</div>
          <div style="color: #555; margin: 6px 0;">${esc(item.title)}</div>
          <div style="font-size: 13px; color: #888;">Status: ${esc(item.new_status)}${
            item.url ? ` · <a href="${esc(item.url)}" style="color: #888;">source</a>` : ''
          }</div>
        </div>`;

    case 'municipal_meeting':
      return `
        <div style="padding: 16px; border-left: 3px solid #e5e5e5; margin-bottom: 16px;">
          <div style="font-weight: 600;">${esc(item.jurisdiction)}: ${esc(item.title)}</div>
          <div style="font-size: 13px; color: #888;">${esc(new Date(item.meeting_datetime).toLocaleString())} · <a href="${esc(item.url)}" style="color: #888;">agenda</a></div>
        </div>`;

    case 'election_reminder':
      return `
        <div style="padding: 16px; background: #fff8e1; border-radius: 8px; margin-bottom: 16px;">
          <div style="font-weight: 600;">Election in ${item.days_until} days — ${esc(item.election_type)}</div>
          <div style="color: #555; margin: 6px 0;">${esc(item.election_date)} · ${esc(item.state)}</div>
        </div>`;

    case 'ballot_preview':
      return `
        <div style="padding: 16px; background: #e3f2fd; border-radius: 8px; margin-bottom: 16px;">
          <div style="font-weight: 600;">Your ballot preview is ready — ${item.race_count} races</div>
          <div style="color: #555; margin: 6px 0;">Election: ${esc(item.election_date)}</div>
        </div>`;

    case 'daily_prompt':
      // Pointer only. No opinion in or out; the question is answered on-device.
      return `
        <div style="padding: 16px; background: #f3f0ff; border-radius: 8px; margin-bottom: 16px;">
          <div style="font-weight: 600;">Your ${esc(item.period)} question is waiting</div>
          <div style="color: #555; margin: 6px 0;">One tap keeps your ballot match current as the news moves. Your answer is saved only on your device.</div>
          <div style="font-size: 14px;"><a href="${esc(item.url)}" style="color: #4c1d95; font-weight: 600;">Answer today's question</a></div>
        </div>`;
  }
}

function voteColor(pos: string): string {
  if (pos === 'Yea' || pos === 'Aye') return '#2a7a3a';
  if (pos === 'Nay' || pos === 'No') return '#b33a3a';
  return '#888';
}

function esc(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function subtractDays(d: Date, n: number): Date {
  return new Date(d.getTime() - n * 24 * 60 * 60 * 1000);
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 24 * 60 * 60 * 1000);
}
