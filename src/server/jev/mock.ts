import type { Question, Questions } from '@typesafe-ai/sdk';
import { coverage } from '../nlp/bg';
import { fnv1a } from '../util/hash';
import { choiceConfidence, scoreConfidence, type SystemOneTransport } from './client';

// A deterministic stand-in for Jev, used by the demo mode and by end-to-end tests. It speaks the exact wire
// format of POST /v1/systemone (so the official SDK, the answer validation and the whole pipeline run for
// real), but answers with transparent heuristics over the same state our question catalogue builds.
//
// It is NOT Jev and says so everywhere it is used. Its only job is to make every code path testable and the
// demo explorable without an API key.

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/** Small stable pseudo-random wobble in [-amount, amount], derived from the request so repeated runs agree. */
function wobble(seedText: string, amount: number): number {
  return ((fnv1a(seedText) % 2001) / 1000 - 1) * amount;
}

function choiceAnswer(options: string[], top: string, p: number, runners: string[]): Json {
  const probs: Record<string, number> = {};
  const rest = (1 - p) * 0.9;
  const runnerShare = runners.length > 0 ? rest / runners.length : 0;
  for (const o of options) probs[o] = o === top ? p : runners.includes(o) ? runnerShare : (1 - p) * 0.1 / Math.max(1, options.length - 1 - runners.length);
  const sum = Object.values(probs).reduce((a, b) => a + b, 0);
  for (const k of Object.keys(probs)) probs[k] = (probs[k] as number) / sum;
  const values = options.map((o) => probs[o] as number);
  return { type: 'choice', choice: top, probabilities: probs, confidence: choiceConfidence(values) };
}

function scoreAnswer(levels: number, raw: number): Json {
  const r = clamp(raw, 0, levels - 1);
  const weights = Array.from({ length: levels }, (_, i) => Math.max(0, 1 - Math.abs(i - r) / 1.15));
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  const probs = weights.map((w) => w / sum);
  const expected = probs.reduce((s, p, i) => s + p * i, 0);
  return {
    type: 'score',
    score: expected,
    legend: Object.fromEntries(Array.from({ length: levels }, (_, i) => [String(i), `level ${i}`])),
    probabilities: Object.fromEntries(probs.map((p, i) => [String(i), p])),
    confidence: scoreConfidence(probs),
  };
}

const noulAnswer = (p: number): Json => ({ type: 'noul', noul: clamp(p, 0.02, 0.98) });

// ───────────────────────── page-type and intent cues ─────────────────────────

type TypeKey = 'service_page' | 'company_homepage' | 'blog_article' | 'comparison_listicle' | 'directory_marketplace' | 'platform_or_tool' | 'forum_or_social' | 'news_or_media' | 'ecommerce_product' | 'other';

