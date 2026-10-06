import { describe, expect, it } from 'vitest';
import { extractPage } from '../../src/server/crawl/extract';
import {
  bestExcerpt,
  bucketOf,
  buyerQuestionQuestions,
  buyerQuestionState,
  citabilityQuestions,
  citabilityState,
  coverQuestions,
  coverState,
  elementQuestions,
  elementState,
  faqQuestionsOf,
  pageOverlap,
  sentimentQuestions,
  sentimentState,
  STAGE_CRITERIA,
  type SitePageContext,
} from '../../src/server/audit/questions';
import { QUESTION_STAGES } from '../../src/shared/audit';
import { buildHtml } from '../helpers/pages';

const NOW = new Date('2026-10-05T10:00:00Z');
const URL_ = 'https://my-studio.example/tseni?utm_source=x&token=abc#frag';
const page = extractPage(
  buildHtml({
    title: 'Цени за изработка на уебсайт 2026 – от 490 лв.',
    h1: 'Цени за изработка на уебсайт',
    metaDescription: 'Колко струва изработката на уебсайт: от 490 лв.',
    h2s: ['Пакети и цени', 'Колко време отнема изработката?', 'Какво е включено в цената?', 'Как да платя?'],
    paragraphs: [
      'Изработката на уебсайт при нас струва от 490 лв. за представителен сайт и от 1 490 лв. за онлайн магазин.',
      'Срокът е две до три седмици за представителен сайт, а за магазин между шест и десет седмици.',
      'В цената са включени хостинг и домейн за първата година, SSL сертификат и обучение.',
      'Плащането е на три вноски: 40% аванс, 40% при одобрение на дизайна и 20% при пускане.',
    ],
  }),
  { url: URL_, keyword: '', now: NOW },
);
const ctx: SitePageContext = { url: URL_, market: 'bg', business: 'Студио за уебсайтове', phrase: 'цени за изработка на уебсайт', page };

describe('the question catalogue', () => {
  const all = { ...elementQuestions, ...citabilityQuestions, ...coverQuestions, ...buyerQuestionQuestions, ...sentimentQuestions };

  it('keeps ids away from the reversed-twin suffix and gives every score five levels and every choice an "other"-style way out', () => {
    for (const [id, q] of Object.entries(all)) {
      expect(id.endsWith('__rev')).toBe(false);
      if (q.type === 'score') expect(q.criteria).toHaveLength(5);
      if (q.type === 'choice') expect(Object.keys(q.criteria).length).toBeGreaterThanOrEqual(3);
    }
  });

  it('writes the instructions in English and covers every stage the report knows', () => {
    for (const q of Object.values(all)) expect(q.criteria === undefined || /[A-Za-z]/.test(JSON.stringify(q))).toBe(true);
    for (const stage of QUESTION_STAGES) expect(Object.keys(STAGE_CRITERIA)).toContain(stage);
    expect(Object.keys(STAGE_CRITERIA)).toContain('other');
  });
});

describe('state builders', () => {
  it('sends the address without its query string and fragment', () => {
    const s = elementState(ctx) as { page: { url: string } };
    expect(s.page.url).toBe('https://my-studio.example/tseni');
    expect(JSON.stringify([elementState(ctx), citabilityState(ctx), coverState('колко струва сайт?', ctx)])).not.toContain('token=abc');
  });

  it('gives Jev buckets instead of counts', () => {
    expect([0, 1, 2, 3, 5, 6, 40].map(bucketOf)).toEqual(['none', 'few', 'few', 'several', 'several', 'many', 'many']);
    const s = citabilityState({ ...ctx, page: { ...page, metrics: { ...page.metrics, externalDomains: 7 } } }) as { other_sites_linked: string };
    expect(s.other_sites_linked).toBe('many');
    expect(JSON.stringify(citabilityState(ctx))).not.toMatch(/"(?:words|wordCount|count)"/i);
  });

  it('puts only the head elements in the element slice, and the questions-style headings in the FAQ list', () => {
    const s = elementState(ctx) as Record<string, any>;
    expect(Object.keys(s.page).sort()).toEqual(['first_paragraph', 'h1', 'meta_description', 'subheadings', 'title', 'url']);
    expect(s.faq_questions).toEqual(expect.arrayContaining(['Колко време отнема изработката?', 'Какво е включено в цената?']));
    expect(faqQuestionsOf(page).length).toBeGreaterThanOrEqual(2);
    const plain = extractPage(buildHtml({ title: 'Т', h1: 'Т', h2s: ['Цена', 'Срок'], paragraphs: ['а', 'б'] }), { url: 'https://x.example/', keyword: '', now: NOW });
    expect('faq_questions' in (elementState({ ...ctx, page: plain }) as object)).toBe(false);
  });

  it('shortens every long text', () => {
    const long = 'дума '.repeat(2000);
    const big = extractPage(buildHtml({ title: long, h1: long, metaDescription: long, paragraphs: [long] }), { url: 'https://x.example/', keyword: '', now: NOW });
    const s = elementState({ ...ctx, page: big }) as { page: Record<string, string> };
    expect(s.page.title!.length).toBeLessThanOrEqual(201);
    expect(s.page.first_paragraph!.length).toBeLessThanOrEqual(501);
  });

  it('removes invisible and control characters from page text before Jev reads it', () => {
    const hidden = `Цена${String.fromCodePoint(0x200b)}та${String.fromCodePoint(0xe0041)} е ясна`;
    const dirty = extractPage(buildHtml({ title: hidden, h1: 'Цени', paragraphs: ['Текст.'] }), { url: 'https://x.example/', keyword: '', now: NOW });
    expect(JSON.stringify(elementState({ ...ctx, page: dirty }))).not.toMatch(/[​\u{e0041}]/u);
  });

  it('builds the question, brand and answer states', () => {
    expect(buyerQuestionState('Колко струва сайт?', 'Студио', 'bg')).toMatchObject({ buyer_question: 'Колко струва сайт?', business: 'Студио' });
    const s = sentimentState('Моето студио', 'Кой прави сайтове?', 'Препоръчвам Моето студио. '.repeat(200)) as { assistant_answer: string; brand: string };
    expect(s.brand).toBe('Моето студио');
    expect(s.assistant_answer.length).toBeLessThanOrEqual(1501);
  });
});

describe('finding the right passage and page', () => {
  it('picks the passage about the question out of a long text', () => {
    const text = 'Въведение в темата без нищо конкретно. '.repeat(10) + 'Плащането е на три вноски: 40% аванс, 40% при одобрение и 20% при пускане на сайта. ' + 'Заключение без съдържание. '.repeat(10);
    expect(bestExcerpt(text, 'Как се плаща на вноски?', 300)).toContain('три вноски');
    expect(bestExcerpt('кратко', 'въпрос', 100)).toBe('кратко');
  });

  it('ranks pages by how much of the question their headings and opening cover', () => {
    const price = pageOverlap('Колко струва изработката на уебсайт?', page);
    const other = pageOverlap('Как се готви боб?', page);
    expect(price).toBeGreaterThan(0.4);
    expect(other).toBeLessThan(0.1);
  });
});
