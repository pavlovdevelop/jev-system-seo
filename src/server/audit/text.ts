// Small text helpers shared by the question states and the element rules.

export const lenOf = (s: string): number => [...s].length;

export const normalizeForCompare = (s: string | null | undefined): string => (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * The prose at the top of a page. The extractor's intro starts with the headings and has more headings between its
 * blocks; blocks are separated by line breaks, and headings are the short ones. Returns the first `blocks` paragraphs
 * of at least 40 characters, joined by a space.
 */
export function introProse(intro: string, headings: ReadonlyArray<string | null | undefined>, blocks = 2): string {
  const known = new Set(headings.map((h) => normalizeForCompare(h)).filter(Boolean));
  return intro
    .split(/\n+/)
    .map((b) => b.replace(/\s+/g, ' ').trim())
    .filter((b) => b && !known.has(normalizeForCompare(b)) && lenOf(b) >= 40)
    .slice(0, blocks)
    .join(' ');
}
