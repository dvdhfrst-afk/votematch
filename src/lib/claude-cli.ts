/**
 * claude-cli.ts -- the FLAT-RATE Claude path for Havesay.
 *
 * WHY THIS EXISTS
 * ----------------------------------------------------------------------------
 * The architecture (CLAUDE.md: "flat-rate Claude account ... NOT the metered
 * API") always intended the "Claude account" classification/verification pass
 * to run on the operator's subscription, not on a metered per-token Anthropic API key.
 * The metered key in src/lib/claude.ts has a $0 credit balance and returns HTTP
 * 400 "credit balance too low", so the Anthropic Software Development Kit (SDK)
 * path is dead. This module routes those calls through the Claude Code
 * command-line interface (CLI) instead, which authenticates with the flat-rate
 * subscription and never touches API credits.
 *
 * It shells out to the `claude` CLI (expected on PATH as `claude`)
 * via node:child_process.execFile (NOT a shell -- avoids quoting / escaping
 * pitfalls). The prompt is written to the child's stdin so there is no
 * command-line length or escaping limit on the prompt. We ask for a
 * non-interactive print run with a JSON envelope and DISABLE all tools so the
 * call is a pure text/JSON generation that can never block on an interactive
 * permission prompt.
 *
 * IMPORTANT: this calls a SEPARATE `claude` process. That is intended. We do NOT
 * import the Anthropic SDK here. The metered src/lib/claude.ts is left in place
 * for any other importer, but is no longer the path for the gold-set labeler or
 * the strong-band verifier.
 *
 * Single TypeScript runtime, no Python. No new npm dependency (node:child_process
 * is built in). No em-dashes / en-dashes; acronyms spelled out on first use.
 */

import { execFile } from 'node:child_process';

// ===========================================================================
// CLI argv CONFIG -- the ONE place to correct a flag name after running
// `claude --help` on the host.
// ===========================================================================

/**
 * Base argv passed to the `claude` CLI on EVERY call (the per-call --model and
 * the prompt are added in runClaudeRaw). Edit THIS array (and PROMPT_ARG_MODE
 * below) if a flag name drifts in a future CLI version.
 *
 * Intended flags (Claude Code CLI reference, verified present for v2.1.x):
 *   -p / --print               non-interactive "print" mode: run once, print the
 *                              result, exit. (We use the long form --print.)
 *   --output-format json       emit a JSON envelope to stdout. The model's text
 *                              answer is in the envelope's `.result` string.
 *   --permission-mode bypassPermissions
 *                              never prompt for tool/permission approval. Combined
 *                              with no allowed tools below, the run can never block
 *                              on an interactive prompt.
 *   --allowedTools ""          allow NO tools. A pure text/JSON generation call has
 *                              no reason to use a tool; disabling them guarantees
 *                              the model returns text directly and never stalls
 *                              waiting on a tool result. (Some CLI versions spell
 *                              this --allowed-tools; change it here if so.)
 *
 * The --model flag is appended per call (default 'sonnet'); see runClaudeRaw.
 */
export const CLI_BASE_ARGS: readonly string[] = [
  '--print',
  '--output-format',
  'json',
  '--permission-mode',
  'bypassPermissions',
  '--allowedTools',
  '',
];

/**
 * How the prompt itself is delivered to the CLI.
 *   'stdin' -- write the prompt to the child's stdin (DEFAULT). `claude --print`
 *              reads the prompt from stdin when no prompt argv is given. This
 *              avoids ALL command-line length and escaping limits on the prompt.
 *   'argv'  -- pass the prompt as the final positional argv arg. Fallback if a
 *              CLI version ever stops reading the prompt from stdin. execFile is
 *              not a shell, so even an argv prompt is not subject to shell quoting,
 *              but it IS subject to the OS command-line length limit -- hence stdin
 *              is preferred.
 * Flip this in one place if host testing shows stdin is not consumed.
 */
export const PROMPT_ARG_MODE: 'stdin' | 'argv' = 'stdin';

