/**
 * Offline unit tests for harvest-targeting.ts (2026-07-02 harvest fix).
 *
 * Covers the pure targeting functions with NO network, NO database, NO model:
 *   - detectAuthWall: login-wall / CAPTCHA / "content unavailable" detection,
 *     modeled on real raw_evidence signatures (fictional names), INCLUDING the
 *     crucial guard that a real X profile (login chrome + substantial bio/posts)
 *     is NOT flagged.
 *   - extractNavPolicyLinks: same-site policy nav-link parsing (markdown + HTML),
 *     chrome/asset rejection.
 *   - policySubpathCandidates / isPolicyNavLink / isPolicySubpageUrl.
 *   - prioritizeSources: candidate_site policy-subpage > site other > news > social.
 *
 * Vitest (the project's runner).
 */
import { describe, it, expect } from 'vitest';
import {
  detectAuthWall,
  isAuthGatedSocialDomain,
  stripJinaPreamble,
  extractNavPolicyLinks,
  policySubpathCandidates,
  isPolicyNavLink,
  isPolicySubpageUrl,
  normalizePath,
  harvestPriorityOf,
  prioritizeSources,
  HARVEST_PRIORITY,
  POLICY_SUBPATHS,
} from '../harvest-targeting';

// ---------------------------------------------------------------------------
// Signatures modeled on real platform wall pages; names and handles are fictional.
// ---------------------------------------------------------------------------

const FB_UNAVAILABLE =
  "Title: Facebook URL Source: https://www.facebook.com/TestwoodForEX Warning: This page maybe requiring CAPTCHA, please make sure you are authorized to access this page. Markdown Content: ## This content isn't available right now When this happens, it's usually because the owner only shared it with a small group of people, changed who can see it or it's been deleted.";

const FB_LOGIN =
  "Title: Facebook URL Source: https://www.facebook.com/placeholder4springfield Markdown Content: # Facebook Explore the things you love. Log into Facebook Email or mobile number Password - [x] Log in [Forgot password?](https://www.facebook.com/recover/initiate/?privacy_mutation_token=<tok>&ars=facebook_login) [Create new account](https://www.facebook.com/reg/) Sign Up Log In Messenger";

const X_LOGIN_STUB =
  'Title: Avery (@Avery4ex) on X URL Source: https://x.com/avery4ex Markdown Content: [](https://x.com/) [Log in](https://x.com/i/jf/onboarding/web?mode=login)[Sign up](https://x.com/i/jf/onboarding/web?mode=signup) Avery 0 posts';

// A REAL X profile: same login chrome, but a substantial bio + post prose below.
// This must NOT be flagged as an auth wall (it carries positioning-relevant text).
const X_REAL_PROFILE =
  'Title: Robin Testperson (@robintestperson) on X URL Source: https://x.com/robintestperson Markdown Content: # Robin Testperson (@robintestperson) / X [Log in](https://x.com/i/jf/onboarding/web?mode=login)[Sign up](https://x.com/i/jf/onboarding/web?mode=signup) Robin Testperson 1,785 posts Robin Testperson @robintestperson Veteran | Conservative | Next EX Attorney General Fighting for EX future Pro-America. Pro-Family. Pro-Freedom. Join the movement Sampleton, EX Joined February 2009 Pinned As ballots arrive in mailboxes and Republicans select our nominee to defeat the incumbent, I ask you to consider one question about border security and public safety in our state.';

const IG_CAPTCHA_EMPTY =
  'Title: Jordan Sample (@jordanforex) • Instagram photos and videos URL Source: https://www.instagram.com/jordanforex Warning: This page maybe requiring CAPTCHA, please make sure you are authorized to access this page. Markdown Content:';

// Instagram "profile unavailable" wall -- carries a CAPTCHA warning AND ~250
// chars of stub prose (over the thin-body floor), so it is only caught by the
// dedicated unavailable signatures, not the thin-body captcha path. Modeled
// on the row shape the first detector draft missed.
const IG_PROFILE_UNAVAILABLE =
  "Title: Profile isn't available • Instagram URL Source: https://www.instagram.com/sampleforex Warning: This page maybe requiring CAPTCHA, please make sure you are authorized to access this page. Markdown Content: [](https://www.instagram.com/accounts/emailsignup/) [Log in](https://www.instagram.com/accounts/login/?next=%2F&source=mobile_nav) Profile isn't available The link may be broken, or the profile may have been removed. Sign up for Instagram";

