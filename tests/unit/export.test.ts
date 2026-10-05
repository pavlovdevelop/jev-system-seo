import { describe, expect, it } from 'vitest';
import { csvCell, mdText, mdUrl, reportMarkdown } from '../../src/server/export';
import { DEMO_BUSINESS, DEMO_KEYWORD, DEMO_OWN_DOMAIN } from '../../src/server/demo/world';
import { runAnalysis } from '../../src/server/pipeline/analyze';
import { stripInvisible } from '../../src/shared/text';
import { AnalyzeRequestSchema, type Report } from '../../src/shared/schemas';
import { demoDeps } from '../helpers/demo-deps';

const ch = (n: number): string => String.fromCodePoint(n);

describe('stripInvisible', () => {
  it('removes zero-width, bidi, separator, BOM, soft hyphen and tag characters but keeps ordinary text', () => {
    const hidden = [0xad, 0x200b, 0x200e, 0x202e, 0x2028, 0x2066, 0x2069, 0xfeff, 0xe0041].map(ch).join('');
    expect(stripInvisible(`сайт${hidden}ове — цена\nна 2026`)).toBe('сайтове — цена\nна 2026');
    expect(stripInvisible(`a${ch(0)}b${ch(0x7f)}c`)).toBe('abc');
  });

  it('un-reverses a title that uses a right-to-left override to read differently from what it says', () => {
    const disguised = `safe${ch(0x202e)}elpmaxe.evil${ch(0x202c)}`;
    expect(stripInvisible(disguised)).toBe('safeelpmaxe.evil');
  });
});

describe('Markdown export of text that a competitor controls', () => {
  it('turns markup into inert text', () => {
    const hostile = [
      '![](https://evil.example/pixel.png?viewer=report)',
      '[Free SEO audit — click here](https://evil.example/phish)',
      '<img src=x onerror=alert(1)>',
      '| a | b |',
      '# heading',
      '*bold* _em_ `code`',
      '- injected list item',
      'line one\nline two',
    ];
    for (const text of hostile) {
      const out = mdText(text);
      expect(out, text).not.toMatch(/(?<!\\)[[\]<>`*_|#]/); // every markup character is escaped
      expect(out, text).not.toContain('\n');
    }
    expect(mdText('line one\r\n\r\nline two')).toBe('line one line two');
    expect(mdText('- item')).toBe('\\- item');
    expect(mdText('2. item')).toBe('\\2. item');
    expect(mdText(null)).toBe('');
  });

  it('leaves ordinary Bulgarian sentences readable', () => {
    expect(mdText('Търсещите най-често са от тип „готов да поръча“ (≈65% от резултатите).')).toBe('Търсещите най-често са от тип „готов да поръча“ (≈65% от резултатите).');
  });

  it('shows a URL as plain code, whatever it contains', () => {
    expect(mdUrl('https://example.com/a b`c')).toBe('`https://example.com/abc`');
  });

  it('the whole exported report contains no live markup from injected competitor text', async () => {
    const request = AnalyzeRequestSchema.parse({ keyword: DEMO_KEYWORD, ownDomain: DEMO_OWN_DOMAIN, businessDescription: DEMO_BUSINESS });
    const base = await runAnalysis({ id: 'r_test', request, tracked: [] }, demoDeps(), () => {});
    const payload = '![](https://evil.example/p.png) [x](https://evil.example/y) <img src=x onerror=alert(1)>';
    const report: Report = structuredClone(base);
    report.brief.checklist = [payload, ...report.brief.checklist];
    report.brief.summary = payload;
    report.brief.ownGaps = [{ kind: 'term', label: payload, detail: payload }];
    report.warnings = [payload];
    const first = report.competitors[0];
    if (first) {
      first.domain = `evil${ch(0x202e)}.example`;
      first.strengths = [{ id: 'x', kind: 'strength', label: payload, evidence: payload, source: 'measured', confidence: 'high' }];
      first.weaknesses = [{ id: 'y', kind: 'weakness', label: payload, evidence: payload, source: 'measured', confidence: 'high' }];
    }
    if (report.seed.ownRank) report.seed.ownRank.url = 'https://my-studio.example/a`b)[c](d';
    const md = reportMarkdown(report);
    expect(md).not.toMatch(/(?<!\\)[[\]]/);
    expect(md).not.toMatch(/(?<!\\)<(?!br>)/);
    expect(md).not.toContain(ch(0x202e));
    expect(md).toContain('evil.example'); // the text itself is still there, only inert
  });
});

describe('CSV', () => {
  it('neutralises formulas in competitor-controlled cells', () => {
    for (const payload of ['=HYPERLINK("https://evil.example","x")', '+1+1', '-2+3', '@SUM(A1)', '\t=1', '\r=1']) {
      expect(csvCell(payload).replace(/^"/, '')).toMatch(/^'/);
    }
    expect(csvCell(-5)).toBe('-5'); // numbers are not text
  });
});
