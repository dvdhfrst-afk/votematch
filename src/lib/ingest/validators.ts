/**
 * validators.ts -- DETERMINISTIC contact-data validators for the Havesay
 * anti-hallucination extraction gate (Build 6).
 *
 * The premise (founder hard rule, framework 09 Part 2): a fabricated or
 * placeholder contact is the single easiest hallucination for a model to emit,
 * and the cheapest to catch BEFORE it ever reaches a voter. These validators are
 * a deterministic floor that runs in front of (and after) any classifier:
 *
 *   - validateEmail(addr): RFC-syntax check + DNS MX (mail exchange) lookup
 *     (resolver injectable for offline tests) + placeholder/role-address reject
 *     + invalid-top-level-domain reject.
 *   - validatePhone(num): E.164 / NANP (North American Numbering Plan) format
 *     check + an explicit blocklist of the 555-01xx fictional range and other
 *     known placeholders. Format-valid is NECESSARY, NOT SUFFICIENT.
 *   - validateUrl(u): scheme + host syntax + placeholder-host reject.
 *
 * Each returns { valid, reason, normalized }. `reason` is a short machine-stable
 * tag (e.g. 'mx_missing', 'placeholder', 'bad_tld', 'fictional_555') so callers
 * can record WHY a contact failed in provenance, not just that it did.
 *
 * NO new npm dependency. The MX lookup uses Node's built-in node:dns/promises,
 * injected via the `resolver` argument so the offline test mocks it. NANP / E.164
 * is a self-written check (see the parent note in the report: libphonenumber-js
 * would add full international parsing we do not need for a US-only contact gate).
 *
 * Single TypeScript runtime, no Python (architecture rule). No em-dashes /
 * en-dashes; acronyms spelled out on first use.
 */

// ---------------------------------------------------------------------------
// Shared result shape
// ---------------------------------------------------------------------------

export interface ValidationResult {
  /** True only when every stage passed. */
  valid: boolean;
  /**
   * Machine-stable reason tag. 'ok' when valid; otherwise the first failing
   * stage's tag (e.g. 'syntax', 'placeholder', 'bad_tld', 'mx_missing',
   * 'too_short', 'fictional_555', 'not_nanp').
   */
  reason: string;
  /**
   * The normalized form when we could compute one (lowercased email, E.164
   * phone, canonical URL), else null. A normalized value is returned even on
   * SOME failures (e.g. an MX miss still normalizes syntactically) so a caller
   * can log the canonical form it rejected.
   */
  normalized: string | null;
}

function ok(normalized: string): ValidationResult {
  return { valid: true, reason: 'ok', normalized };
}
function bad(reason: string, normalized: string | null = null): ValidationResult {
  return { valid: false, reason, normalized };
}

// ===========================================================================
// EMAIL
// ===========================================================================

/**
 * Conservative RFC 5322-ish local + domain syntax. We deliberately do NOT
 * implement the full grammar (quoted local parts, comments) -- those never
 * appear on a real campaign contact and are a classic injection vector. The
 * local part allows the common subset; the domain is a dot-separated set of
 * LDH (letter-digit-hyphen) labels.
 */
const EMAIL_LOCAL_RE = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const DOMAIN_LABEL_RE = /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)$/;

/**
 * Placeholder DOMAINS a model emits when it is inventing a contact. These are
 * reserved-for-documentation domains (RFC 2606) plus the canonical fakes that
 * show up in scraped templates and form boilerplate.
 */
const PLACEHOLDER_EMAIL_DOMAINS = new Set([
  'example.com',
  'example.org',
  'example.net',
  'example.edu',
  'domain.com',
  'yourdomain.com',
  'yourcompany.com',
  'company.com',
  'email.com',
  'test.com',
  'sample.com',
  'mydomain.com',
  'website.com',
  'localhost',
  'localhost.localdomain',
]);

/**
 * Placeholder LOCAL parts (the bit before @). 'name@...' is the textbook
 * hallucination; 'test@', 'user@', 'youremail@' are scraped-template residue.
 */
const PLACEHOLDER_EMAIL_LOCALS = new Set([
  'name',
  'firstname',
  'lastname',
  'yourname',
  'youremail',
  'your.email',
  'your_email',
  'email',
  'user',
  'username',
  'test',
  'tester',
  'testing',
  'sample',
  'example',
  'demo',
  'placeholder',
  'foo',
  'bar',
  'baz',
  'noreply',
  'no-reply',
  'donotreply',
  'do-not-reply',
]);

