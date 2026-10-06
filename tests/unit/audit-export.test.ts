import { describe, expect, it } from 'vitest';
import { SiteAuditReportSchema } from '../../src/shared/audit';
import { auditElementsCsv, auditMarkdown } from '../../src/server/export';
import { sampleSiteAudit } from '../helpers/site-audit-sample';

// Everything in an audit that came from the web — page titles, headings, AI answers, domains — is untrusted. It must
// stay text in a CSV cell and in a Markdown document.

const HOSTILE = '=HYPERLINK("http://evil.example","клик") [x](javascript:alert(1)) ![i](http://evil.example/p.png) <script>alert(1)</script> | # заглавие';

function hostile() {
  const audit = sampleSiteAudit();
  audit.site.domain = 'my-studio.example';
  for (const e of audit.elements.slice(0, 6)) {
    e.now = HOSTILE;
    e.reason = HOSTILE;
    e.proposal = HOSTILE;
  }
  for (const q of audit.questions.slice(0, 4)) q.text = HOSTILE.slice(0, 200);
  for (const p of audit.plan) {
    p.title = HOSTILE;
    p.questions = [HOSTILE];
    p.checklist = p.checklist.map((c) => ({ ...c, text: HOSTILE, why: HOSTILE }));
  }
  audit.warnings = [HOSTILE];
  if (audit.geo) {
    audit.geo.engines[0]!.citedInstead = { domain: HOSTILE, answers: 3 };
    for (const s of audit.geo.skips.slice(0, 3)) {
      s.question = HOSTILE;
      s.winner = { domain: HOSTILE, url: 'https://evil.example/`x`', kind: 'other' };
    }
  }
  return audit;
}

describe('the audit exports', () => {
  it('the sample is a valid report (so the tests below say something about real ones)', () => {
    expect(SiteAuditReportSchema.safeParse(sampleSiteAudit()).success).toBe(true);
  });

  it('keep spreadsheet formulas from running: a cell that starts with = + - @ gets a quote', () => {
    const csv = auditElementsCsv(hostile());
    expect(csv.startsWith(String.fromCharCode(0xfeff))).toBe(true);
    const cells = csv.split('\r\n').flatMap((line) => line.split(','));
    expect(cells.some((c) => /^["']?=HYPERLINK/.test(c) && !c.startsWith("'") && !c.startsWith('"\'='))).toBe(false);
    expect(csv).toContain("'=HYPERLINK");
    expect(csv.split('\r\n')[0]).toContain('Страница');
    expect(csv.trim().split('\r\n').length).toBe(sampleSiteAudit().elements.length + 1);
  });

  it('turn nothing from the web into a link, an image, HTML, a heading or a table break in Markdown', () => {
    const md = auditMarkdown(hostile());
    expect(md).not.toMatch(/(?<!\\)<script/); // an unescaped tag
    expect(md).not.toMatch(/(^|[^\\])\[x\]\(/); // an unescaped link
    expect(md).not.toMatch(/(^|[^\\])!\[i\]/); // an unescaped image
    expect(md).not.toMatch(/(?<!\\)# заглавие/); // a heading marker from page text (the escaped "\#" is fine)
    expect(md).toContain('\\[x\\]');
    expect(md).toContain('\\<script\\>');
    // every table row keeps its shape: no raw pipe inside a cell
    for (const row of md.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| -'))) {
      const unescaped = row.replace(/\\\|/g, '').split('|').length;
      const header = md.split('\n').find((l) => l.startsWith('| ') && l !== row && !l.startsWith('| -') && row.split('|').length > 0);
      expect(unescaped).toBeGreaterThan(2);
      expect(header).toBeDefined();
    }
  });

  it('say what the audit found, with the figures from the report', () => {
    const audit = sampleSiteAudit();
    const md = auditMarkdown(audit);
    expect(md).toContain(`# Одит на сайта ${audit.site.domain}`);
    expect(md).toContain(`**${audit.figures.elementsToChange}** от ${audit.figures.elementsTotal}`);
    expect(md).toContain('## План: страници за създаване или пренаписване');
    for (const plan of audit.plan) expect(md).toContain(plan.checklist[0]!.text.replace(/[\\`*_[\]<>#|]/g, '\\$&').slice(0, 20));
    expect(md).toMatch(/оценка, не измерване/);
    if (audit.geo) for (const e of audit.geo.engines) expect(md).toContain(`${Math.round(e.rate * 100)}%`);
  });

  it('mark a demo audit as made-up data', () => {
    const audit = sampleSiteAudit();
    audit.mode = 'demo';
    expect(auditMarkdown(audit)).toMatch(/ДЕМО/);
  });
});
