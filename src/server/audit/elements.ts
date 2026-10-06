import type { PageType } from '../../shared/domain';
import { META_LENGTH, PAGE_IMPORTANCE, TITLE_LENGTH } from '../../shared/weights';
import type { ElementVerdict, SeoElement } from '../../shared/audit';
import type { PageMetrics } from '../../shared/schemas';
import type { Answers } from '../jev/client';
import { noulConfidence } from '../jev/client';
import { clip, type ExtractedPage } from '../jev/questions';
import { coverage, fileSlug } from '../nlp/bg';
import { introProse, lenOf, normalizeForCompare } from './text';
import type { elementQuestions, faqQuestionSet } from './questions';

// SEO elements judged one by one: objective rules first (missing, too long, duplicated), then Jev's reading of the
// elements that need a judgement (is the title clear? does the first paragraph get to the point?). A rule that fails
// is a verdict with confidence 1; a Jev verdict carries Jev's own confidence.

type ElementAnswers = Partial<Answers<typeof elementQuestions>>;
type FaqAnswers = Partial<Answers<typeof faqQuestionSet>>;

export interface ElementInput {
  url: string;
  extracted: ExtractedPage;
  /** What the page is about (its H1 or title, cleaned). */
  phrase: string | null;
  type: PageType | null;
  /** Google position of the page for its phrase; null = not looked up or not found. */
  rank: number | null;
  /** The name used in proposed titles. */
  brand: string;
  /** Jev's answers about the title, meta, H1, first paragraph and outline; null = Jev did not answer. */
  jev: ElementAnswers | null;
  faqJev: FaqAnswers | null;
  /** How many pages of the site share each normalised title / meta description / H1. */
  duplicates: { title: number; meta: number; h1: number };
}

const GOOD = 0.5;

/** The weight of an element in the page's SEO, used only to order fixes. */
const ELEMENT_WEIGHT: Record<SeoElement, number> = { title: 1, h1: 0.8, canonical: 0.8, meta: 0.7, intro: 0.6, schema: 0.6, h2: 0.5, faq: 0.5, url: 0.4, links: 0.4, images: 0.3 };

const cap = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** The first candidate that is not the current text itself — a proposal that repeats what is there helps nobody. */
const firstDifferent = (current: string, candidates: ReadonlyArray<string | null>): string | null => candidates.find((c): c is string => !!c && normalizeForCompare(c) !== normalizeForCompare(current)) ?? null;

/** The part of a title before the site name: "Изработка на сайтове | Студио" → "Изработка на сайтове". */
export function titleCore(title: string): string {
  const parts = title.split(/\s+[|–—·•-]\s+|\s*[|–—·•]\s*/).map((p) => p.trim()).filter(Boolean);
  return parts[0] ?? title.trim();
}

