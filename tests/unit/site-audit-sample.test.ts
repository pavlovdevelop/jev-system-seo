import { describe, expect, it } from 'vitest';
import { CRITERIA, ENGINE_IDS, NEXT_STEPS, QUESTION_STAGES, SiteAuditListItemSchema, SiteAuditReportSchema, SOURCE_KINDS } from '../../src/shared/audit';
import { ID_PATTERN } from '../../src/shared/ids';
import { ANSWER_MATCH, STEAL_AT } from '../../src/shared/weights';
import { SAMPLE_AUDIT_ID, sampleAuditList, sampleSiteAudit } from '../helpers/site-audit-sample';

// The fixture is shared by the UI, its tests and the server's mocks, so it has to be a valid report and agree with itself.

describe('sampleSiteAudit', () => {
  const a = sampleSiteAudit();

  it('is a valid SiteAuditReport that the schema returns unchanged (no defaults left to fill in)', () => {
    const parsed = SiteAuditReportSchema.safeParse(a);
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues.slice(0, 3))).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual(a);
  });

  it('is deterministic: two calls give the same report', () => {
    expect(JSON.stringify(sampleSiteAudit())).toBe(JSON.stringify(a));
    expect(a.id).toBe(SAMPLE_AUDIT_ID);
    expect(a.id).toMatch(ID_PATTERN);
    expect(a.id.startsWith('a_')).toBe(true);
  });

  it('is big enough to exercise every table, and varied enough to exercise every state', () => {
    expect(a.pages).toHaveLength(14);
    expect(a.elements.length).toBeGreaterThanOrEqual(60);
    expect(a.competitorPages).toHaveLength(10);
    expect(a.questions).toHaveLength(24);
    expect(a.geo?.engines).toHaveLength(3);
    expect(a.geo?.answers).toHaveLength(36);
    expect(a.geo?.skips).toHaveLength(8);
    expect(a.geo?.winners).toHaveLength(5);
    expect(a.plan).toHaveLength(5);
    expect(a.warnings).toHaveLength(2);

    expect(new Set(a.elements.map((e) => e.verdict))).toEqual(new Set(['keep', 'change']));
    expect(new Set(a.elements.map((e) => e.source))).toEqual(new Set(['rule', 'jev']));
    expect(new Set(a.elements.flatMap((e) => (e.proposalBy ? [e.proposalBy] : [])))).toEqual(new Set(['rule', 'llm']));
    expect(a.elements.every((e) => (e.verdict === 'change') === (e.proposal !== null))).toBe(true);
    expect(new Set(a.elements.map((e) => e.element)).size).toBeGreaterThanOrEqual(10);
    expect(new Set(a.competitorPages.map((c) => c.verdict))).toEqual(new Set(['steal', 'skip']));
    expect(new Set(a.questions.map((q) => q.verdict))).toEqual(new Set(['no_page', 'weak', 'answered']));
    expect(new Set(a.questions.map((q) => q.stage))).toEqual(new Set(QUESTION_STAGES));
    expect(a.questions.some((q) => q.volume === null)).toBe(true);
    expect(a.questions.some((q) => q.aiCites.length > 0 && q.citedBy.length > 0)).toBe(true);
    expect(a.questions.some((q) => q.aiCites.length === 0 && q.citedBy.length === 0)).toBe(true);
    expect(new Set(a.questions.map((q) => q.nextStep)).size).toBeGreaterThanOrEqual(NEXT_STEPS.length - 1);
    expect(new Set(a.geo?.answers.map((x) => x.status))).toEqual(new Set(['cited', 'named', 'missing', 'failed']));
    expect(new Set([...(a.geo?.skips.map((s) => s.winner?.kind) ?? []), ...(a.geo?.winners.map((w) => w.kind) ?? [])])).toEqual(new Set(SOURCE_KINDS));
    expect(new Set(a.geo?.skips.map((s) => s.action))).toEqual(new Set(['create', 'rewrite']));
    expect(new Set(a.plan.map((p) => p.kind))).toEqual(new Set(['create', 'rewrite']));
    expect(new Set(a.plan.map((p) => p.writtenBy))).toEqual(new Set(['rules', 'llm']));
    expect(a.pages.some((p) => p.citability === null)).toBe(true);
    expect(a.pages.some((p) => CRITERIA.some((k) => p.criteria[k] === null) && p.citability !== null)).toBe(true);
    expect(a.pages.some((p) => p.rank !== null) && a.pages.some((p) => p.rank === null)).toBe(true);
  });

  it('figures agree with the arrays they summarise', () => {
    const f = a.figures;
    expect(f.elementsTotal).toBe(a.elements.length);
    expect(f.elementsToChange).toBe(a.elements.filter((e) => e.verdict === 'change').length);
    expect(f.pagesToSteal).toBe(a.competitorPages.filter((c) => c.verdict === 'steal').length);
    expect(f.competitorPagesTotal).toBe(a.competitorPages.length);
    expect(f.questionsTotal).toBe(a.questions.length);
    expect(f.questionsNoPage).toBe(a.questions.filter((q) => q.verdict === 'no_page').length);
    const judged = a.pages.flatMap((p) => (p.citability ? [p.citability] : []));
    const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;
    expect(f.citabilityNow).toBeCloseTo(mean(judged.map((c) => c.now)), 2);
    expect(f.citabilityAfter).toBeCloseTo(mean(judged.map((c) => c.after)), 2);
    expect(f.citabilityAfter as number).toBeGreaterThan(f.citabilityNow as number);
    expect(f.citationRate).toBeCloseTo(mean((a.geo?.engines ?? []).map((e) => e.rate)), 2);
    for (const p of a.pages) expect(p.elementsToChange).toBe(a.elements.filter((e) => e.url === p.url && e.verdict === 'change').length);
    for (const p of judged) expect(p.after).toBeGreaterThanOrEqual(p.now);
  });

  it('engine figures are computed from the answer records', () => {
    const geo = a.geo;
    if (!geo) throw new Error('the sample has geo data');
    expect(geo.engines.map((e) => e.engine)).toEqual([...ENGINE_IDS]);
    expect(geo.engines.map((e) => Math.round(e.rate * 100))).toEqual([29, 33, 17]);
    for (const e of geo.engines) {
      const mine = geo.answers.filter((x) => x.engine === e.engine);
      expect(e.asked).toBe(mine.length);
      expect(e.failed).toBe(mine.filter((x) => x.status === 'failed').length);
      expect(e.answered).toBe(e.asked - e.failed);
      expect(e.citingUs).toBe(mine.filter((x) => x.status === 'cited' || x.status === 'named').length);
      expect(e.skippingUs).toBe(e.answered - e.citingUs);
      expect(e.rate).toBeCloseTo(e.citingUs / e.answered, 3);
      expect(e.rateLow).toBeLessThan(e.rate);
      expect(e.rateHigh).toBeGreaterThan(e.rate);
      expect(e.usage.calls).toBe(e.asked);
      expect(e.topCited.length).toBeGreaterThan(0);
      expect(e.topCited.map((t) => t.answers)).toEqual([...e.topCited.map((t) => t.answers)].sort((x, y) => y - x));
      if (e.citedInstead) expect(e.citedInstead.domain).not.toBe(a.site.domain);
    }
    expect(geo.engines.filter((e) => e.usage.estimatedCostUsd === null)).toHaveLength(1);
    expect(a.usage.engineCalls).toBe(geo.answers.length);
    expect(a.usage.estimatedEngineCostUsd).toBeNull();
  });

  it('every reference resolves: pages, questions, answers, skips and plan items point at things that exist', () => {
    const urls = new Set(a.pages.map((p) => p.url));
    for (const e of a.elements) expect(urls.has(e.url), e.url).toBe(true);
    for (const q of a.questions) if (q.bestPage) expect(urls.has(q.bestPage), q.bestPage).toBe(true);
    for (const c of a.competitorPages) if (c.ourUrl) expect(urls.has(c.ourUrl), c.ourUrl).toBe(true);
    for (const q of a.questions) expect((q.bestPage === null) === (q.verdict === 'no_page')).toBe(true);
    // the verdicts follow the server's thresholds
    for (const q of a.questions) {
      if (q.match !== null) expect(q.match >= ANSWER_MATCH.answeredAt ? 'answered' : 'weak', q.id).toBe(q.verdict);
      if (q.match !== null) expect(q.match).toBeGreaterThanOrEqual(ANSWER_MATCH.weakBelow);
    }
    for (const c of a.competitorPages) expect(c.overall !== null && c.overall >= STEAL_AT ? 'steal' : 'skip', c.domain).toBe(c.verdict);

    const geo = a.geo;
    if (!geo) throw new Error('the sample has geo data');
    const ids = new Set(a.questions.map((q) => q.id));
    expect(ids.size).toBe(a.questions.length);
    for (const x of geo.answers) {
      expect(ids.has(x.questionId), x.questionId).toBe(true);
      expect((x.position !== null) === (x.status === 'cited')).toBe(true);
      expect(x.citations.some((c) => c.domain === a.site.domain)).toBe(x.status === 'cited');
      if (x.status === 'failed') expect(x.error).not.toBeNull();
      else expect(x.error).toBeNull();
    }
    expect(new Set(geo.answers.map((x) => `${x.engine}:${x.questionId}`)).size).toBe(geo.answers.length);
    for (const q of a.questions) {
      const citing = geo.answers.filter((x) => x.questionId === q.id && (x.status === 'cited' || x.status === 'named')).map((x) => x.engine);
      expect(new Set(q.citedBy)).toEqual(new Set(citing));
      expect(q.aiCites).not.toContain(a.site.domain);
    }
    for (const s of geo.skips) {
      const answer = geo.answers.find((x) => x.engine === s.engine && x.questionId === s.questionId);
      expect(answer?.status, `${s.engine} ${s.questionId}`).toBe('missing');
      expect(a.questions.find((q) => q.id === s.questionId)?.text).toBe(s.question);
      expect(s.action === 'create').toBe(!s.ourPage.exists);
      if (s.winner) expect(answer?.citations.some((c) => c.domain === s.winner?.domain)).toBe(true);
    }
    const texts = new Set(a.questions.map((q) => q.text));
    const priorities = a.plan.map((p) => p.priority);
    expect(priorities).toEqual([...priorities].sort((x, y) => y - x));
    for (const p of a.plan) {
      for (const q of p.questions) expect(texts.has(q), q).toBe(true);
      expect((p.kind === 'rewrite') === (p.url !== null && urls.has(p.url))).toBe(true);
      expect((p.kind === 'create') === (p.suggestedPath !== null)).toBe(true);
      expect(new Set(p.checklist.map((c) => c.id)).size).toBe(p.checklist.length);
      expect(p.checklist.length).toBeGreaterThanOrEqual(4);
    }
  });

  it('keeps the dates in order and the usage figures plausible', () => {
    expect(Date.parse(a.finishedAt) - Date.parse(a.createdAt)).toBe(a.usage.durationMs);
    expect(a.site.pagesAudited).toBe(a.pages.length);
    expect(a.usage.jevInputTokens).toBeGreaterThan(a.usage.jevOutputTokens);
  });
});

describe('sampleAuditList', () => {
  const list = sampleAuditList();

  it('is a list of valid items, newest first, led by the sample audit', () => {
    expect(SiteAuditListItemSchema.array().safeParse(list).success).toBe(true);
    const a = sampleSiteAudit();
    expect(list[0]).toMatchObject({ id: a.id, domain: a.site.domain, mode: a.mode, status: a.status, pagesAudited: a.site.pagesAudited, figures: a.figures });
    const dates = list.map((x) => Date.parse(x.createdAt));
    expect(dates).toEqual([...dates].sort((x, y) => y - x));
    expect(new Set(list.map((x) => x.id)).size).toBe(list.length);
    for (const item of list) expect(item.id).toMatch(ID_PATTERN);
  });
});
