import { ENGINE_IDS, ENGINE_LABELS, type EngineId } from '../../../shared/domain';
import { fnv1a, mulberry32 } from '../../util/hash';
import { AnswerCollector, EngineError, type AnswerEngine, type AskOptions, type EngineAnswer, type GenerateRequest, type GenerateResult } from './types';

// Three deterministic stand-ins for ChatGPT, Claude and Gemini, used by the demo mode and by tests. They never touch
// the network and never wait: the latency they report is made up, not slept. Everything an answer contains is a pure
// function of (seed, engine, question), so repeated runs agree and a demo report is reproducible.
//
// They are NOT the assistants and say so everywhere they are shown (model "демо"). Their job is to make the whole
// visibility check explorable without a key: some questions are answered with the business's own site among the
// sources, most are not, and each assistant leans toward a different kind of source.

export type DemoSourceKind = 'authority' | 'compare' | 'brand' | 'community' | 'media' | 'guide' | 'other';

export interface DemoCompetitor {
  domain: string;
  url: string;
  title: string;
  kind: DemoSourceKind;
}

export interface DemoEngineInput {
  ownDomain: string;
  brandNames: readonly string[];
  competitors: readonly DemoCompetitor[];
  seed?: string;
}

interface Profile {
  /** Source kinds this assistant cites more often. */
  favours: readonly DemoSourceKind[];
  /** Share of questions whose answer cites the business's own site. Each stays inside 22–34%. */
  ownShare: number;
}

const PROFILES: Record<EngineId, Profile> = {
  openai: { favours: ['authority', 'guide'], ownShare: 0.27 },
  anthropic: { favours: ['compare', 'guide'], ownShare: 0.31 },
  gemini: { favours: ['brand', 'media'], ownShare: 0.29 },
};

const DEMO_MODEL = 'демо';
const FAVOURED_WEIGHT = 4;