/**
 * ROLE addresses (RFC 2142). These are real, deliverable mailboxes, but they are
 * NOT a person's contact: attributing 'info@...' to a candidate as their
 * email is a misattribution, so the gate rejects them as a person-contact value.
 * (A future enhancement could let an org-contact path accept these; the
 * candidate-contact gate does not.)
 */
const ROLE_EMAIL_LOCALS = new Set([
  'info',
  'admin',
  'administrator',
  'support',
  'help',
  'helpdesk',
  'contact',
  'contactus',
  'sales',
  'billing',
  'webmaster',
  'postmaster',
  'hostmaster',
  'abuse',
  'office',
  'mail',
  'mailer',
  'team',
  'hello',
  'inquiries',
  'enquiries',
  'press',
  'media',
  'marketing',
  'hr',
  'jobs',
  'careers',
  'security',
  'privacy',
  'legal',
  'volunteer',
  'volunteers',
  'donate',
  'donations',
]);

/**
 * A small set of clearly-invalid / reserved top-level domains. We do NOT vendor
 * the full IANA TLD list (zero-new-dep + it drifts); we reject the obvious fakes
 * and reserved names (RFC 2606 / RFC 6761) plus a tld that is all-numeric or a
 * single character, which the real DNS root never has. A genuine-but-obscure TLD
 * still passes here and is then proven by the MX lookup, so this stage is a
 * cheap pre-filter, not the authority.
 */
const INVALID_TLDS = new Set([
  'test',
  'example',
  'invalid',
  'localhost',
  'local',
  'lan',
  'internal',
  'corp',
  'home',
  'localdomain',
]);

function tldLooksValid(tld: string): boolean {
  const t = tld.toLowerCase();
  if (t.length < 2) return false; // root TLDs are >= 2 chars
  if (INVALID_TLDS.has(t)) return false;
  if (/^\d+$/.test(t)) return false; // an all-numeric TLD does not exist
  // TLDs are letters (or xn-- punycode for IDNs). Reject anything with other chars.
  if (!/^(xn--[a-z0-9-]+|[a-z]{2,})$/.test(t)) return false;
  return true;
}

/**
 * The injectable MX resolver. The real implementation calls
 * node:dns/promises.resolveMx; the offline test passes a stub. Returns the list
 * of MX records (we only care that the length is > 0). May also be satisfied by
 * an A/AAAA record per RFC 5321 (a domain with an address but no MX still
 * accepts mail), but the gate's default resolver checks MX first and falls back
 * to A, so the *injected* resolver here is MX-only and the fallback lives in the
 * default. For the contact gate, "has an MX or address record" === deliverable.
 */
export type MxResolver = (domain: string) => Promise<Array<{ exchange: string; priority: number }>>;

/**
 * The default resolver: MX first, then a fallback to A/AAAA (a domain that
 * accepts mail via its address record). Lazy-loads node:dns/promises so the pure
 * syntax/placeholder checks never pay for the DNS import and the offline test
 * (which injects its own resolver) never touches the network.
 */
async function defaultMxResolver(domain: string): Promise<Array<{ exchange: string; priority: number }>> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const dns = require('node:dns/promises') as typeof import('node:dns/promises');
  try {
    const mx = await dns.resolveMx(domain);
    if (mx && mx.length > 0) return mx;
  } catch {
    /* fall through to address-record fallback */
  }
  // RFC 5321 6.1: with no MX, the address record (A / AAAA) is an implicit MX.
  try {
    const a = await dns.resolve4(domain);
    if (a && a.length > 0) return [{ exchange: domain, priority: 0 }];
  } catch {
    /* no A record */
  }
  try {
    const aaaa = await dns.resolve6(domain);
    if (aaaa && aaaa.length > 0) return [{ exchange: domain, priority: 0 }];
  } catch {
    /* no AAAA record */
  }
  return [];
}

export interface EmailValidateOptions {
  /** Inject a resolver for tests; defaults to the MX-then-A real resolver. */
  resolver?: MxResolver;
  /**
   * Skip the DNS stage entirely (syntax + placeholder only). Useful for a fast
   * pre-screen before a batched DNS pass. Default false (DNS runs).
   */
  skipDns?: boolean;
}