/** "<core> | <brand>" when it fits a search result, else the core cut on a word boundary. */
export function fitTitle(core: string, brand: string, max: number = TITLE_LENGTH.max): string {
  const c = cap(core.trim());
  const withBrand = `${c} | ${brand}`;
  if (lenOf(withBrand) <= max) return withBrand;
  if (lenOf(c) <= max) return c;
  const cut = [...c].slice(0, max).join('');
  const space = cut.lastIndexOf(' ');
  return (space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd();
}

/** A meta description from the first sentences of the page, 70–160 characters. */
export function metaFromIntro(intro: string): string | null {
  const text = intro.replace(/\s+/g, ' ').trim();
  if (lenOf(text) < META_LENGTH.min) return null;
  const sentences = text.split(/(?<=[.!?…])\s+/);
  let out = '';
  for (const s of sentences) {
    if (lenOf(`${out} ${s}`.trim()) > META_LENGTH.max) break;
    out = `${out} ${s}`.trim();
  }
  if (lenOf(out) >= META_LENGTH.min) return out;
  const cut = [...text].slice(0, META_LENGTH.max - 1).join('');
  const space = cut.lastIndexOf(' ');
  return `${(space > META_LENGTH.min ? cut.slice(0, space) : cut).trimEnd()}…`;
}

const SCHEMA_EXPECTED: Partial<Record<PageType, { types: RegExp; label: string }>> = {
  service_page: { types: /service|localbusiness|organization|professionalservice/i, label: 'Service (или LocalBusiness)' },
  company_homepage: { types: /organization|localbusiness|website/i, label: 'Organization и WebSite' },
  blog_article: { types: /article|blogposting|newsarticle/i, label: 'Article' },
  ecommerce_product: { types: /product|offer/i, label: 'Product' },
  comparison_listicle: { types: /article|itemlist|review/i, label: 'Article или ItemList' },
};

const shortUrl = (url: string): string => {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}` || '/';
  } catch {
    return url;
  }
};

/** Does the page's address say what it is about? Returns a problem, or null when the address is fine. */
export function urlProblem(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const path = u.pathname;
  if (path === '/' || path === '') return null;
  if ([...u.searchParams.keys()].length >= 2) return 'Адресът има няколко параметъра след „?“.';
  if (/[A-ZА-Я]/.test(decodeURIComponent(path))) return 'Адресът съдържа главни букви.';
  if (path.includes('_')) return 'Адресът използва „_“ вместо „-“ между думите.';
  if (lenOf(path) > 90) return 'Адресът е прекалено дълъг.';
  const last = path.split('/').filter(Boolean).pop() ?? '';
  if (/^\d+$/.test(last) || /^[a-f0-9]{16,}$/i.test(last)) return 'Адресът е само номер и не съдържа ключова дума.';
  return null;
}

export { normalizeForCompare };

const META_HINT = 'Опиши страницата в 120–155 знака: какво предлага, за кого е и защо да се кликне.';

export function judgeElements(input: ElementInput): ElementVerdict[] {
  const { extracted, jev } = input;
  const m: PageMetrics = extracted.metrics;
  const out: ElementVerdict[] = [];
  const importance = PAGE_IMPORTANCE[input.type ?? 'other'];
  const rankFactor = input.rank === null ? 0.6 : input.rank <= 3 ? 0.4 : input.rank <= 10 ? 1 : input.rank <= 30 ? 0.9 : 0.7;

  const add = (
    element: SeoElement,
    now: string,
    verdict: 'keep' | 'change',
    confidence: number,
    reason: string,
    proposal: string | null,
    source: 'rule' | 'jev',
  ): void => {
    const c = Math.max(0, Math.min(1, confidence));
    out.push({
      url: input.url,
      element,
      now: clip(now, 200) || 'липсва',
      verdict,
      confidence: Math.round(c * 1000) / 1000,
      reason: clip(reason, 240),
      proposal: verdict === 'change' && proposal ? clip(proposal, 400) : null,
      source,
      proposalBy: verdict === 'change' && proposal ? 'rule' : null,
      impact: verdict === 'change' ? Math.round(Math.min(1, importance * ELEMENT_WEIGHT[element] * rankFactor * (0.5 + 0.5 * c)) * 1000) / 1000 : 0,
    });
  };

  const phrase = input.phrase;
  const h1Text = (m.h1[0] ?? '').trim();
  // proper capitalisation comes from the page's own H1; the lower-cased phrase is only for searching
  const core = h1Text || (m.title ? titleCore(m.title) : '') || phrase || '';
  const titleHint = `Добави към заглавието какво предлага страницата или за кого е, напр. „${cap(core || 'тема')} – <полза или тема> | ${input.brand}“.`;
  const proposeTitle = (current: string): string => firstDifferent(current, [core ? fitTitle(core, input.brand) : null]) ?? titleHint;

  // ── title ──
  const title = (m.title ?? '').trim();
  const proposedTitle = proposeTitle(title);
  if (!title) add('title', '', 'change', 1, 'Страницата няма заглавие (title) — това е най-важният елемент за Google и за ИИ.', proposedTitle, 'rule');
  else if (lenOf(title) > TITLE_LENGTH.max) add('title', title, 'change', 0.9, `Заглавието е ${lenOf(title)} знака — Google го реже след около 60.`, proposedTitle, 'rule');
  else if (lenOf(title) < TITLE_LENGTH.min) add('title', title, 'change', 0.8, `Заглавието е само ${lenOf(title)} знака — има място за ключова фраза и полза.`, proposedTitle, 'rule');
  else if (input.duplicates.title > 1) add('title', title, 'change', 0.95, `Същото заглавие има на ${input.duplicates.title} страници — всяка страница се нуждае от свое.`, proposedTitle, 'rule');
  else if (phrase && coverage(phrase, title) < 0.6) add('title', title, 'change', 0.85, `Заглавието не съдържа основната фраза „${phrase}“.`, proposedTitle, 'rule');
  else if (jev?.title_clear && jev.title_specific) {
    const p = (jev.title_clear.p + jev.title_specific.p) / 2;
    if (p < GOOD) {
      const vague = jev.title_clear.p < jev.title_specific.p;
      add('title', title, 'change', noulConfidence(p), vague ? 'Заглавието не казва ясно какво предлага страницата.' : 'Заглавието е общо: не назовава конкретната услуга или тема.', proposedTitle, 'jev');
    } else add('title', title, 'keep', noulConfidence(p), 'Заглавието е ясно и конкретно.', null, 'jev');
  } else add('title', title, 'keep', 0.6, 'Дължината и фразата са наред.', null, 'rule');

  // ── meta description ──
  const meta = (m.metaDescription ?? '').trim();
  const introText = introProse(extracted.text.intro, [m.h1[0], m.title]);
  const metaProposal = metaFromIntro(introText) ?? META_HINT;
  if (!meta) add('meta', '', 'change', 1, 'Липсва мета описание — Google ще избере случаен откъс.', metaProposal, 'rule');
  else if (lenOf(meta) > META_LENGTH.max) add('meta', meta, 'change', 0.8, `Описанието е ${lenOf(meta)} знака — част от него няма да се вижда в резултатите.`, metaProposal, 'rule');
  else if (lenOf(meta) < META_LENGTH.min) add('meta', meta, 'change', 0.75, `Описанието е само ${lenOf(meta)} знака — не използва мястото си.`, metaProposal, 'rule');
  else if (input.duplicates.meta > 1) add('meta', meta, 'change', 0.9, `Същото описание има на ${input.duplicates.meta} страници.`, metaProposal, 'rule');
  else if (jev?.meta_inviting) {
    const p = jev.meta_inviting.p;
    if (p < GOOD) add('meta', meta, 'change', noulConfidence(p), 'Описанието не дава причина да се кликне върху резултата.', metaProposal, 'jev');
    else add('meta', meta, 'keep', noulConfidence(p), 'Описанието обобщава страницата и мотивира за клик.', null, 'jev');
  } else add('meta', meta, 'keep', 0.6, 'Дължината е наред.', null, 'rule');

  // ── H1 ──
  const h1 = m.h1[0] ?? '';
  const h1Proposal = firstDifferent(h1, [m.title ? titleCore(m.title) : null, phrase ? cap(phrase) : null]) ?? 'Назови основната тема на страницата със словата, с които посетителят я търси.';
  if (m.h1.length === 0) add('h1', '', 'change', 1, 'Страницата няма H1 заглавие.', h1Proposal, 'rule');
  else if (m.h1.length > 1) add('h1', h1, 'change', 0.85, `Има ${m.h1.length} H1 — трябва да е едно, за основната тема.`, h1Proposal, 'rule');
  else if (input.duplicates.h1 > 1) add('h1', h1, 'change', 0.85, `Същият H1 има на ${input.duplicates.h1} страници.`, h1Proposal, 'rule');
  else if (jev?.h1_matches) {
    const p = jev.h1_matches.p;
    if (p < GOOD) add('h1', h1, 'change', noulConfidence(p), 'H1 не назовава ясно основната тема със словата на посетителя.', h1Proposal, 'jev');
    else add('h1', h1, 'keep', noulConfidence(p), 'H1 назовава основната тема.', null, 'jev');
  } else add('h1', h1, 'keep', 0.6, 'Има един H1.', null, 'rule');

  // ── first paragraph ──
  const intro = introText;
  if (lenOf(intro) < 60) add('intro', intro, 'change', 0.9, 'Страницата почти няма увод — отговорът трябва да е в първите изречения.', 'Започни с 1–2 изречения, които отговарят директно на въпроса на посетителя.', 'rule');
  else if (jev?.intro_direct) {
    const p = jev.intro_direct.p;
    if (p < GOOD) add('intro', intro, 'change', noulConfidence(p), 'Въведението не стига до същината — ИИ и посетителите търсят отговора в първите изречения.', 'Премести отговора или основната полза в първото изречение; след това разгърни.', 'jev');
    else add('intro', intro, 'keep', noulConfidence(p), 'Въведението стига веднага до същината.', null, 'jev');
  }

  // ── subheadings ──
  if (m.wordCount >= 300) {
    const outline = jev?.outline_logical;
    if (m.h2Count === 0) add('h2', 'няма подзаглавия', 'change', 0.95, `Текст от ${m.wordCount} думи без нито едно подзаглавие.`, 'Раздели текста на секции с H2 подзаглавия — по едно за всеки въпрос, на който отговаряш.', 'rule');
    else if (m.wordCount >= 900 && m.h2Count < 3) add('h2', `${m.h2Count} подзаглавия`, 'change', 0.8, 'Дълъг текст с малко подзаглавия.', 'Добави подзаглавия за всеки подтема, за да могат читатели и ИИ да намират частите.', 'rule');
    else if (outline) {
      if (outline.value < 0.5) add('h2', `${m.h2Count} подзаглавия`, 'change', Math.min(1, 0.4 + outline.confidence * 0.6), 'Подзаглавията не образуват ясен и пълен план на темата.', 'Пренареди подзаглавията в логичен ред и добави липсващите части на темата.', 'jev');
      else add('h2', `${m.h2Count} подзаглавия`, 'keep', outline.confidence, 'Подзаглавията образуват логичен план.', null, 'jev');
    } else add('h2', `${m.h2Count} подзаглавия`, 'keep', 0.6, 'Има подзаглавия.', null, 'rule');
  }

  // ── FAQ ──
  const wantsFaq = m.wordCount >= 250 && (input.type === 'service_page' || input.type === 'blog_article' || input.type === 'ecommerce_product' || input.type === 'company_homepage');
  if (m.hasFaqSchema) {
    const p = input.faqJev?.faq_useful?.p;
    if (p !== undefined && p < GOOD) add('faq', `${m.faqQuestions || 'няколко'} въпроса със schema`, 'change', noulConfidence(p), 'Въпросите в FAQ не са такива, каквито купувачите наистина задават.', 'Замени ги с въпросите от таба „Въпроси“ — цена, срок, сравнение, доверие.', 'jev');
    else add('faq', `${m.faqQuestions || 'няколко'} въпроса със schema`, 'keep', p === undefined ? 0.7 : noulConfidence(p), 'Има FAQ със структурирани данни.', null, p === undefined ? 'rule' : 'jev');
  } else if (m.hasFaqSection) {
    add('faq', 'секция с въпроси, без schema', 'change', 0.9, 'Въпросите няма структурирани данни (FAQPage) — ИИ и Google ги четат по-трудно.', 'Добави JSON-LD FAQPage за въпросите на страницата.', 'rule');
  } else if (wantsFaq) {
    add('faq', 'няма', 'change', 0.75, 'Страницата няма секция с въпроси и отговори — ИИ асистентите често цитират точно такива блокове.', 'Добави 4–6 въпроса, които купувачите задават (виж таба „Въпроси“), и FAQPage schema.', 'rule');
  }

  // ── structured data ──
  const expected = input.type ? SCHEMA_EXPECTED[input.type] : undefined;
  if (m.schemaTypes.length === 0) {
    if (m.wordCount >= 120 || input.type === 'company_homepage') add('schema', 'няма', 'change', 0.85, 'Страницата няма структурирани данни (schema.org).', expected ? `Добави JSON-LD от тип ${expected.label}.` : 'Добави JSON-LD, който описва страницата.', 'rule');
  } else if (expected && !m.schemaTypes.some((t) => expected.types.test(t))) {
    add('schema', m.schemaTypes.join(', '), 'change', 0.7, `Има schema.org, но не от очаквания тип за този вид страница.`, `Добави JSON-LD от тип ${expected.label}.`, 'rule');
  } else add('schema', m.schemaTypes.join(', '), 'keep', 0.8, 'Има подходяща schema.org разметка.', null, 'rule');

  // ── canonical / indexing ──
  if (m.noindex) add('canonical', 'noindex', 'change', 1, 'Страницата е със „noindex“ — Google и ИИ няма да я използват.', 'Махни noindex, ако страницата е предназначена да се намира.', 'rule');
  else if (!m.canonical) add('canonical', '', 'change', 0.7, 'Няма canonical адрес — копия на страницата могат да се конкурират помежду си.', 'Добави <link rel="canonical"> със самия адрес на страницата.', 'rule');
  else if (m.canonicalIsSelf === false) add('canonical', m.canonical, 'change', 0.7, 'Canonical сочи към друга страница — тази няма да се класира.', 'Ако страницата е самостоятелна, насочи canonical към собствения ѝ адрес.', 'rule');
  else add('canonical', m.canonical, 'keep', 0.9, 'Canonical сочи към самата страница.', null, 'rule');

  // ── address ──
  const problem = urlProblem(input.url);
  if (problem) {
    const slug = phrase ? fileSlug(phrase, 60) : '';
    add('url', shortUrl(input.url), 'change', 0.7, problem, slug ? `Кратък адрес с основната фраза, напр. /${slug}` : 'Кратък адрес от малки букви и тирета, с основната фраза.', 'rule');
  } else add('url', shortUrl(input.url), 'keep', 0.8, 'Адресът е четим.', null, 'rule');

  // ── internal links ──
  if (m.wordCount >= 150) {
    if (m.links.internal < 5) add('links', `${m.links.internal} вътрешни връзки`, 'change', 0.7, 'Почти няма връзки към други страници на сайта.', 'Свържи страницата със съседните услуги и статии — с описателен текст на връзката.', 'rule');
    else add('links', `${m.links.internal} вътрешни връзки`, 'keep', 0.7, 'Страницата е свързана с останалия сайт.', null, 'rule');
  }

  // ── images ──
  if (m.images.total > 0) {
    const missing = m.images.total - m.images.withAlt;
    if (missing > 0 && m.images.withAlt / m.images.total < 0.8) add('images', `${m.images.withAlt} от ${m.images.total} с alt`, 'change', 0.85, `${missing} от ${m.images.total} картинки нямат описание (alt).`, 'Добави кратък alt текст към всяка смислена картинка.', 'rule');
    else add('images', `${m.images.withAlt} от ${m.images.total} с alt`, 'keep', 0.85, 'Картинките имат описания.', null, 'rule');
  }

  return out;
}
