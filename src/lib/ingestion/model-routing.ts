/**
 * Per-work-kind model routing for the body-research + SOS ingestion pipelines.
 *
 * Replaces the hard-coded `--model sonnet` / `--model opus` choices in
 * scripts/research-body.ts and scripts/overnight-ingest.ts. Centralizing the
 * mapping means we can tune cost/quality per work-kind without touching the
 * caller code, and we can override per-work-kind via env for experiments.
 *
 * # Three backends
 *
 *   - **ollama** (local, $0/call, ~3s/call once warm) — for classification +
 *     structured extraction. User's stable: phi3:3.8b, granite4:7b-a1b-h,
 *     phi4:14b, qwen3:14b, gemma4:e4b, gpt-oss:20b, mistral-small:24b,
 *     gemma2:27b, qwen2.5:32b, llama3.3:70b.
 *   - **claude_cli** (plan-auth Max plan, $0 cash but consumes 5h-window quota)
 *     — for multi-turn tool use (smart_fetch, WebFetch, Read/Write). The only
 *     path that supports iterative MCP tool calls today.
 *   - **claude_api** (real API billing, currently dormant — operator has no
 *     API credits) — for emergency fallback only.
 *
 * # Why
 *
 * Per notes/unified-ingestion-plan.md rev 2 (operator decision 2026-05-27)
 * and rev 3 (2026-05-27 ollama integration):
 *   - Local ollama (phi4 / gpt-oss / llama3.3) for triage + classification +
 *     structured extraction. Replaces Haiku where multi-turn isn't needed.
 *   - Claude CLI Sonnet for body verification synthesis (still needs multi-turn
 *     MCP tool use; ollama can't drive smart_fetch iteratively).
 *   - Claude CLI Opus for council strategic analysis. Only fires on NOVEL
 *     problem signatures (after ollama triage classifies KNOWN_PATTERN cheaply).
 *
 * Expected impact:
 *   - Council triage: was Claude CLI Haiku (~$0.002, ~3s plan-auth), now ollama
 *     phi4 ($0, ~3s local). Same speed; zero plan-auth consumption.
 *   - Source classification subtasks: was inline Claude Sonnet token spend;
 *     now extractable as discrete ollama calls.
 *   - Future experiment: route body_verification through ollama llama3.3:70b
 *     when sources are pre-fetched cleanly. Could eliminate 80% of plan-auth
 *     burn on the body-research path.
 *
 * # Plan-auth context
 *
 * The user's Max plan covers all Claude CLI tiers. There's no API key in
 * the hot path — `ANTHROPIC_API_KEY` is stripped from the CLI's env before
 * spawn. The Max plan's usage windows (5h cap) apply uniformly; routing
 * decisions to ollama free up that quota entirely for the high-value
 * Claude work.
 *
 * # CLI shorthand
 *
 * The Claude Code CLI accepts shorthand: `--model haiku|sonnet|opus`. We
 * use the shorthand so the routing isn't tied to a specific model version
 * string (which would force code edits each time Anthropic ships a new
 * model). The CLI resolves shorthand to the latest available version of
 * each family at invocation time.
 *
 * # Env overrides
 *
 * `BB_MODEL_<WORK_KIND>=haiku|sonnet|opus` — override the default for a
 * single work kind. Example:
 *
 *   BB_MODEL_BODY_VERIFICATION=haiku  # downgrade body research for cost testing
 *   BB_MODEL_COUNCIL_TRIAGE=sonnet    # upgrade triage if Haiku judgments get
 *                                       too many false-novels
 *
 * `BB_MODEL_DEFAULT=haiku|sonnet|opus` — override everything (sledgehammer
 * for cost-cap-day experiments).
 *
 * # Effort levels
 *
 * The CLI's `--effort low|medium|high` controls adaptive thinking depth.
 * Each work-kind also gets a default effort level; effort is part of the
 * routing decision (cheaper effort on the cheap model still costs less
 * than expensive effort on a cheap model).
 */