// LinkedIn anti-bot block: Jina returns "error 999" with an empty body.
const LINKEDIN_999 =
  'Title: URL Source: https://www.linkedin.com/in/examplecandidate Warning: Target URL returned error 999 Warning: This page maybe not yet fully loaded, consider explicitly specify a timeout. Markdown Content:';

// A genuine candidate campaign-site body (never an auth wall).
const REAL_SITE_BODY =
  '# Issues & Platform Where Jordan stands. And why. Real positions, no corporate money behind them. Strong Public Education is his top priority. He supports fully funding neighborhood schools.';

// ---------------------------------------------------------------------------
// isAuthGatedSocialDomain
// ---------------------------------------------------------------------------

describe('isAuthGatedSocialDomain', () => {
  it('matches known auth-gated social platforms and their subdomains', () => {
    expect(isAuthGatedSocialDomain('facebook.com')).toBe(true);
    expect(isAuthGatedSocialDomain('www.facebook.com')).toBe(true);
    expect(isAuthGatedSocialDomain('x.com')).toBe(true);
    expect(isAuthGatedSocialDomain('m.instagram.com')).toBe(true);
    expect(isAuthGatedSocialDomain('linkedin.com')).toBe(true);
  });
  it('does not match a candidate campaign site', () => {
    expect(isAuthGatedSocialDomain('jordanforex.com')).toBe(false);
    expect(isAuthGatedSocialDomain('rileyforex.com')).toBe(false);
    expect(isAuthGatedSocialDomain(null)).toBe(false);
    expect(isAuthGatedSocialDomain(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// stripJinaPreamble
// ---------------------------------------------------------------------------

describe('stripJinaPreamble', () => {
  it('returns only the body after "Markdown Content:"', () => {
    expect(stripJinaPreamble(IG_CAPTCHA_EMPTY)).toBe('');
    expect(stripJinaPreamble(REAL_SITE_BODY)).toContain('Where Jordan stands');
  });
  it('is total on empty / preamble-less input', () => {
    expect(stripJinaPreamble('')).toBe('');
    expect(stripJinaPreamble('plain text no preamble')).toBe('plain text no preamble');
  });
});

// ---------------------------------------------------------------------------
// detectAuthWall -- the core signal
// ---------------------------------------------------------------------------

describe('detectAuthWall', () => {
  it('flags a Facebook "content unavailable" wall', () => {
    const v = detectAuthWall(FB_UNAVAILABLE, { domain: 'facebook.com' });
    expect(v.isAuthWall).toBe(true);
    expect(v.reason).toBe('fb_unavailable');
  });

  it('flags a Facebook login wall', () => {
    const v = detectAuthWall(FB_LOGIN, { domain: 'facebook.com' });
    expect(v.isAuthWall).toBe(true);
    expect(v.reason).toBe('fb_login');
  });

  it('flags a thin X login stub (0 posts, no body)', () => {
    const v = detectAuthWall(X_LOGIN_STUB, { domain: 'x.com' });
    expect(v.isAuthWall).toBe(true);
    expect(v.reason).toBe('x_login_stub');
  });

  it('DOES NOT flag a real X profile that carries bio + posts below the login chrome', () => {
    // This is the guard that protects ~90% of the X rows (real content) from
    // being discarded just because the login chrome is present.
    const v = detectAuthWall(X_REAL_PROFILE, { domain: 'x.com' });
    expect(v.isAuthWall).toBe(false);
    expect(v.reason).toBe('ok');
  });

  it('flags an Instagram CAPTCHA stub with empty body', () => {
    const v = detectAuthWall(IG_CAPTCHA_EMPTY, { domain: 'instagram.com' });
    expect(v.isAuthWall).toBe(true);
    expect(v.reason).toBe('captcha_stub');
  });

  it('flags an Instagram "profile unavailable" wall even when the stub body exceeds the thin floor', () => {
    // The row the first draft missed: CAPTCHA warning + ~250 chars of stub prose.
    const v = detectAuthWall(IG_PROFILE_UNAVAILABLE, { domain: 'instagram.com' });
    expect(v.isAuthWall).toBe(true);
    expect(v.reason).toBe('ig_unavailable');
  });

  it('flags a LinkedIn error-999 anti-bot block', () => {
    const v = detectAuthWall(LINKEDIN_999, { domain: 'linkedin.com' });
    expect(v.isAuthWall).toBe(true);
    expect(v.reason).toBe('linkedin_blocked');
  });

  it('never flags a non-social domain, even if it contains "Log In" text', () => {
    const withLoginWord =
      'Members Log In / Sign up to volunteer. ' + REAL_SITE_BODY;
    const v = detectAuthWall(withLoginWord, { domain: 'jordanforex.com' });
    expect(v.isAuthWall).toBe(false);
    expect(v.reason).toBe('not_social');
  });

  it('does not flag a genuine social post with substantial body', () => {
    const realPost =
      'Title: X URL Source: https://x.com/foo Markdown Content: ' +
      'Today I announced my full plan to fund public schools, expand pre-K, and '.repeat(
        6,
      );
    const v = detectAuthWall(realPost, { domain: 'x.com' });
    expect(v.isAuthWall).toBe(false);
  });

  it('is total on empty / null input', () => {
    expect(detectAuthWall('', { domain: 'facebook.com' }).isAuthWall).toBe(false);
    expect(detectAuthWall(null).isAuthWall).toBe(false);
    expect(detectAuthWall(undefined).isAuthWall).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isPolicyNavLink
// ---------------------------------------------------------------------------

describe('isPolicyNavLink', () => {
  it('accepts policy anchors by text or path', () => {
    expect(isPolicyNavLink('Issues', '/issues')).toBe(true);
    expect(isPolicyNavLink("Riley's Priorities", '/rileys-priorities')).toBe(true);
    expect(isPolicyNavLink('About Jordan', '/about-jordan')).toBe(true);
    expect(isPolicyNavLink('', '/platform')).toBe(true);
    expect(isPolicyNavLink('My Plan', '/plan')).toBe(true);
    expect(isPolicyNavLink('Meet Casey', '/meet-casey')).toBe(true);
  });
  it('rejects chrome links even if a path token weakly matches', () => {
    expect(isPolicyNavLink('Donate', '/donate')).toBe(false);
    expect(isPolicyNavLink('Volunteer', '/volunteer')).toBe(false);
    expect(isPolicyNavLink('Events', '/events')).toBe(false);
    expect(isPolicyNavLink('Contact', '/contact')).toBe(false);
    expect(isPolicyNavLink('Store', '/store')).toBe(false);
  });
  it('rejects a plain link with no policy token', () => {
    expect(isPolicyNavLink('Home', '/')).toBe(false);
    expect(isPolicyNavLink('Gallery', '/gallery')).toBe(false);
  });

  it('rejects legal/site chrome that superficially matches the "polic" token', () => {
    // privacy-policy / terms / cookie pages are NOT candidate positions even
    // though they contain "polic" / "terms". Reject by text OR by path.
    expect(isPolicyNavLink('Privacy Policy', '/privacy-policy')).toBe(false);
    expect(isPolicyNavLink('', '/privacy-policy-3-1')).toBe(false);
    expect(isPolicyNavLink('Terms of Service', '/terms')).toBe(false);
    expect(isPolicyNavLink('Cookie Policy', '/cookie-policy')).toBe(false);
    // ... but a real policy page still passes.
    expect(isPolicyNavLink('Policy', '/policy')).toBe(true);
    expect(isPolicyNavLink('Issues', '/issues')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// extractNavPolicyLinks
// ---------------------------------------------------------------------------

describe('extractNavPolicyLinks', () => {
  it('extracts Squarespace-style custom policy paths from markdown nav (a Squarespace-style campaign site)', () => {
    const md =
      '# Riley For EX ' +
      '[About Riley](https://www.rileyforex.com/about-riley) ' +
      "[Riley's Priorities](https://www.rileyforex.com/rileys-priorities) " +
      '[Endorsements](https://www.rileyforex.com/endorsements) ' +
      '[Donate](https://www.rileyforex.com/donate) ' +
      '![logo](https://images.squarespace-cdn.com/x/1.png)';
    const links = extractNavPolicyLinks(md, 'https://www.rileyforex.com/');
    expect(links).toContain('https://www.rileyforex.com/about-riley');
    expect(links).toContain('https://www.rileyforex.com/rileys-priorities');
    // chrome (donate, endorsements) and the image asset must be excluded.
    expect(links).not.toContain('https://www.rileyforex.com/donate');
    expect(links.some((u) => u.includes('.png'))).toBe(false);
  });

  it('extracts from HTML anchors and stays same-site', () => {
    const html =
      '<a href="/issues">Issues</a>' +
      '<a href="https://jordanforex.com/platform/">Platform</a>' +
      '<a href="https://twitter.com/jordanforex">Twitter</a>' + // off-site: excluded
      '<a href="/donate">Donate</a>'; // chrome: excluded
    const links = extractNavPolicyLinks(html, 'https://jordanforex.com/');
    expect(links).toContain('https://jordanforex.com/issues');
    expect(links).toContain('https://jordanforex.com/platform');
    expect(links.some((u) => u.includes('twitter.com'))).toBe(false);
    expect(links.some((u) => u.includes('/donate'))).toBe(false);
  });

  it('dedups by normalized path and drops the home page', () => {
    const md =
      '[Issues](https://x.org/issues) [Issues again](https://x.org/issues/) ' +
      '[Home](https://x.org/)';
    const links = extractNavPolicyLinks(md, 'https://x.org/');
    expect(links.filter((u) => u.endsWith('/issues')).length).toBe(1);
    expect(links).not.toContain('https://x.org/');
  });

  it('is total on empty body / malformed base', () => {
    expect(extractNavPolicyLinks('', 'https://x.org/')).toEqual([]);
    expect(extractNavPolicyLinks('[a](/issues)', 'not a url')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// policySubpathCandidates
// ---------------------------------------------------------------------------

describe('policySubpathCandidates', () => {
  it('joins the curated paths onto the site origin', () => {
    const cands = policySubpathCandidates('https://jordanforex.com/some/deep/page?x=1');
    expect(cands).toContain('https://jordanforex.com/issues');
    expect(cands).toContain('https://jordanforex.com/platform');
    expect(cands).toContain('https://jordanforex.com/priorities');
    // one per curated path, all origin-scoped.
    expect(cands.length).toBe(POLICY_SUBPATHS.length);
    expect(cands.every((u) => u.startsWith('https://jordanforex.com/'))).toBe(true);
  });
  it('is total on a malformed url', () => {
    expect(policySubpathCandidates('not a url')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// normalizePath / isPolicySubpageUrl
// ---------------------------------------------------------------------------

describe('normalizePath', () => {
  it('lowercases, strips trailing slash on non-root, keeps root', () => {
    expect(normalizePath('/Issues/')).toBe('/issues');
    expect(normalizePath('/')).toBe('/');
    expect(normalizePath('/a/b/?q=1#frag')).toBe('/a/b');
    expect(normalizePath('issues')).toBe('/issues');
  });
});

describe('isPolicySubpageUrl', () => {
  it('true for policy subpages, false for home / chrome', () => {
    expect(isPolicySubpageUrl('https://jordanforex.com/issues')).toBe(true);
    expect(isPolicySubpageUrl('https://rileyforex.com/rileys-priorities')).toBe(true);
    expect(isPolicySubpageUrl('https://jordanforex.com/')).toBe(false);
    expect(isPolicySubpageUrl('https://jordanforex.com/donate')).toBe(false);
  });
  it('is total on a malformed url', () => {
    expect(isPolicySubpageUrl('nope')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// prioritizeSources
// ---------------------------------------------------------------------------

describe('harvestPriorityOf / prioritizeSources', () => {
  it('assigns the intended tiers', () => {
    expect(
      harvestPriorityOf({ url: 'https://x.org/issues', source_family: 'candidate_site' }),
    ).toBe(HARVEST_PRIORITY.site_policy_subpage);
    expect(
      harvestPriorityOf({ url: 'https://x.org/', source_family: 'candidate_site' }),
    ).toBe(HARVEST_PRIORITY.site_other);
    expect(
      harvestPriorityOf({ url: 'https://apnews.com/a', source_family: 'news' }),
    ).toBe(HARVEST_PRIORITY.news);
    expect(
      harvestPriorityOf({ url: 'https://x.com/foo', source_family: 'social' }),
    ).toBe(HARVEST_PRIORITY.social);
  });

  it('orders a mixed batch policy-subpage > site other > news > social, stable within tier', () => {
    const input = [
      { url: 'https://x.com/foo', source_family: 'social' },
      { url: 'https://site.org/', source_family: 'candidate_site' },
      { url: 'https://news.org/a', source_family: 'news' },
      { url: 'https://site.org/issues', source_family: 'candidate_site' },
      { url: 'https://site.org/platform', source_family: 'candidate_site' },
    ];
    const out = prioritizeSources(input);
    expect(out.map((s) => s.url)).toEqual([
      'https://site.org/issues', // policy subpage (tier 0), first in original order
      'https://site.org/platform', // policy subpage (tier 0), second
      'https://site.org/', // site other (tier 1)
      'https://news.org/a', // news (tier 2)
      'https://x.com/foo', // social (tier 3)
    ]);
  });

  it('does not mutate the input array', () => {
    const input = [
      { url: 'https://x.com/foo', source_family: 'social' },
      { url: 'https://site.org/issues', source_family: 'candidate_site' },
    ];
    const copy = [...input];
    prioritizeSources(input);
    expect(input).toEqual(copy);
  });
});