const CUES: Array<[TypeKey, RegExp]> = [
  ['forum_or_social', /форум|forum|тема:|\/t\/|нишка|коментари|отговори \(/i],
  ['directory_marketplace', /каталог на фирми|каталог с фирми|фирми[^|.]{0,60}каталог|директори[яи] (на|с) фирми|\/kategoria|регистър на фирми|списък с фирми|firmi-bg/i],
  ['comparison_listicle', /топ \d+|класаци|сравнение на|най-добрите фирми/i],
  ['platform_or_tool', /конструктор|създайте сайт|създай сайт безплатно|drag.?and.?drop|build-your-site|шаблони за сайт/i],
  ['blog_article', /как да|ръководство|съвети|\/blog\/|критерия за избор|какво е /i],
  ['news_or_media', /новини|портал за бизнес|\/news\//i],
];

function detectType(blob: string, url: string): { type: TypeKey; cues: number } {
  for (const [type, re] of CUES) if (re.test(blob)) return { type, cues: (blob.match(re) ?? []).length };
  try {
    const u = new URL(url);
    if (u.pathname === '/' || u.pathname === '') return { type: 'company_homepage', cues: 1 };
  } catch {
    // not a URL: fall through
  }
  return { type: 'service_page', cues: 1 };
}

const RUNNERS: Record<TypeKey, TypeKey[]> = {
  service_page: ['company_homepage', 'blog_article'],
  company_homepage: ['service_page', 'platform_or_tool'],
  blog_article: ['news_or_media', 'comparison_listicle'],
  comparison_listicle: ['directory_marketplace', 'blog_article'],
  directory_marketplace: ['comparison_listicle', 'other'],
  platform_or_tool: ['service_page', 'company_homepage'],
  forum_or_social: ['blog_article', 'other'],
  news_or_media: ['blog_article', 'other'],
  ecommerce_product: ['service_page', 'other'],
  other: ['service_page', 'blog_article'],
};

const INTENT_OF: Record<TypeKey, string> = {
  service_page: 'transactional',
  company_homepage: 'transactional',
  blog_article: 'informational',
  comparison_listicle: 'commercial_investigation',
  directory_marketplace: 'commercial_investigation',
  platform_or_tool: 'transactional',
  forum_or_social: 'informational',
  news_or_media: 'informational',
  ecommerce_product: 'transactional',
  other: 'other',
};

const keys = (q: Question): string[] => (q.type === 'choice' ? Object.keys(q.criteria) : []);
const levelsOf = (q: Question): number => (q.type === 'score' ? q.criteria.length : 2);

// ───────────────────────── per-question heuristics ─────────────────────────

function pageBlob(state: Json): { blob: string; url: string; title: string; h1: string; snippet: string } {
  const page = isObj(state.page) ? state.page : isObj(state.result) ? state.result : {};
  const title = str(page.title);
  const h1 = str(page.h1);
  const snippet = str(page.meta_description) || str(page.snippet);
  const url = str(page.url);
  return { blob: `${url} ${str(page.domain)} ${title} ${snippet} ${h1} ${str(page.intro)}`.toLowerCase(), url, title, h1, snippet };
}

function answerFor(id: string, q: Question, state: Json, salt: string): Json {
  const w = (a: number): number => wobble(`${salt}|${id}`, a);

  switch (id) {
    case 'page_type': {
      const { blob, url } = pageBlob(state);
      const { type, cues } = detectType(blob, url);
      const options = keys(q);
      const top = options.includes(type) ? type : (options.includes('other') ? 'other' : (options[0] as string));
      return choiceAnswer(options, top, clamp(0.72 + 0.07 * Math.min(cues, 3) + w(0.05), 0.55, 0.93), RUNNERS[type].filter((r) => options.includes(r)));
    }
    case 'intent_served': {
      const { blob, url } = pageBlob(state);
      const { type } = detectType(blob, url);
      const options = keys(q);
      const intent = INTENT_OF[type];
      const top = options.includes(intent) ? intent : (options[0] as string);
      return choiceAnswer(options, top, clamp(0.68 + w(0.06), 0.5, 0.88), options.filter((o) => o === 'commercial_investigation' || o === 'informational').filter((o) => o !== top));
    }
    case 'targets_query': {
      const { blob, url, title, h1, snippet } = pageBlob(state);
      const cov = coverage(str(state.search_query), `${title} ${h1} ${snippet}`);
      const { type } = detectType(blob, url);
      const notDedicated = type === 'forum_or_social' || type === 'directory_marketplace' || type === 'news_or_media' || type === 'company_homepage';
      // Jev reads literally: a generic page about "сайт" is not *dedicated* to "сайт за клиника", so the curve is steep.
      return noulAnswer((0.08 + 0.85 * cov ** 2.5) * (notDedicated ? 0.55 : 1) + w(0.04));
    }
    case 'local_to_market': {
      const { blob } = pageBlob(state);
      const letters = blob.match(/\p{L}/gu) ?? [];
      const cyr = blob.match(/\p{Script=Cyrillic}/gu) ?? [];
      return noulAnswer(letters.length > 0 && cyr.length / letters.length > 0.5 ? 0.92 : 0.3);
    }

    // content slice
    case 'topic_depth':
    case 'need_satisfied': {
      const outline = list(state.page_outline).filter((l) => /^H[23]:/.test(l)).length;
      const bonus = { 'very short': -1.0, short: -0.4, medium: 0.3, long: 0.8, 'very long': 1.2 }[str(state.length) as 'short'] ?? 0;
      const digits = ((str(state.content_start) + str(state.content_middle)).match(/\d+/g) ?? []).length;
      const depth = clamp(0.6 + 0.2 * outline + bonus + Math.min(0.6, 0.1 * digits) + w(0.15), 0, 4);
      return id === 'topic_depth' ? scoreAnswer(levelsOf(q), depth) : scoreAnswer(levelsOf(q), clamp(0.3 + depth * 0.65, 0, 3));
    }
    case 'generic_content': {
      const text = `${str(state.content_start)} ${str(state.content_middle)}`.toLowerCase();
      const generic = (text.match(/качествен[аои]? услуг|професионалист|достъпни цени|индивидуален подход|лидер на пазара|най-добр[иао]/g) ?? []).length;
      const digits = (text.match(/\d+/g) ?? []).length;
      const shortPenalty = ['very short', 'short'].includes(str(state.length)) ? 0.12 : 0;
      return noulAnswer(0.12 + 0.2 * generic - 0.03 * digits + shortPenalty + w(0.03));
    }

    // trust slice
    case 'states_prices': {
      const n = list(state.price_mentions).filter((m) => /\d/.test(m)).length;
      return noulAnswer(n > 0 ? 0.9 + w(0.04) : 0.08 + w(0.03));
    }
    case 'shows_portfolio': {
      const headings = list(state.headings_about_work_or_clients).length;
      const proof = list(state.social_proof_snippets).filter((s) => /проект|портфолио|клиент/i.test(s)).length;
      return noulAnswer(headings > 0 ? 0.86 : proof > 0 ? 0.5 : 0.08);
    }
    case 'shows_reviews': {
      const proof = list(state.social_proof_snippets).filter((s) => /отзив|доволн|препоръ|★|„/i.test(s)).length;
      return noulAnswer(proof >= 2 ? 0.84 : proof === 1 ? 0.55 : 0.07);
    }
    case 'clear_cta': {
      const n = list(state.call_to_action_texts).length;
      return noulAnswer(n >= 2 ? 0.92 : n === 1 ? 0.66 : 0.07);
    }
    case 'shows_identity': {
      const hints = isObj(state.identity_hints) ? Object.values(state.identity_hints).filter((v) => v === true).length : 0;
      return noulAnswer(hints >= 3 ? 0.9 : hints === 2 ? 0.72 : hints === 1 ? 0.4 : 0.08);
    }

    // keyword slice
    case 'relevant_to_business': {
      const query = (str(state.search_query) || str(state.buyer_question)).toLowerCase();
      if (/безплатн|рецепт|курс|обучени|работа|свободни позиции|pdf|изтегл|скандал|ваканци/.test(query)) return noulAnswer(0.16 + w(0.04));
      if (/сайт|уеб|web|магазин|дизайн|seo|оптимизац|wordpress|разработк|изработк/.test(query)) return noulAnswer(0.9 + w(0.04));
      return noulAnswer(coverage(query, str(state.business)) > 0.3 ? 0.7 : 0.34);
    }
    case 'query_intent': {
      const query = str(state.search_query).toLowerCase();
      const options = keys(q);
      const pick = (intent: string, p: number, runners: string[]): Json => choiceAnswer(options, options.includes(intent) ? intent : (options[0] as string), p, runners.filter((r) => options.includes(r)));
      if (/^(как|какво|защо|кога|къде|може ли|трябва ли)\b|как да/.test(query)) return pick('informational', 0.78, ['commercial_investigation']);
      if (/цена|цени|колко струва|оферта|поръчай|фирма|фирми|агенция|услуг|изработка/.test(query)) return pick('transactional', 0.7, ['commercial_investigation', 'local']);
      if (/отзиви|сравнение|най-добр|топ \d+/.test(query)) return pick('commercial_investigation', 0.72, ['transactional']);
      if (/софия|пловдив|варна|бургас|русе|стара загора|плевен/.test(query)) return pick('local', 0.6, ['transactional']);
      return pick('commercial_investigation', 0.55, ['transactional', 'informational']);
    }
    case 'commercial_value': {
      const query = str(state.search_query).toLowerCase();
      let raw = 1.6;
      if (/^(как|какво|защо|кога)\b|как да|безплатн/.test(query)) raw = 0.6;
      else if (/цена|цени|колко струва|оферта|поръчай|фирма|агенция/.test(query)) raw = 2.7;
      else if (/софия|пловдив|варна|бургас|русе|стара загора|плевен/.test(query)) raw = 2.4;
      else if (/отзиви|сравнение|най-добр/.test(query)) raw = 1.9;
      return scoreAnswer(levelsOf(q), raw + w(0.1));
    }

    // ── whole-site audit: SEO elements ──
    case 'title_clear':
    case 'title_specific': {
      const page = isObj(state.page) ? state.page : {};
      const title = str(page.title);
      if (!title) return noulAnswer(0.05);
      const phrase = str(state.search_phrase);
      const cov = phrase ? coverage(phrase, title) : 0.6;
      const slogan = /добре дошли|^начало|^home|welcome|официален сайт/i.test(title) ? 0.35 : 0;
      const brandOnly = title.split(/\s+/).length <= 2 ? 0.2 : 0;
      return noulAnswer(0.22 + 0.7 * cov - slogan - brandOnly + (id === 'title_specific' ? -0.05 : 0.03) + w(0.04));
    }
    case 'meta_inviting': {
      const page = isObj(state.page) ? state.page : {};
      const meta = str(page.meta_description);
      if (!meta) return noulAnswer(0.05);
      const cta = /оферт|безплатн|поръчай|поръчайте|свържи|цена|цени|от \d+|гаранци|консултаци|срок/i.test(meta) ? 0.3 : 0;
      return noulAnswer(0.28 + (meta.length >= 70 ? 0.25 : 0) + cta + w(0.05));
    }
    case 'h1_matches': {
      const page = isObj(state.page) ? state.page : {};
      const h1 = str(page.h1);
      if (!h1) return noulAnswer(0.05);
      const phrase = str(state.search_phrase);
      return noulAnswer(0.18 + 0.78 * (phrase ? coverage(phrase, h1) : 0.6) + w(0.04));
    }
    case 'intro_direct': {
      const page = isObj(state.page) ? state.page : {};
      const intro = str(page.first_paragraph);
      if (/^(добре дошли|здравейте|в днешния|нашата компания|ние сме)/i.test(intro.trim())) return noulAnswer(0.14 + w(0.04));
      const concrete = /\d|струва|включва|срок|правим|изработваме|предлагаме|за \d+ (дни|седмици)/i.test(intro);
      return noulAnswer((concrete ? 0.8 : 0.42) + w(0.05));
    }
    case 'outline_logical': {
      const page = isObj(state.page) ? state.page : {};
      const n = list(page.subheadings).length;
      return scoreAnswer(levelsOf(q), (n === 0 ? 0.4 : n <= 2 ? 1.4 : n <= 5 ? 2.6 : 3.2) + w(0.15));
    }
    case 'faq_useful': {
      const qs = list(state.faq_questions);
      const real = qs.filter((x) => /цена|колко|срок|гаранци|как |поддръжка|включва/i.test(x)).length;
      return noulAnswer(qs.length >= 3 && real >= 2 ? 0.84 : qs.length >= 3 ? 0.58 : 0.4);
    }

    // ── whole-site audit: citability ──
    case 'answer_first': {
      const opening = str(state.opening);
      const topic = str(state.topic);
      if (/^(добре дошли|здравейте|в днешния|нашата компания|ние сме)/i.test(opening.trim())) return scoreAnswer(levelsOf(q), 0.7 + w(0.2));
      const digits = (opening.slice(0, 320).match(/\d+/g) ?? []).length;
      const cov = topic ? coverage(topic, opening.slice(0, 320)) : 0.4;
      return scoreAnswer(levelsOf(q), clamp(0.9 + 1.7 * cov + Math.min(1.1, digits * 0.4) + w(0.2), 0, 4));
    }
    case 'specific_facts': {
      const text = `${str(state.opening)} ${str(state.sample_from_the_middle)}`;
      const digits = (text.match(/\d+/g) ?? []).length;
      const generic = (text.toLowerCase().match(/качествен[аои]? услуг|професионалист|достъпни цени|индивидуален подход|лидер на пазара|най-добр[иао]/g) ?? []).length;
      return scoreAnswer(levelsOf(q), clamp(0.7 + Math.min(2.8, digits * 0.35) - generic * 0.5 + w(0.2), 0, 4));
    }
    case 'cites_sources': {
      const bucket = str(state.other_sites_linked);
      const text = `${str(state.opening)} ${str(state.sample_from_the_middle)}`.toLowerCase();
      const base = { none: 0.1, few: 0.35, several: 0.65, many: 0.85 }[bucket as 'few'] ?? 0.2;
      return noulAnswer(base + (/според|по данни на|източник|изследване|проучване/.test(text) ? 0.1 : 0) + w(0.03));
    }

    // ── whole-site audit: does the page answer a buyer's question? ──
    case 'answers_question': {
      const page = isObj(state.page) ? state.page : {};
      const question = str(state.buyer_question);
      const head = `${str(page.title)} ${str(page.h1)} ${list(page.subheadings).join(' ')}`;
      const cov = 0.65 * coverage(question, head) + 0.35 * coverage(question, str(page.most_relevant_passage));
      return scoreAnswer(levelsOf(q), clamp(4.3 * cov ** 1.15 + w(0.2), 0, 4));
    }
    case 'angle_fits': {
      const page = isObj(state.page) ? state.page : {};
      const question = str(state.buyer_question).toLowerCase();
      const text = `${str(page.title)} ${str(page.h1)} ${list(page.subheadings).join(' ')} ${str(page.most_relevant_passage)}`.toLowerCase();
      if (/разлика|сравн|срещу|\bvs\b|по-добър|алтернатив|или /.test(question)) return noulAnswer(/сравнен|срещу|\bvs\b|разлика|алтернатив/.test(text) ? 0.84 : 0.24);
      if (/колко струва|цена|цени|струва|такса/.test(question)) return noulAnswer(/цена|цени|лв|€|струва/.test(text) ? 0.84 : 0.28);
      if (/^как |как да|как се|стъпки/.test(question)) return noulAnswer(/как |стъпки|ръководство|процес/.test(text) ? 0.8 : 0.38);
      return noulAnswer(0.58 + w(0.08));
    }

    // ── whole-site audit: buyer questions ──
    case 'question_stage': {
      const question = str(state.buyer_question).toLowerCase();
      const options = keys(q);
      const pick = (stage: string, p: number, runners: string[]): Json => choiceAnswer(options, options.includes(stage) ? stage : (options[0] as string), p, runners.filter((r) => options.includes(r)));
      if (/колко струва|цена|цени|струва|такса|абонамент|евро|лв/.test(question)) return pick('price', 0.78, ['compare', 'discover']);
      if (/софия|пловдив|варна|бургас|русе|плевен|стара загора|близо до|в моя град/.test(question)) return pick('local', 0.72, ['discover']);
      if (/разлика|сравн|срещу|\bvs\b|по-добър|най-добр|топ \d+|алтернатив| или /.test(question)) return pick('compare', 0.74, ['discover', 'trust']);
      if (/надежден|сигурен|отзиви|мнения|гаранция|измама|доверие|качествен/.test(question)) return pick('trust', 0.72, ['compare']);
      if (/^как |как да|как се|какво е|стъпки|ръководство|може ли|трябва ли|нужен ли/.test(question)) return pick('howto', 0.74, ['discover']);
      return pick('discover', 0.62, ['compare', 'howto']);
    }
    case 'recommendation': {
      const brand = str(state.brand).toLowerCase();
      const answer = str(state.assistant_answer).toLowerCase();
      const options = keys(q);
      const pick = (v: string, p: number, runners: string[]): Json => choiceAnswer(options, options.includes(v) ? v : (options[0] as string), p, runners.filter((r) => options.includes(r)));
      const at = brand ? answer.indexOf(brand) : -1;
      if (at < 0) return pick('not_mentioned', 0.92, ['mentioned_neutral']);
      const around = answer.slice(Math.max(0, at - 160), at + brand.length + 220);
      if (/не препоръч|избягвай|внимание|проблем|жалби|измама/.test(around)) return pick('discouraged', 0.66, ['mentioned_neutral']);
      if (/препоръч|най-добър|добър избор|силен избор|надежден|отличен|водещ/.test(around)) return pick('recommended', 0.72, ['mentioned_neutral']);
      return pick('mentioned_neutral', 0.62, ['recommended']);
    }

    default:
      // Unknown question: stay neutral rather than inventing a decision.
      if (q.type === 'noul') return noulAnswer(0.5);
      if (q.type === 'choice') return choiceAnswer(keys(q), keys(q)[0] as string, 1 / keys(q).length, []);
      return scoreAnswer(levelsOf(q), (levelsOf(q) - 1) / 2);
  }
}

/** Rough token estimate (≈4 characters per token) so the demo shows believable usage and cost. */
const estimateTokens = (value: unknown): number => Math.ceil(JSON.stringify(value).length / 4);

export function createMockTransport(): SystemOneTransport {
  return {
    async systemOne(request) {
      const state = isObj(request.state) ? request.state : {};
      const salt = JSON.stringify(request.state).slice(0, 400);
      const answers: Record<string, unknown> = {};
      for (const [id, question] of Object.entries(request.questions as Questions)) {
        // the reversed twin of a debiased choice gets the same heuristic answer as the original
        answers[id] = answerFor(id.replace(/__rev$/, ''), question, state, salt);
      }
      return {
        model: 'jev-demo (mock)',
        answers,
        usage: { input_tokens: estimateTokens(request.state) + estimateTokens(request.questions), output_tokens: 20 },
      };
    },
  };
}

/**
 * A `fetch` that answers TypeSafe requests with the mock. Plugging it into the official SDK means demo mode
 * and tests exercise the real request building, retries and response handling — only the network is faked.
 */
export function createMockFetch(transport: SystemOneTransport = createMockTransport()) {
  return async (_url: string, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { state?: unknown; questions?: Questions; model?: string };
    const result = await transport.systemOne({ state: body.state as never, questions: body.questions ?? {}, ...(body.model ? { model: body.model } : {}) });
    return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}
