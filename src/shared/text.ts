// Text hygiene shared by the server (extraction, SERP data, exports, the text sent to Jev).

// Built from code points on purpose: U+2028/U+2029 inside a regex literal would be a syntax error.
const ch = (n: number): string => String.fromCodePoint(n);
const span = (from: number, to: number): string => `${ch(from)}-${ch(to)}`;

/**
 * Characters a reader cannot see but a program (or a model) can: soft hyphen, Arabic letter mark, zero-width and
 * bidirectional controls, line/paragraph separators, word joiners and isolates, BOM, and the Unicode "tag" block that
 * can smuggle invisible text. A competitor can put them in a title to make it read differently from what it says.
 */
const INVISIBLE = new RegExp(`[${ch(0xad)}${ch(0x61c)}${ch(0x180e)}${span(0x200b, 0x200f)}${span(0x2028, 0x202f)}${span(0x2060, 0x206f)}${ch(0xfeff)}${span(0xe0000, 0xe007f)}]`, 'gu');
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** Removes invisible and control characters (tabs and newlines stay; callers collapse whitespace themselves). */
export function stripInvisible(text: string): string {
  return text.replace(INVISIBLE, '').replace(CONTROL, '');
}