/** The binary name on PATH. (Absolute path also works; PATH is simplest.) */
export const CLI_BIN = process.env.BB_CLAUDE_CLI_BIN ?? 'claude';

/** Default model when opts.model and BB_CLAUDE_CLI_MODEL are both unset. */
const DEFAULT_MODEL = 'sonnet';

// ===========================================================================
// Options + errors
// ===========================================================================

export interface ClaudeCliOptions {
  /** Model alias or id. Default: opts.model -> BB_CLAUDE_CLI_MODEL -> 'sonnet'. */
  model?: string;
  /** Hard timeout for the child process, in milliseconds. Default 120000. */
  timeoutMs?: number;
  /** Override the binary path/name (else BB_CLAUDE_CLI_BIN or 'claude'). */
  bin?: string;
  /** Working directory for the child. Default: process.cwd(). */
  cwd?: string;
  /**
   * INJECTION SEAM (offline test only): replace the actual process spawn with a
   * function that returns a canned CLI stdout string. When set, NO `claude`
   * process is spawned. The production code never sets this.
   */
  _runner?: CliRunner;
}

/**
 * The low-level runner seam: given the full argv (after CLI_BIN) plus the prompt
 * and resolved options, return the CLI's raw stdout string (the JSON envelope).
 * The default implementation spawns `claude`; the offline test injects a fake.
 */
export type CliRunner = (args: {
  bin: string;
  argv: string[];
  prompt: string;
  promptMode: 'stdin' | 'argv';
  timeoutMs: number;
  cwd: string;
}) => Promise<string>;

/**
 * Thrown when the CLI cannot serve the call. `kind` lets callers distinguish a
 * credit/auth failure (which should NOT happen on the subscription path, but we
 * surface it distinctly if the CLI ever falls back to a metered key) from a
 * generic spawn/parse failure. Callers that fail closed (the strong-band gate)
 * treat any ClaudeCliError as "unavailable".
 */
export class ClaudeCliError extends Error {
  readonly kind: 'credit_or_auth' | 'spawn' | 'parse' | 'timeout' | 'nonzero_exit';
  readonly stderr?: string;
  constructor(
    message: string,
    kind: ClaudeCliError['kind'],
    stderr?: string,
  ) {
    super(message);
    this.name = 'ClaudeCliError';
    this.kind = kind;
    this.stderr = stderr;
  }
}

// ===========================================================================
// Default runner: spawn the real `claude` CLI via execFile (no shell)
// ===========================================================================

/**
 * Spawn `claude` with execFile (not exec/spawn-through-a-shell), so the prompt
 * and args are passed as a literal argv vector with no shell interpolation. The
 * prompt is written to stdin (default) so there is no argv length / escaping
 * limit on it. An AbortController enforces opts.timeoutMs.
 *
 * On a non-zero exit, a spawn failure (ENOENT etc.), or a timeout, throws a
 * ClaudeCliError with the captured stderr and a classified `kind`. A
 * credit-balance / authentication error string in stderr is surfaced as
 * kind:'credit_or_auth' so it is not silently lumped with transport errors.
 */