export type WorkKind =
  /** Per-body structural verification via the research-body.ts worker.
   *  Synthesis from 3-5 sources, judgment-heavy. Default: sonnet/low. */
  | 'body_verification'
  /** Per-standalone-office verification via the research-office.ts worker.
   *  Most office types are statute-boilerplate (cheap), a minority are
   *  ambiguous. Default: sonnet/low today; Phase 3 routes the easy majority to
   *  haiku behind the eval gate (see spend-efficiency upgrade plan #2). */
  | 'office_verification'
  /** Quick "is this a known problem pattern or novel?" call before the
   *  expensive Opus council. Pattern recognition. Default: haiku/low. */
  | 'council_triage'
  /** Deep council analysis of a problem flagged novel by triage.
   *  Highest stakes, rarest invocation. Default: opus/medium. */
  | 'council_strategic'
  /** Structured extraction from a clean primary source — e.g. count
   *  distinct seat IDs in a roster, parse a single field. Deterministic
   *  enough for the cheap model. Default: haiku/low. */
  | 'structured_extraction'
  /** Per-URL source-tier classification (primary vs corroborating vs
   *  excluded). Stable rubric, pattern recognition. Default: haiku/low. */
  | 'source_classification'
  /** First-pass policy positions extraction (Stage 6). Judgment work on
   *  candidate-supplied text. Default: sonnet/medium. */
  | 'positions_extraction_first_pass'
  /** Bulk policy positions extraction from solid-corpus examples (once
   *  enough first-pass examples accumulate to train the cheaper path).
   *  Default: haiku/low. */
  | 'positions_extraction_bulk';

export type Backend = 'ollama' | 'claude_cli' | 'claude_api';
export type ClaudeShorthand = 'haiku' | 'sonnet' | 'opus';
export type EffortLevel = 'low' | 'medium' | 'high';

/** Known ollama model ids on the operator's machine (verified 2026-05-27).
 *  Update when the local stable changes. Drives env validation. */
export type OllamaModel =
  | 'phi3:3.8b'
  | 'granite4:7b-a1b-h'
  | 'phi4:14b'
  | 'qwen3:14b'
  | 'gemma4:e4b'
  | 'gpt-oss:20b'
  | 'mistral-small:24b'
  | 'gemma2:27b'
  | 'qwen2.5:32b'
  | 'llama3.3:70b';

export interface ModelDecision {
  /** Which backend to invoke. */
  backend: Backend;
  /** Model id. For claude_cli: shorthand ('haiku'|'sonnet'|'opus'). For
   *  ollama: full id like 'phi4:14b'. For claude_api: full versioned id. */
  model: string;
  /** Claude CLI --effort. Ignored by ollama (use --think instead). */
  effort?: EffortLevel;
  /** ollama only: whether to use the chain-of-thought "thinking" mode (qwen3,
   *  deepseek-r1). Ignored on non-thinking models. Defaults to false (faster). */
  think?: boolean;
  /** Where this decision came from, for logging. */
  source: 'env_override' | 'env_default_override' | 'default';
  /** The work-kind that produced this decision. */
  workKind: WorkKind;
}

interface DefaultRoute {
  backend: Backend;
  model: string;
  effort?: EffortLevel;
  think?: boolean;
}

/**
 * Default mapping. Source of truth — env overrides take precedence but
 * the defaults are what the pipeline ships with.
 *
 * Routing rubric:
 *   - body_verification: needs multi-turn MCP tool use → claude_cli/sonnet
 *   - council_triage: simple classification → ollama/phi4 ($0, no plan-auth)
 *   - council_strategic: rare deep analysis → claude_cli/opus
 *   - structured_extraction: deterministic → ollama/granite4 (small fast)
 *   - source_classification: stable rubric → ollama/phi3 (tiny fast)
 *   - positions_extraction_first_pass: judgment → claude_cli/sonnet (TODO:
 *     swap to ollama/llama3.3:70b once we've A/B'd quality)
 *   - positions_extraction_bulk: scaled from solid corpus → ollama/phi4
 *
 * Note: positions extraction TODAY goes through src/lib/llm-router.ts which
 * already routes to ollama for attributed_position risk class. This map is
 * for the body-research engine's NEW callsites + future positions integrations.
 */