export function createDemoEngines(input: DemoEngineInput): AnswerEngine[] {
  const seed = input.seed ?? 'demo';
  const ownHost = hostOf(input.ownDomain);
  const own = ownHost === '' ? null : { host: ownHost, url: `https://${ownHost}/`, brand: input.brandNames.map((b) => b.trim()).find(Boolean) ?? brandOf(ownHost) };
  // Only competitors that can be cited: an http(s) page on a named domain, each page once.
  const seen = new Set<string>();
  const pool = input.competitors.flatMap((c): DemoCompetitor[] => {
    const domain = c.domain.trim().toLowerCase();
    if (domain === '' || !/^https?:\/\//i.test(c.url) || seen.has(c.url)) return [];
    seen.add(c.url);
    return [{ ...c, domain }];
  });
  return ENGINE_IDS.map((id) => demoEngine(id, seed, pool, own));
}

interface Own {
  host: string;
  url: string;
  brand: string;
}

function demoEngine(id: EngineId, seed: string, pool: readonly DemoCompetitor[], own: Own | null): AnswerEngine {
  const profile = PROFILES[id];
  return {
    id,
    label: ENGINE_LABELS[id],
    model: DEMO_MODEL,

    async ask(question: string, options: AskOptions): Promise<EngineAnswer> {
      if (options.signal?.aborted) throw new EngineError('aborted', `${ENGINE_LABELS[id]}: заявката е прекратена.`);
      const rand = mulberry32(fnv1a(`${seed}|${id}|${question}`));

      const latencyMs = 700 + Math.floor(rand() * 3500);
      const ownCited = own !== null && rand() < profile.ownShare;
      // 3-5 sources from the competitors; the business's own site, when it is cited, is one of at most 5 in all (so 3-4 competitors then).
      const cited = pick(pool, 3 + Math.floor(rand() * (ownCited ? 2 : 3)), profile.favours, rand);
      const consulted = pick(
        pool.filter((c) => !cited.includes(c)),
        1 + Math.floor(rand() * 3),
        [],
        rand,
      );

      // The business's own site takes a random place among the sources, not always the first.
      const sources: Array<{ url: string; title: string; domain: string }> = cited.map((c) => ({ url: c.url, title: c.title, domain: c.domain }));
      if (own && ownCited) sources.splice(Math.floor(rand() * (sources.length + 1)), 0, { url: own.url, title: own.brand, domain: own.host });

      const names = uniqueNames(cited.map(brandFor));
      const named = names.slice(0, Math.min(names.length, 2 + (rand() < 0.5 ? 1 : 0)));
      const introVariant = Math.floor(rand() * 2);
      const ownVariant = Math.floor(rand() * 3);
      const queries = deriveQueries(question, rand);
      const nearMiss = own !== null && !ownCited && rand() < 0.18; // the engine read the business's site but did not cite it
      const inputTokens = 1500 + Math.floor(rand() * 5500);
      const outputTokens = 280 + Math.floor(rand() * 700);

      const out = new AnswerCollector();
      out.appendText(compose(id, questionKind(question), named, ownCited && own ? own.brand : null, introVariant, ownVariant));
      for (const s of sources) out.cite(s.url, s.title, s.domain);
      for (const c of consulted) out.consult(c.url, c.title, c.domain);
      if (own && nearMiss) out.consult(own.url, own.brand, own.host);
      for (const q of queries) out.query(q);
      return out.build({ searched: true, latencyMs, usage: { inputTokens, outputTokens, searches: queries.length }, model: DEMO_MODEL });
    },

    async generate(request: GenerateRequest): Promise<GenerateResult> {
      if (request.signal?.aborted) throw new EngineError('aborted', `${ENGINE_LABELS[id]}: заявката е прекратена.`);
      const text = request.json
        ? JSON.stringify({ demo: true, note: 'Примерен отговор от демо режима, не е написан от модел.' })
        : `Това е примерен текст от демо режима: не е написан от модел. Заявка: ${request.prompt.replace(/\s+/g, ' ').trim().slice(0, 80)}`;
      return { text, usage: { inputTokens: Math.ceil(request.prompt.length / 4), outputTokens: Math.ceil(text.length / 4) } };
    },
  };
}

/** Draws `count` sources without repeats, preferring favoured kinds and domains not used yet. */
function pick(pool: readonly DemoCompetitor[], count: number, favours: readonly DemoSourceKind[], rand: () => number): DemoCompetitor[] {
  const left = [...pool];
  const chosen: DemoCompetitor[] = [];
  const domains = new Set<string>();
  while (chosen.length < count && left.length > 0) {
    const fresh = left.filter((c) => !domains.has(c.domain));
    const from = fresh.length > 0 ? fresh : left;
    const weights = from.map((c) => (favours.includes(c.kind) ? FAVOURED_WEIGHT : 1));
    let r = rand() * weights.reduce((a, b) => a + b, 0);
    let index = 0;
    while (index < from.length - 1 && (r -= weights[index] ?? 1) >= 0) index++;
    const next = from[index] as DemoCompetitor;
    chosen.push(next);
    domains.add(next.domain);
    left.splice(left.indexOf(next), 1);
  }
  return chosen;
}

/** "https://www.My-Studio.example/path" → "my-studio.example" */
function hostOf(domain: string): string {
  return domain
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/:\d+$/, '')
    .replace(/^www\./, '');
}

