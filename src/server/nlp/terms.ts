import { analyze, looksLikeQuestion, terms as contentTerms, type Token } from './bg';

// Phrase mining over a handful of competitor pages: which words and short phrases do many of the
// top-ranking pages share? Document frequency (how many *pages* use a phrase) is the signal — repeating
// a phrase 40 times on one page says nothing about what the SERP expects.

export interface PhraseStat {
  /** Canonical key (stems joined by spaces). */
  key: string;
  /** Most common surface form, for display. */
  display: string;
  /** Number of words (1–3). */
  n: number;
  /** Pages that contain the phrase at least once. */
  pages: number;
  /** Total occurrences across all pages. */
  total: number;
}

/** Splits on sentence and clause boundaries so phrases never span punctuation. */
export function segments(text: string): string[] {
  return text
    .split(/[.!?;:,\n\r|•·()[\]{}«»"“”„…—–]+/u)
    .map((s) => s.trim())
    .filter(Boolean);
}

function windows(tokens: Token[], n: number): Token[][] {
  const out: Token[][] = [];
  for (let i = 0; i + n <= tokens.length; i++) {
    const w = tokens.slice(i, i + n);
    const first = w[0] as Token;
    const last = w[n - 1] as Token;
    if (first.stop || last.stop) continue;
    if (w.some((t) => t.numeric || t.raw.length < 2)) continue;
    if (n === 1 && first.raw.length < 3) continue;
    // phrases dominated by function words ("изработка на и за") carry no topic
    if (w.filter((t) => t.stop).length > Math.floor(n / 2)) continue;
    out.push(w);
  }
  return out;
}

/** Phrase counts for one document: key → {display, count}. */
export function extractPhrases(text: string, maxN = 3): Map<string, { display: string; n: number; count: number; surfaces: Map<string, number> }> {
  const found = new Map<string, { display: string; n: number; count: number; surfaces: Map<string, number> }>();
  for (const segment of segments(text)) {
    const tokens = analyze(segment);
    for (let n = 1; n <= maxN; n++) {
      for (const w of windows(tokens, n)) {
        const key = w.map((t) => (t.stop ? t.raw : t.stem)).join(' ');
        const surface = w.map((t) => t.raw).join(' ');
        const entry = found.get(key) ?? { display: surface, n, count: 0, surfaces: new Map() };
        entry.count++;
        entry.surfaces.set(surface, (entry.surfaces.get(surface) ?? 0) + 1);
        found.set(key, entry);
      }
    }
  }
  return found;
}

export interface MineOptions {
  /** Largest phrase length in words. */
  maxN?: number;
  /** Keep phrases used by at least this many documents. */
  minPages?: number;
}

/** Document-frequency table of phrases across several documents, most widely shared first. */
export function minePhrases(docs: readonly string[], options: MineOptions = {}): PhraseStat[] {
  const { maxN = 3, minPages = 2 } = options;
  const table = new Map<string, { n: number; pages: number; total: number; surfaces: Map<string, number> }>();
  for (const doc of docs) {
    for (const [key, entry] of extractPhrases(doc, maxN)) {
      const row = table.get(key) ?? { n: entry.n, pages: 0, total: 0, surfaces: new Map() };
      row.pages++;
      row.total += entry.count;
      for (const [surface, c] of entry.surfaces) row.surfaces.set(surface, (row.surfaces.get(surface) ?? 0) + c);
      table.set(key, row);
    }
  }
  const stats: PhraseStat[] = [];
  for (const [key, row] of table) {
    if (row.pages < minPages) continue;
    const display = [...row.surfaces.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0]?.[0] ?? key;
    stats.push({ key, display, n: row.n, pages: row.pages, total: row.total });
  }
  return stats.sort((a, b) => b.pages - a.pages || b.n - a.n || b.total - a.total || a.key.localeCompare(b.key));
}

/**
 * Drops phrases that are fully contained in a longer phrase with (almost) the same reach,
 * so the output shows "изработка на сайт" instead of also listing "изработка" and "сайт" separately.
 */
export function pruneSubsumed(stats: readonly PhraseStat[], tolerance = 0.85): PhraseStat[] {
  const keep: PhraseStat[] = [];
  for (const s of stats) {
    const shadowed = stats.some(
      (longer) => longer.n > s.n && longer.pages >= s.pages * tolerance && (` ${longer.key} `).includes(` ${s.key} `),
    );
    if (!shadowed) keep.push(s);
  }
  return keep;
}

// ───────────────────────── heading clusters ("subtopics") ─────────────────────────

export interface HeadingCluster {
  /** Representative heading (most common, then shortest). */
  topic: string;
  /** Distinct documents whose headings fall in this cluster. */
  pages: number;
  examples: string[];
  terms: string[];
}

interface HeadingItem {
  doc: number;
  text: string;
  terms: Set<string>;
}

const jaccard = (a: ReadonlySet<string>, b: ReadonlySet<string>): number => {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
};

/**
 * Greedy clustering of headings by overlap of their content terms. Headings from different pages that
 * talk about the same thing ("Цени на изработка", "Колко струва изработката на сайт") land together.
 *
 * `ignore` holds terms every heading shares by construction (the keyword's own words): left in, they would
 * glue unrelated subtopics together ("Колко струва изработката на сайт" + "Как протича изработката на сайт").
 */
export function clusterHeadings(
  headingsByDoc: readonly (readonly string[])[],
  threshold = 0.4,
  ignore: ReadonlySet<string> = new Set(),
): HeadingCluster[] {
  const items: HeadingItem[] = [];
  headingsByDoc.forEach((headings, doc) => {
    for (const text of headings) {
      const t = new Set(contentTerms(text).filter((term) => !ignore.has(term)));
      if (t.size > 0) items.push({ doc, text, terms: t });
    }
  });

  const clusters: { terms: Set<string>; items: HeadingItem[] }[] = [];
  for (const item of items) {
    let best: (typeof clusters)[number] | undefined;
    let bestScore = 0;
    for (const c of clusters) {
      const score = jaccard(item.terms, c.terms);
      if (score >= threshold && score > bestScore) {
        best = c;
        bestScore = score;
      }
    }
    if (best) {
      best.items.push(item);
      for (const t of item.terms) best.terms.add(t);
    } else {
      clusters.push({ terms: new Set(item.terms), items: [item] });
    }
  }

  return clusters
    .map((c) => {
      const counts = new Map<string, number>();
      for (const i of c.items) counts.set(i.text, (counts.get(i.text) ?? 0) + 1);
      const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length);
      return {
        topic: ranked[0]?.[0] ?? '',
        pages: new Set(c.items.map((i) => i.doc)).size,
        examples: ranked.slice(0, 3).map(([t]) => t),
        terms: [...c.terms].slice(0, 8),
      };
    })
    .sort((a, b) => b.pages - a.pages || a.topic.localeCompare(b.topic));
}

export { looksLikeQuestion };