const DEFAULT_ROUTING: Record<WorkKind, DefaultRoute> = {
  body_verification: { backend: 'claude_cli', model: 'sonnet', effort: 'low' },
  office_verification: { backend: 'claude_cli', model: 'sonnet', effort: 'low' },
  council_triage: { backend: 'ollama', model: 'phi4:14b', think: false },
  council_strategic: { backend: 'claude_cli', model: 'opus', effort: 'medium' },
  structured_extraction: { backend: 'ollama', model: 'granite4:7b-a1b-h', think: false },
  source_classification: { backend: 'ollama', model: 'phi3:3.8b', think: false },
  positions_extraction_first_pass: { backend: 'claude_cli', model: 'sonnet', effort: 'medium' },
  positions_extraction_bulk: { backend: 'ollama', model: 'phi4:14b', think: false },
};

const ENV_OVERRIDE_KEY: Record<WorkKind, string> = {
  body_verification: 'BB_MODEL_BODY_VERIFICATION',
  office_verification: 'BB_MODEL_OFFICE_VERIFICATION',
  council_triage: 'BB_MODEL_COUNCIL_TRIAGE',
  council_strategic: 'BB_MODEL_COUNCIL_STRATEGIC',
  structured_extraction: 'BB_MODEL_STRUCTURED_EXTRACTION',
  source_classification: 'BB_MODEL_SOURCE_CLASSIFICATION',
  positions_extraction_first_pass: 'BB_MODEL_POSITIONS_EXTRACTION_FIRST_PASS',
  positions_extraction_bulk: 'BB_MODEL_POSITIONS_EXTRACTION_BULK',
};

const ENV_EFFORT_KEY: Record<WorkKind, string> = {
  body_verification: 'BB_EFFORT_BODY_VERIFICATION',
  office_verification: 'BB_EFFORT_OFFICE_VERIFICATION',
  council_triage: 'BB_EFFORT_COUNCIL_TRIAGE',
  council_strategic: 'BB_EFFORT_COUNCIL_STRATEGIC',
  structured_extraction: 'BB_EFFORT_STRUCTURED_EXTRACTION',
  source_classification: 'BB_EFFORT_SOURCE_CLASSIFICATION',
  positions_extraction_first_pass: 'BB_EFFORT_POSITIONS_EXTRACTION_FIRST_PASS',
  positions_extraction_bulk: 'BB_EFFORT_POSITIONS_EXTRACTION_BULK',
};

/** Parse an env override into a backend+model pair. Supported formats:
 *    "claude:haiku"       claude_cli with haiku
 *    "claude:sonnet"      claude_cli with sonnet
 *    "claude:opus"        claude_cli with opus
 *    "ollama:phi4:14b"    ollama with phi4:14b (note the ollama model id keeps its colon)
 *    "ollama:llama3.3:70b"
 *    Bare shorthand ("haiku","sonnet","opus") = backwards-compat: claude_cli/<shorthand>
 */
function parseRouteOverride(raw: string | undefined): { backend: Backend; model: string } | null {
  if (!raw) return null;
  const v = raw.trim();
  if (!v) return null;
  // Backwards-compat: bare shorthand → claude_cli
  if (v === 'haiku' || v === 'sonnet' || v === 'opus') {
    return { backend: 'claude_cli', model: v };
  }
  if (v.startsWith('ollama:')) {
    const model = v.slice('ollama:'.length);
    if (!model) return null;
    return { backend: 'ollama', model };
  }
  if (v.startsWith('claude:')) {
    const model = v.slice('claude:'.length);
    if (!model) return null;
    return { backend: 'claude_cli', model };
  }
  if (v.startsWith('claude_api:')) {
    const model = v.slice('claude_api:'.length);
    if (!model) return null;
    return { backend: 'claude_api', model };
  }
  return null;
}