/**
 * validateEmail(addr, opts):
 *   1. syntax: exactly one '@', valid local part, valid dot-separated domain.
 *   2. placeholder: reject reserved/fake domains, placeholder local parts, and
 *      role addresses (info@, contact@, ...).
 *   3. bad_tld: reject reserved / malformed top-level domains.
 *   4. mx_missing: DNS MX (or A/AAAA fallback) lookup via the injectable
 *      resolver; reject when there is no deliverable mail route.
 *
 * Returns { valid, reason, normalized } where normalized is the lowercased
 * trimmed address (domain always lowercased; local part lowercased too, since
 * campaign addresses are effectively case-insensitive in practice and lowering
 * makes dedup stable).
 */
export async function validateEmail(
  addr: string,
  opts: EmailValidateOptions = {},
): Promise<ValidationResult> {
  if (typeof addr !== 'string') return bad('syntax');
  const trimmed = addr.trim();
  if (!trimmed) return bad('syntax');

  // Exactly one '@'.
  const at = trimmed.indexOf('@');
  if (at < 0 || at !== trimmed.lastIndexOf('@')) return bad('syntax');

  const local = trimmed.slice(0, at);
  const domainRaw = trimmed.slice(at + 1);
  const localLower = local.toLowerCase();
  const domain = domainRaw.toLowerCase();
  const normalized = `${localLower}@${domain}`;

  // (1) syntax
  if (!local || local.length > 64) return bad('syntax');
  if (!EMAIL_LOCAL_RE.test(local)) return bad('syntax');
  if (!domain || domain.length > 255) return bad('syntax');
  if (domain.startsWith('.') || domain.endsWith('.') || domain.includes('..')) return bad('syntax', normalized);
  const labels = domain.split('.');
  if (labels.length < 2) return bad('syntax', normalized); // must be at least name.tld
  for (const label of labels) {
    if (!DOMAIN_LABEL_RE.test(label)) return bad('syntax', normalized);
  }

  // (2) placeholder + role
  if (PLACEHOLDER_EMAIL_DOMAINS.has(domain)) return bad('placeholder', normalized);
  if (PLACEHOLDER_EMAIL_LOCALS.has(localLower)) return bad('placeholder', normalized);
  if (ROLE_EMAIL_LOCALS.has(localLower)) return bad('role_address', normalized);

  // (3) bad_tld
  const tld = labels[labels.length - 1];
  if (!tldLooksValid(tld)) return bad('bad_tld', normalized);

  // (4) mx
  if (opts.skipDns) return ok(normalized);
  const resolver = opts.resolver ?? defaultMxResolver;
  let mx: Array<{ exchange: string; priority: number }>;
  try {
    mx = await resolver(domain);
  } catch {
    return bad('mx_lookup_failed', normalized);
  }
  if (!mx || mx.length === 0) return bad('mx_missing', normalized);

  return ok(normalized);
}

// ===========================================================================
// PHONE
// ===========================================================================

/**
 * The 555-01xx fictional range. NANP reserves 555-0100 through 555-0199 for
 * fictional use (movies, examples, hallucinations). Any number whose subscriber
 * portion is 555 01XX is fake, regardless of area code. We block the whole 0100
 * to 0199 sub-range.
 */
function isFictional555(nationalDigits: string): boolean {
  // nationalDigits is the 10-digit NANP number (NXX-NXX-XXXX without country code).
  if (nationalDigits.length !== 10) return false;
  const exchange = nationalDigits.slice(3, 6); // the central-office code (NXX)
  const subscriber = nationalDigits.slice(6); // the 4-digit line number
  if (exchange === '555') {
    const line = Number(subscriber);
    if (line >= 100 && line <= 199) return true; // 555-0100 .. 555-0199 reserved
  }
  return false;
}

/**
 * Other known placeholder / un-dialable numbers a model or a scraped template
 * emits. Keyed on the 10-digit national number.
 */
const PLACEHOLDER_PHONES = new Set([
  '1234567890',
  '0123456789',
  '1111111111',
  '2222222222',
  '3333333333',
  '4444444444',
  '5555555555',
  '6666666666',
  '7777777777',
  '8888888888',
  '9999999999',
  '0000000000',
  '1231231234',
  '5551234567', // classic fake "555-1234"-style with a 555 exchange
  '5555551234',
  '8005551212', // directory-assistance placeholder
]);

/**
 * validatePhone(num):
 *   1. strip formatting; accept an optional +1 / 1 country code.
 *   2. format: must be a 10-digit NANP number where the area code (N) and the
 *      central-office code (N) both start 2-9 (NANP forbids 0/1 there), and the
 *      central-office code is not N11 (service codes like 411, 911).
 *   3. fictional_555: reject the 555-01xx reserved range.
 *   4. placeholder: reject the explicit blocklist (repeated digits, 123..., etc).
 *
 * FORMAT-VALID IS NECESSARY, NOT SUFFICIENT: a perfectly NANP-shaped number can
 * still be a placeholder, which is exactly why stages 3 and 4 exist after the
 * format check passes. Returns normalized E.164 ('+1XXXXXXXXXX') on success.
 */
