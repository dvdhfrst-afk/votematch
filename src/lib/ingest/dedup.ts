/**
 * dedup.ts -- self-written MinHash near-duplicate text clustering for the
 * extraction gate (Build 6). NO dependency.
 *
 * Why this exists (framework 09 Part 2.3 corroboration + the gate's stage 3):
 * cross-source corroboration is the anti-hallucination control -- a contact or a
 * position with ONE source publishes low at best; one with >= 2 DISTINCT sources
 * publishes high. But "distinct sources" is a lie if the two sources are the same
 * wire story syndicated to two outlets, or the same campaign bio mirrored on two
 * pages. Counting those as two corroborating sources manufactures false
 * confidence. So before corroboration is counted, near-duplicate texts are
 * collapsed into ONE cluster, and corroboration counts CLUSTERS, not raw sources.
 *
 * MinHash over k-shingles approximates Jaccard similarity of the shingle sets
 * cheaply and deterministically:
 *   - shingle the normalized text into overlapping k-word windows;
 *   - hash each shingle with H independent hash functions (xorshift-mixed);
 *   - the MinHash signature is the per-function minimum;
 *   - estimated Jaccard(a, b) = fraction of signature slots that match;
 *   - union-find clusters texts whose estimated Jaccard >= threshold.
 *
 * Deterministic (fixed seeds), pure, no I/O. Single TypeScript runtime, no
 * Python. No em-dashes / en-dashes; acronyms spelled out on first use.
 */

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Number of independent hash functions = signature length. More = tighter estimate. */
const NUM_HASHES = 64;
/** Shingle size in WORDS. 3-word shingles balance sensitivity vs noise for prose. */
const SHINGLE_K = 3;
/**
 * Estimated-Jaccard threshold at or above which two texts are "near duplicates"
 * and merge into one cluster. 0.6 catches syndication / mirroring (which share
 * the bulk of their shingles) without merging two genuinely different bios that
 * happen to share a sentence.
 */
const DEFAULT_THRESHOLD = 0.6;

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/**
 * 32-bit FNV-1a hash of a string. Fast, well-distributed, dependency-free, and
 * deterministic across runs (no Math.random anywhere). Returns an unsigned 32-bit
 * integer.
 */
function fnv1a(str: string): number {
  let h = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    // h *= 16777619 (FNV prime), kept in 32-bit via Math.imul.
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Mix a base 32-bit hash with a per-function seed to get H independent hash
 * families from one base hash. xorshift-style avalanche keeps the H minimums
 * uncorrelated, which is what makes the Jaccard estimate honest.
 */
function mix(base: number, seed: number): number {
  let x = (base ^ Math.imul(seed, 0x9e3779b1)) >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return x >>> 0;
}

// Fixed per-function seeds, derived deterministically so signatures are stable
// across processes (no random seeding).
const SEEDS: number[] = (() => {
  const out: number[] = [];
  let s = 0x243f6a88; // a fixed constant (pi fraction), just a stable starting point
  for (let i = 0; i < NUM_HASHES; i++) {
    s = mix(s, i + 1);
    out.push(s);
  }
  return out;
})();

// ---------------------------------------------------------------------------
// Shingling + signature
// ---------------------------------------------------------------------------

/** Normalize text for shingling: lowercase, strip punctuation, collapse spaces. */
function normalizeForShingle(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w.length > 0);
}

/**
 * Build the set of k-word shingle strings for a text. Returns a Set so identical
 * shingles collapse (Jaccard is over the shingle SET). If the text is shorter
 * than k words, the whole word list is a single shingle so very short texts still
 * compare.
 */
function shingles(text: string, k = SHINGLE_K): Set<string> {
  const words = normalizeForShingle(text);
  const set = new Set<string>();
  if (words.length === 0) return set;
  if (words.length < k) {
    set.add(words.join(' '));
    return set;
  }
  for (let i = 0; i + k <= words.length; i++) {
    set.add(words.slice(i, i + k).join(' '));
  }
  return set;
}

