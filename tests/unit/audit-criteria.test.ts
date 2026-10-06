import { describe, expect, it } from 'vitest';
import type { CriteriaScores } from '../../src/shared/audit';
import type { PageMetrics } from '../../src/shared/schemas';
import { CITABILITY_WEIGHTS } from '../../src/shared/weights';
import { extractPage } from '../../src/server/crawl/extract';
import { ageMonthsOf, citabilityIndex, citabilityOf, competitorOverall, competitorScores, criteriaScores, freshnessScore, schemaRichness, score10 } from '../../src/server/audit/criteria';
import { buildHtml } from '../helpers/pages';

const NOW = new Date('2026-10-05T10:00:00Z');
const metrics = (over: Partial<PageMetrics> = {}): PageMetrics => ({ ...extractPage(buildHtml({ title: 'Т', h1: 'Т', paragraphs: ['текст'] }), { url: 'https://x.example/', keyword: '', now: NOW }).metrics, ...over });
const all = (v: number | null): CriteriaScores => ({ answer: v, faq: v, author: v, fresh: v, sources: v, facts: v, compare: v, links: v });

describe('weights', () => {
  it('sum to one, so the index is a weighted mean', () => {
    expect(Object.values(CITABILITY_WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });
});

describe('freshness', () => {
  it('uses the date the page gives, then the newest year it mentions, then nothing', () => {
    expect(ageMonthsOf(metrics({ modifiedAt: '2026-04-05T00:00:00.000Z' }), NOW)).toBeCloseTo(6, 0);
    expect(ageMonthsOf(metrics({ modifiedAt: null, publishedAt: '2025-10-05T00:00:00.000Z' }), NOW)).toBeCloseTo(12, 0);
    expect(ageMonthsOf(metrics({ modifiedAt: null, publishedAt: null, latestYear: 2024 }), NOW)).toBe(27);
    expect(ageMonthsOf(metrics({ modifiedAt: null, publishedAt: null, latestYear: null }), NOW)).toBeNull();
    expect(ageMonthsOf(metrics({ modifiedAt: '2027-01-01T00:00:00.000Z' }), NOW)).toBe(0); // a date in the future is not "negative age"
  });

  it('scores 1 up to six months, falls linearly, and bottoms out at two years', () => {
    expect(freshnessScore(null)).toBeNull();
    expect(freshnessScore(0)).toBe(1);
    expect(freshnessScore(6)).toBe(1);
    expect(freshnessScore(15)).toBeCloseTo(0.55, 2);
    expect(freshnessScore(24)).toBe(0.1);
    expect(freshnessScore(60)).toBe(0.1);
  });
});

describe('criteriaScores', () => {
  const page = extractPage(buildHtml({ title: 'Изработка на уебсайт', h1: 'Изработка на уебсайт', paragraphs: ['Текст за изработка на уебсайт. '.repeat(40)] }), { url: 'https://x.example/', keyword: '', now: NOW });
  const base = { extracted: page, now: NOW, judgments: {}, citability: null };

  it('leaves what only Jev can read as null when Jev did not answer, and measures the rest', () => {
    const s = criteriaScores(base);
    expect(s.answer).toBeNull();
    expect(s.facts).toBeNull();
    expect(s.faq).toBe(0);
    expect(s.compare).toBe(0.1);
    expect(s.sources).toBe(0);
    expect(s.author).toBeGreaterThan(0);
    expect(citabilityIndex(s)).toBeNull(); // no judgement of the opening or the facts: no index
  });

  it('takes Jev for answer and facts and blends it with the measurement for sources and author', () => {
    const s = criteriaScores({
      ...base,
      judgments: { showsIdentity: { p: 0.9 } },
      citability: { answer_first: { value: 0.75, raw: 3, levels: 5, confidence: 0.7, probabilities: [] }, specific_facts: { value: 0.5, raw: 2, levels: 5, confidence: 0.7, probabilities: [] }, cites_sources: { p: 0.8 } },
    });
    expect(s.answer).toBe(0.75);
    expect(s.facts).toBe(0.5);
    expect(s.sources).toBeCloseTo(0.4, 2); // half Jev (0.8), half the measured 0 links
    expect(s.author).toBeCloseTo(0.45, 2); // half Jev (0.9), half the measured 0 hints
  });

  it('measures FAQ, tables, lists and internal links from the page', () => {
    const rich = extractPage(
      buildHtml({
        title: 'Цени',
        h1: 'Цени',
        paragraphs: ['Текст. '.repeat(30)],
        extraHead: '<script type="application/ld+json">{"@context":"https://schema.org","@type":"FAQPage","mainEntity":[]}</script>',
        extraBody: '<table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table><ul><li>a</li><li>b</li><li>c</li></ul>' + Array.from({ length: 9 }, (_, i) => `<a href="/s${i}">s${i}</a>`).join(''),
      }),
      { url: 'https://x.example/', keyword: '', now: NOW },
    );
    const m = rich.metrics;
    const s = criteriaScores({ ...base, extracted: { ...rich, metrics: { ...m, tables: 1, lists: 1, faqQuestions: 0, hasFaqSchema: true, links: { internal: 9, external: 0 } } } });
    expect(s.faq).toBe(1);
    expect(s.compare).toBe(1);
    expect(s.links).toBe(1);
  });
});

describe('citability', () => {
  it('is the weighted mean of what could be judged', () => {
    expect(citabilityIndex(all(1))).toBe(1);
    expect(citabilityIndex(all(0.5))).toBe(0.5);
    expect(citabilityIndex({ ...all(1), answer: 0 })).toBeCloseTo(1 - CITABILITY_WEIGHTS.answer, 3);
    expect(citabilityIndex({ ...all(0.6), fresh: null, links: null })).toBeCloseTo(0.6, 3); // missing criteria drop out, they do not count as zero
    expect(score10(0.534)).toBe(5.3);
  });

  it('is still given when only one of the two criteria that need reading is missing', () => {
    expect(citabilityIndex({ ...all(0.6), answer: null })).toBeCloseTo(0.6, 3);
    expect(citabilityIndex({ ...all(0.6), facts: null })).toBeCloseTo(0.6, 3);
  });

  it('names the criterion with the biggest weighted gap as the first fix and projects the result', () => {
    const c = citabilityOf({ ...all(0.9), facts: 0.1 });
    expect(c?.fixFirst?.criterion).toBe('facts');
    expect(c?.fixFirst?.action).toMatch(/факти/);
    expect(c!.after).toBeGreaterThan(c!.now);
    const lifted = citabilityIndex({ ...all(0.9), facts: 0.8 }) as number;
    expect(c!.after).toBeCloseTo(lifted, 3);
  });

  it('has no first fix when nothing is worth fixing, and no citability when Jev read neither answer nor facts', () => {
    const strong = citabilityOf(all(0.98));
    expect(strong?.fixFirst).toBeNull();
    expect(strong?.after).toBe(strong?.now);
    expect(citabilityOf({ ...all(0.5), answer: null, facts: null })).toBeNull();
  });
});

describe('competitor pages', () => {
  it('rates a rich page well and adds the five scores up with their weights', () => {
    const m = metrics({ schemaTypes: ['Service', 'FAQPage', 'Organization'] });
    const scores = competitorScores({ topicDepth: { value: 0.9, raw: 3.6, levels: 5, confidence: 0.8 }, showsReviews: { p: 0.9 }, showsPortfolio: { p: 0.7 }, showsIdentity: { p: 0.8 } }, { ...all(0.8) }, m);
    expect(scores).toMatchObject({ answer: 0.8, depth: 0.9, schema: 1, fresh: 0.8 });
    expect(scores.proof).toBeCloseTo(0.8, 2);
    expect(competitorOverall(scores)).toBeCloseTo(0.28 * 0.8 + 0.28 * 0.9 + 0.2 * 0.8 + 0.12 * 1 + 0.12 * 0.8, 2);
  });

  it('has no overall score when too little could be judged', () => {
    expect(competitorOverall({ answer: null, depth: null, proof: null, schema: 1, fresh: null })).toBeNull();
  });

  it('schema richness grows with the number of distinct types', () => {
    expect([[], ['Service'], ['Service', 'service'], ['Service', 'FAQPage'], ['A', 'B', 'C']].map((t) => schemaRichness(t))).toEqual([0, 0.45, 0.45, 0.75, 1]);
  });
});