export function validatePhone(num: string): ValidationResult {
  if (typeof num !== 'string') return bad('syntax');
  const raw = num.trim();
  if (!raw) return bad('syntax');

  // Reject obvious non-phone junk: letters (other than a leading 'tel:' scheme),
  // then strip everything but digits and a leading '+'.
  const cleaned = raw.replace(/^tel:/i, '').trim();
  // Allow digits, spaces, dashes, parens, dots, and a single leading '+'.
  if (!/^\+?[0-9 ().\-]+$/.test(cleaned)) return bad('syntax');

  let digits = cleaned.replace(/[^0-9]/g, '');

  // Optional country code: a leading '1' (or '+1') is the NANP country code.
  if (digits.length === 11 && digits.startsWith('1')) {
    digits = digits.slice(1);
  } else if (digits.length === 11 && !digits.startsWith('1')) {
    // 11 digits not starting with 1 is not a NANP number.
    return bad('not_nanp');
  }

  if (digits.length < 10) return bad('too_short');
  if (digits.length > 10) return bad('too_long');

  // NANP structure: NXX-NXX-XXXX.
  const area = digits.slice(0, 3); // NPA (area code)
  const office = digits.slice(3, 6); // NXX (central office)
  // First digit of NPA and NXX must be 2-9 (NANP forbids 0 and 1).
  if (!/^[2-9]/.test(area)) return bad('not_nanp');
  if (!/^[2-9]/.test(office)) return bad('not_nanp');
  // N11 office codes (211, 311, 411, 511, 611, 711, 811, 911) are service codes.
  if (/^[2-9]11$/.test(office)) return bad('not_nanp');
  // NANP forbids '9' as the second digit of the area code in some plans; we do
  // not enforce that (too aggressive for a contact gate). The checks above are
  // the structural floor.

  const normalized = `+1${digits}`;

  // (3) fictional 555-01xx
  if (isFictional555(digits)) return bad('fictional_555', normalized);

  // (4) explicit placeholder blocklist
  if (PLACEHOLDER_PHONES.has(digits)) return bad('placeholder', normalized);

  return ok(normalized);
}

// ===========================================================================
// URL
// ===========================================================================

/**
 * Placeholder URL hosts a model emits for a fabricated link.
 */
const PLACEHOLDER_URL_HOSTS = new Set([
  'example.com',
  'www.example.com',
  'example.org',
  'example.net',
  'domain.com',
  'www.domain.com',
  'yourdomain.com',
  'yoursite.com',
  'yourwebsite.com',
  'website.com',
  'mysite.com',
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
]);

/**
 * validateUrl(u):
 *   1. parse with the WHATWG URL parser; must be http(s).
 *   2. host syntax: a valid registrable-ish host (label.tld), or an IP literal.
 *   3. placeholder: reject the fake hosts above.
 *
 * No DNS check here (a campaign URL's liveness is checked elsewhere via the
 * Jina-aware probe; that is a separate concern from "is this a real-looking
 * URL or a hallucinated placeholder"). Returns the normalized href on success.
 */
export function validateUrl(u: string): ValidationResult {
  if (typeof u !== 'string') return bad('syntax');
  const raw = u.trim();
  if (!raw) return bad('syntax');

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return bad('syntax');
  }

  // (1) scheme
  const scheme = parsed.protocol.toLowerCase();
  if (scheme !== 'http:' && scheme !== 'https:') return bad('bad_scheme');

  const host = parsed.hostname.toLowerCase();
  if (!host) return bad('syntax');

  // (3) placeholder host
  if (PLACEHOLDER_URL_HOSTS.has(host)) return bad('placeholder', parsed.toString());

  // (2) host syntax: IP literal OR dot-separated LDH labels with a valid TLD.
  const isIpv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  const isIpv6 = host.includes(':');
  if (!isIpv4 && !isIpv6) {
    const labels = host.split('.');
    if (labels.length < 2) return bad('syntax', parsed.toString());
    for (const label of labels) {
      if (!DOMAIN_LABEL_RE.test(label)) return bad('syntax', parsed.toString());
    }
    const tld = labels[labels.length - 1];
    if (!tldLooksValid(tld)) return bad('bad_tld', parsed.toString());
  }

  return ok(parsed.toString());
}