/** A readable brand from a domain: "pixel-studio.example" → "Pixel Studio". */
function brandOf(domain: string): string {
  const label = hostOf(domain).split('.')[0] ?? '';
  const words = label.split(/[-_]+/).filter(Boolean);
  return words.length === 0 ? domain : words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/**
 * What a competitor is called in an answer: its title when that is a brand ("Пиксел Студио", or the last part of
 * "Изработка на уебсайт – цени | Пиксел Студио"), else the name its domain suggests.
 */
function brandFor(c: DemoCompetitor): string {
  const parts = c.title.split(/\s+[|–—·•]\s+|\s+-\s+/).map((part) => part.trim());
  const candidate = (parts[parts.length - 1] ?? '').slice(0, 80);
  const host = hostOf(c.domain);
  const isDomain = candidate.toLowerCase().replace(/^www\./, '').startsWith(host);
  const looksLikeBrand = candidate.length >= 2 && candidate.length <= 32 && candidate.split(/\s+/).length <= 4 && !/[?!:;,]/.test(candidate);
  return looksLikeBrand && !isDomain ? candidate : brandOf(c.domain);
}

const uniqueNames = (names: readonly string[]): string[] => [...new Set(names)];

// ───────────────────────── the prose ─────────────────────────

type QuestionKind = 'price' | 'howto' | 'trust' | 'pick' | 'generic';

const KIND_PATTERNS: ReadonlyArray<readonly [QuestionKind, RegExp]> = [
  ['price', /колко струва|цена|цени|струва|how much|price|cost/i],
  ['howto', /как (?:да|се|мога|става)|стъпки|how (?:do|to|can)/i],
  ['trust', /надежд|отзиви|гаранц|доверие|измам|сигурн|reliable|trust|review|scam/i],
  ['pick', /най-добр|препоръч|коя |кои |кой |къде|best|recommend|which|top/i],
];

const questionKind = (question: string): QuestionKind => KIND_PATTERNS.find(([, pattern]) => pattern.test(question))?.[0] ?? 'generic';

const INTRO: Record<QuestionKind, readonly [string, string]> = {
  price: [
    'Точната цена зависи от обхвата на работата, затова е добре да сравните няколко оферти, например от {list}.',
    'Цените се различават значително според изискванията; за ориентир може да погледнете предложенията на {list}.',
  ],
  howto: [
    'Добра отправна точка са подробните ръководства на {list}, които описват процеса стъпка по стъпка.',
    'Най-ясно процесът е описан в материалите на {list}.',
  ],
  trust: [
    'За да прецените колко е надежден един доставчик, прегледайте отзивите и примерите от практиката; полезни са материалите на {list}.',
    'Надеждността се вижда най-добре от реални отзиви и конкретни проекти, каквито има при {list}.',
  ],
  pick: ['Най-често препоръчваните доставчици са {list}.', 'Сред най-често споменаваните варианти са {list}.'],
  generic: ['По този въпрос най-често се цитират {list}.', 'Информация по темата предлагат {list}.'],
};

const OWN_LINE: readonly [string, string, string] = ['Допълнителна информация има и в сайта на {own}.', 'Подробности предлага и {own}.', 'Можете да разгледате и {own}.'];

const CLOSING: Record<EngineId, string> = {
  openai: 'Накратко: сравнете цените, сроковете и отзивите, преди да вземете решение.',
  anthropic: 'Препоръчвам да поискате оферта поне от двама доставчици и да сравните какво точно е включено.',
  gemini: 'Съветът ми е да сравните няколко предложения и да проверите какво включва поддръжката.',
};

const NO_SOURCES = 'Не открих достатъчно ясни източници по този въпрос, затова е добре да сравните няколко доставчика.';

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} и ${names[names.length - 1]}`;
}

function compose(engine: EngineId, kind: QuestionKind, brands: readonly string[], ownBrand: string | null, introVariant: number, ownVariant: number): string {
  const intro = brands.length === 0 ? NO_SOURCES : INTRO[kind][introVariant % 2]!.replace('{list}', joinNames(brands));
  const ownLine = ownBrand === null ? '' : OWN_LINE[ownVariant % 3]!.replace('{own}', ownBrand);
  const closing = CLOSING[engine];
  switch (engine) {
    case 'openai':
      return [intro, ownLine, closing].filter(Boolean).join('\n\n');
    case 'anthropic':
      return [intro, ownLine, closing].filter(Boolean).join(' ');
    case 'gemini':
      return [[intro, ownLine].filter(Boolean).join(' '), closing].join('\n\n');
  }
}

// ───────────────────────── the searches ─────────────────────────

const STOP_WORDS = new Set([
  'какво', 'какви', 'какъв', 'каква', 'кои', 'коя', 'кой', 'колко', 'как', 'къде', 'ли', 'ми', 'да', 'са', 'за', 'на', 'във', 'със', 'при', 'или', 'най',
  'what', 'how', 'which', 'the', 'are', 'does', 'should', 'can', 'for', 'and', 'with', 'best', 'much',
]);

/** One to three search queries a person (or an assistant) might type, built from the words of the question. */
function deriveQueries(question: string, rand: () => number): string[] {
  const words = question
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const content = words.filter((w) => w.length > 2 && !STOP_WORDS.has(w));
  const cyrillic = /\p{Script=Cyrillic}/u.test(question);
  const queries = [words.slice(0, 9).join(' ')];
  if (rand() < 0.7) queries.push(`${content.slice(0, 4).join(' ')} ${cyrillic ? ['цена', 'отзиви', 'препоръки'][Math.floor(rand() * 3)] : ['price', 'reviews', 'recommendations'][Math.floor(rand() * 3)]}`);
  if (rand() < 0.35) queries.push(`${content.slice(-3).join(' ')} ${cyrillic ? 'сравнение' : 'comparison'}`);
  const usable = queries.map((q) => q.trim()).filter((q) => q.length > 0);
  return usable.length > 0 ? usable : [question.trim() || 'демо заявка'];
}