const defaultRunner: CliRunner = ({ bin, argv, prompt, promptMode, timeoutMs, cwd }) =>
  new Promise<string>((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    const finalArgv = promptMode === 'argv' ? [...argv, prompt] : argv;

    const child = execFile(
      bin,
      finalArgv,
      {
        cwd,
        signal: controller.signal,
        maxBuffer: 64 * 1024 * 1024, // 64 MiB: JSON envelopes can be large
        windowsHide: true,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        clearTimeout(timer);
        const errText = (stderr ?? '').toString();

        if (error) {
          // Timeout (aborted) is reported via error.name/code on abort.
          const aborted =
            (error as NodeJS.ErrnoException).code === 'ABORT_ERR' ||
            controller.signal.aborted;
          if (aborted) {
            reject(
              new ClaudeCliError(
                `claude CLI timed out after ${timeoutMs}ms`,
                'timeout',
                errText,
              ),
            );
            return;
          }
          // ENOENT etc.: the binary was not found / could not be spawned.
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'ENOENT') {
            reject(
              new ClaudeCliError(
                `claude CLI binary not found ("${bin}"). Is Claude Code on PATH?`,
                'spawn',
                errText,
              ),
            );
            return;
          }
          // Otherwise a non-zero exit. Detect a credit/auth failure distinctly.
          if (looksLikeCreditOrAuthError(errText) || looksLikeCreditOrAuthError(stdout)) {
            reject(
              new ClaudeCliError(
                'claude CLI reported a credit-balance / authentication error. ' +
                  'The subscription path should not hit this; check `claude` auth on the host.',
                'credit_or_auth',
                errText,
              ),
            );
            return;
          }
          reject(
            new ClaudeCliError(
              `claude CLI exited non-zero: ${error.message}`,
              'nonzero_exit',
              errText,
            ),
          );
          return;
        }

        resolve((stdout ?? '').toString());
      },
    );

    if (promptMode === 'stdin') {
      // Write the prompt to stdin and close it so `claude --print` proceeds.
      try {
        child.stdin?.write(prompt);
        child.stdin?.end();
      } catch {
        // If stdin write fails, the callback above will report the spawn error.
      }
    }
  });

/** Heuristic: does this text look like the metered-key "credit too low" / auth failure? */
function looksLikeCreditOrAuthError(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = text.toLowerCase();
  return (
    t.includes('credit balance is too low') ||
    t.includes('credit balance too low') ||
    t.includes('insufficient credit') ||
    t.includes('invalid api key') ||
    t.includes('authentication_error') ||
    t.includes('unauthorized') ||
    (t.includes('credit') && t.includes('too low'))
  );
}

// ===========================================================================
// Envelope parsing (the PURE logic the offline test exercises)
// ===========================================================================

/**
 * Extract the model's text answer (the `.result` field) from the CLI's
 * --output-format json envelope. Defensive against:
 *   - an envelope whose top level IS the object with `.result` (the documented
 *     shape);
 *   - an envelope that is already a bare string (older / alternate formats);
 *   - an envelope reporting an error (is_error true / subtype) -- we throw a
 *     ClaudeCliError so callers fail closed.
 *
 * Pure: no I/O. Exported so the offline test can feed canned envelopes.
 */
export function extractResultText(stdout: string): string {
  const trimmed = (stdout ?? '').trim();
  if (!trimmed) {
    throw new ClaudeCliError('claude CLI returned empty stdout', 'parse');
  }

  let env: unknown;
  try {
    env = JSON.parse(trimmed);
  } catch {
    // Not JSON at all. If --output-format json was somehow ignored, treat the
    // raw stdout as the result text (best-effort), but only if it is non-empty.
    return trimmed;
  }

  // A bare JSON string envelope.
  if (typeof env === 'string') return env;

  if (env && typeof env === 'object') {
    const obj = env as Record<string, unknown>;

    // Surface an explicit error envelope distinctly.
    if (obj.is_error === true || obj.subtype === 'error_during_execution') {
      const msg =
        (typeof obj.result === 'string' && obj.result) ||
        (typeof obj.error === 'string' && obj.error) ||
        'claude CLI returned an error envelope';
      if (looksLikeCreditOrAuthError(String(msg))) {
        throw new ClaudeCliError(String(msg), 'credit_or_auth');
      }
      throw new ClaudeCliError(String(msg), 'nonzero_exit');
    }

    if (typeof obj.result === 'string') return obj.result;

    // Some shapes nest the text under message/content; best-effort fallbacks.
    if (typeof obj.text === 'string') return obj.text;
    if (typeof obj.content === 'string') return obj.content;
  }

  throw new ClaudeCliError(
    'claude CLI JSON envelope had no .result text field',
    'parse',
  );
}