/**
 * Compute the MinHash signature (length NUM_HASHES) for a text. Each slot is the
 * minimum over all shingles of mix(fnv1a(shingle), seed_j). Empty text yields an
 * all-Infinity signature that matches nothing.
 */
export function minhashSignature(text: string): number[] {
  const sh = shingles(text);
  const sig = new Array<number>(NUM_HASHES).fill(Number.POSITIVE_INFINITY);
  if (sh.size === 0) return sig;
  for (const s of sh) {
    const base = fnv1a(s);
    for (let j = 0; j < NUM_HASHES; j++) {
      const hv = mix(base, SEEDS[j]);
      if (hv < sig[j]) sig[j] = hv;
    }
  }
  return sig;
}

/**
 * Estimated Jaccard similarity of two signatures = fraction of matching slots.
 * Slots that are Infinity on both sides (two empty texts) count as a match;
 * Infinity vs a real value counts as a mismatch.
 */
export function estimatedJaccard(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let same = 0;
  for (let i = 0; i < n; i++) {
    if (a[i] === b[i]) same++;
  }
  return same / n;
}

// ---------------------------------------------------------------------------
// Clustering (union-find)
// ---------------------------------------------------------------------------

class UnionFind {
  private parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(x: number): number {
    let root = x;
    while (this.parent[root] !== root) root = this.parent[root];
    // Path compression.
    while (this.parent[x] !== root) {
      const next = this.parent[x];
      this.parent[x] = root;
      x = next;
    }
    return root;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }
}

export interface DedupResult {
  /**
   * cluster_ids[i] is the cluster id of texts[i]. Cluster ids are small dense
   * integers (0, 1, 2, ...) assigned in order of first appearance, so two
   * near-duplicate texts share an id and a distinct text gets its own.
   */
  cluster_ids: number[];
  /** Number of distinct clusters (= distinct corroborating sources after dedup). */
  cluster_count: number;
  /** clusters[c] = the list of input indices in cluster c. */
  clusters: number[][];
}

/**
 * clusterNearDuplicates(texts, threshold): cluster near-identical texts so that
 * syndicated / mirrored copies collapse to ONE source for corroboration counting.
 *
 *   - Computes a MinHash signature per text.
 *   - Unions every pair whose estimated Jaccard >= threshold.
 *   - Returns a cluster id per input plus the cluster groupings.
 *
 * O(n^2) in the number of texts, which is fine for the per-value corroboration
 * set (a handful of sources for one contact / position). For large corpora a
 * locality-sensitive-hashing band index would replace the pairwise loop, but the
 * gate never compares more than a few sources at a time.
 *
 * Deterministic and pure. threshold defaults to 0.6 (DEFAULT_THRESHOLD).
 */
export function clusterNearDuplicates(
  texts: string[],
  threshold: number = DEFAULT_THRESHOLD,
): DedupResult {
  const n = texts.length;
  if (n === 0) return { cluster_ids: [], cluster_count: 0, clusters: [] };

  const sigs = texts.map((t) => minhashSignature(t ?? ''));
  const uf = new UnionFind(n);

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (estimatedJaccard(sigs[i], sigs[j]) >= threshold) {
        uf.union(i, j);
      }
    }
  }

  // Assign dense cluster ids in order of first appearance.
  const rootToId = new Map<number, number>();
  const cluster_ids = new Array<number>(n);
  const clusters: number[][] = [];
  for (let i = 0; i < n; i++) {
    const root = uf.find(i);
    let id = rootToId.get(root);
    if (id === undefined) {
      id = clusters.length;
      rootToId.set(root, id);
      clusters.push([]);
    }
    cluster_ids[i] = id;
    clusters[id].push(i);
  }

  return { cluster_ids, cluster_count: clusters.length, clusters };
}

/**
 * Convenience: count the number of DISTINCT deduped sources among a set of
 * source texts. This is exactly the corroboration count the gate's stage 3 uses
 * (>= 2 distinct deduped sources => may publish high). Equal to
 * clusterNearDuplicates(texts).cluster_count.
 */
export function distinctSourceCount(texts: string[], threshold: number = DEFAULT_THRESHOLD): number {
  return clusterNearDuplicates(texts, threshold).cluster_count;
}