function parseEffort(raw: string | undefined): EffortLevel | null {
  if (!raw) return null;
  const v = raw.toLowerCase().trim();
  if (v === 'low' || v === 'medium' || v === 'high') return v;
  return null;
}

/**
 * Resolve the backend, model + effort for a given work-kind. Pure function:
 * reads env at call time so tests can mutate env between calls.
 *
 * Precedence:
 *   1. BB_MODEL_DEFAULT (env, sledgehammer) — overrides everything if set
 *   2. BB_MODEL_<WORK_KIND> (env, per-kind override)
 *   3. DEFAULT_ROUTING[workKind] (the shipped default)
 *
 * Env values can specify backend explicitly via prefix: "ollama:phi4:14b",
 * "claude:sonnet", "claude_api:claude-sonnet-4-6". Bare shorthand
 * ("haiku"|"sonnet"|"opus") defaults to claude_cli backend.
 *
 * Effort follows the same pattern with BB_EFFORT_DEFAULT and
 * BB_EFFORT_<WORK_KIND>. Effort is only honored for claude_cli backend.
 */
export function routeModel(workKind: WorkKind): ModelDecision {
  const defaultOverride = parseRouteOverride(process.env.BB_MODEL_DEFAULT);
  const perKindOverride = parseRouteOverride(process.env[ENV_OVERRIDE_KEY[workKind]]);
  const defaultRoute = DEFAULT_ROUTING[workKind];

  let backend: Backend;
  let model: string;
  let source: ModelDecision['source'];
  if (defaultOverride) {
    backend = defaultOverride.backend;
    model = defaultOverride.model;
    source = 'env_default_override';
  } else if (perKindOverride) {
    backend = perKindOverride.backend;
    model = perKindOverride.model;
    source = 'env_override';
  } else {
    backend = defaultRoute.backend;
    model = defaultRoute.model;
    source = 'default';
  }

  const defaultEffortOverride = parseEffort(process.env.BB_EFFORT_DEFAULT);
  const perKindEffortOverride = parseEffort(process.env[ENV_EFFORT_KEY[workKind]]);
  const effort: EffortLevel | undefined =
    defaultEffortOverride ?? perKindEffortOverride ?? defaultRoute.effort;

  return {
    backend,
    model,
    effort: backend === 'claude_cli' ? effort : undefined,
    think: backend === 'ollama' ? defaultRoute.think ?? false : undefined,
    source,
    workKind,
  };
}

/**
 * Convenience: stringify the decision for logging.
 *   "[route] body_verification → claude_cli/sonnet/low (default)"
 *   "[route] council_triage → ollama/phi4:14b (default)"
 */
export function formatDecision(d: ModelDecision): string {
  const src = d.source === 'default' ? 'default' : `env:${d.source}`;
  const tail = d.backend === 'claude_cli' ? `/${d.effort}` : '';
  return `[route] ${d.workKind} → ${d.backend}/${d.model}${tail} (${src})`;
}

/**
 * Return the Claude CLI args needed for this decision. Throws if the
 * decision is not for the claude_cli backend (caller should check
 * `decision.backend === 'claude_cli'` first OR use the higher-level
 * dispatch helper in `runWithRouting`).
 */
export function routeModelCliArgs(workKind: WorkKind): { args: string[]; decision: ModelDecision } {
  const decision = routeModel(workKind);
  if (decision.backend !== 'claude_cli') {
    throw new Error(
      `routeModelCliArgs called for ${workKind} but backend resolved to ` +
      `${decision.backend} (model=${decision.model}). Caller should check ` +
      `decision.backend before calling, or use runWithRouting() which handles ` +
      `multi-backend dispatch.`,
    );
  }
  const args = ['--model', decision.model];
  if (decision.effort) args.push('--effort', decision.effort);
  return { args, decision };
}