/**
 * From a model TEXT answer (the .result string), extract the JSON payload the
 * model produced. Handles:
 *   1. clean JSON (object or array) that is the whole string;
 *   2. JSON wrapped in a ```json ... ``` (or bare ```) code fence;
 *   3. leading prose then a JSON array/object substring (takes the first complete
 *      bracketed region: the outermost [...] or {...}).
 * Returns the parsed value (caller validates with Zod). Throws ClaudeCliError if
 * no parseable JSON can be recovered.
 *
 * Pure: no I/O. Exported for the offline test.
 */
export function extractJsonPayload(resultText: string): unknown {
  const raw = (resultText ?? '').trim();
  if (!raw) {
    throw new ClaudeCliError('empty result text; no JSON to parse', 'parse');
  }

  // 1. Strip a surrounding markdown code fence if present.
  const fenceStripped = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  // 2. Try a direct parse of the (fence-stripped) text.
  const direct = tryParse(fenceStripped);
  if (direct.ok) return direct.value;

  // 3. Fall back to the first complete JSON array or object substring. Pick
  //    whichever bracket type appears first; scan to its matching close.
  const sub = firstJsonSubstring(fenceStripped);
  if (sub != null) {
    const parsed = tryParse(sub);
    if (parsed.ok) return parsed.value;
  }

  throw new ClaudeCliError(
    'could not parse JSON from claude CLI result text',
    'parse',
  );
}

function tryParse(s: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch {
    return { ok: false };
  }
}

/**
 * Return the first complete top-level JSON array or object substring in `text`,
 * or null. Scans for the first '[' or '{', then walks forward tracking bracket
 * depth (string-aware, so brackets inside JSON strings do not affect depth) to
 * the matching close.
 */
function firstJsonSubstring(text: string): string | null {
  let start = -1;
  let open = '';
  let close = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '[' || c === '{') {
      start = i;
      open = c;
      close = c === '[' ? ']' : '}';
      break;
    }
  }
  if (start === -1) return null;

  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (escaped) {
        escaped = false;
      } else if (c === '\\') {
        escaped = true;
      } else if (c === '"') {
        inStr = false;
      }
      continue;
    }
    if (c === '"') {
      inStr = true;
    } else if (c === open) {
      depth++;
    } else if (c === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// ===========================================================================
// Public entry points
// ===========================================================================

/**
 * Resolve the argv (CLI_BASE_ARGS + --model) and invoke the runner. Internal.
 */
async function runClaudeRaw(prompt: string, opts: ClaudeCliOptions = {}): Promise<string> {
  const model = opts.model ?? process.env.BB_CLAUDE_CLI_MODEL ?? DEFAULT_MODEL;
  const bin = opts.bin ?? CLI_BIN;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const cwd = opts.cwd ?? process.cwd();
  const runner = opts._runner ?? defaultRunner;

  const argv = [...CLI_BASE_ARGS, '--model', model];

  return runner({ bin, argv, prompt, promptMode: PROMPT_ARG_MODE, timeoutMs, cwd });
}

/**
 * runClaudeText(prompt, opts?): run the `claude` CLI on the subscription and
 * return the model's TEXT answer (the envelope's `.result` string). Throws
 * ClaudeCliError on spawn / timeout / non-zero exit / unparseable envelope.
 */
export async function runClaudeText(prompt: string, opts: ClaudeCliOptions = {}): Promise<string> {
  const stdout = await runClaudeRaw(prompt, opts);
  return extractResultText(stdout);
}

/**
 * runClaudeJson<T>(prompt, opts?): run the `claude` CLI on the subscription and
 * return the JSON payload the model produced inside its text answer. Extracts
 * `.result` from the envelope, then recovers the JSON (handling code fences and
 * leading prose). The caller is expected to validate the shape (e.g. with Zod);
 * the generic <T> is a convenience cast, not a runtime guarantee.
 *
 * Throws ClaudeCliError on any failure (spawn, timeout, non-zero exit, or
 * unparseable envelope / JSON), so callers can fail closed.
 */
export async function runClaudeJson<T = unknown>(
  prompt: string,
  opts: ClaudeCliOptions = {},
): Promise<T> {
  const text = await runClaudeText(prompt, opts);
  return extractJsonPayload(text) as T;
}
