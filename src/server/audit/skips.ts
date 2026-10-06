import type { CriteriaScores, SkipReason, SourceKind, WinnerPage } from '../../shared/audit';
import type { PageType } from '../../shared/domain';
import type { PageMetrics } from '../../shared/schemas';
import { citabilityIndex, schemaRichness, score10 } from './criteria';
import type { JudgedPage } from './page-judge';

// Why an AI assistant skips a page of ours, and why it cites someone else's. All of it is arithmetic on the
// criteria that Jev and the extractor produced: no further model calls.

const AUTHORITY_HOST = /(^|\.)(wikipedia\.org|gov\.[a-z]{2}|[a-z0-9-]+\.gov|\.edu|europa\.eu|who\.int|nih\.gov|pubmed|ncbi\.nlm\.nih\.gov|bds\.bg|nsi\.bg|government\.bg)$/i;
const COMMUNITY_HOST = /(^|\.)(reddit\.com|quora\.com|facebook\.com|stackexchange\.com|stackoverflow\.com|forum\.|answers\.)/i;

/** What kind of source a cited page is, from its address, its type and how it reads. */
export function sourceKindOf(input: { domain: string; type: PageType | null; criteria: CriteriaScores | null }): SourceKind {
  const { domain, type, criteria } = input;
  if (AUTHORITY_HOST.test(domain)) return 'authority';
  if (COMMUNITY_HOST.test(domain) || type === 'forum_or_social') return 'community';
  if (type === 'news_or_media') return 'media';
  if (type === 'comparison_listicle' || type === 'directory_marketplace') return 'compare';
  if (type === 'blog_article') return (criteria?.sources ?? 0) >= 0.7 && (criteria?.author ?? 0) >= 0.6 ? 'authority' : 'guide';
  if (type === 'service_page' || type === 'company_homepage' || type === 'ecommerce_product' || type === 'platform_or_tool') return 'brand';
  return 'other';
}

export interface OwnPageFacts {
  url: string;
  words: number | null;
  ageMonths: number | null;
  criteria: CriteriaScores | null;
}

export interface WinnerFacts {
  words: number | null;
  criteria: CriteriaScores | null;
}

/** Why a page loses, most telling reason first (at most four). */
export function skipReasons(input: { own: OwnPageFacts | null; winner: WinnerFacts | null; match: number | null; angleFits: number | null }): SkipReason[] {
  const { own, winner } = input;
  if (!own) return ['no_page'];
  const c = own.criteria;
  const out: Array<[SkipReason, number]> = [];
  const add = (reason: SkipReason, severity: number): void => void out.push([reason, severity]);

  if (input.angleFits !== null && input.angleFits < 0.4) add('wrong_angle', 1 - input.angleFits + 0.2);
  if (c?.answer !== null && c?.answer !== undefined && c.answer < 0.45) add('no_answer_first', 1 - c.answer);
  const thin = own.words !== null && (own.words < 350 || (winner?.words != null && own.words < winner.words * 0.6));
  if (thin) add('too_thin', winner?.words && own.words !== null ? 1 - own.words / winner.words : 0.7);
  if (c?.facts !== null && c?.facts !== undefined && c.facts < 0.4) add('no_data', 1 - c.facts);
  if (c?.author !== null && c?.author !== undefined && c.author < 0.35) add('weak_trust', 1 - c.author);
  if ((own.ageMonths !== null && own.ageMonths >= 18) || (c?.fresh !== null && c?.fresh !== undefined && c.fresh < 0.4)) add('outdated', c?.fresh !== null && c?.fresh !== undefined ? 1 - c.fresh : 0.6);

  if (out.length === 0) {
    // nothing is badly wrong: name the weakest of the three that matter most
    const weakest = (['answer', 'facts', 'sources'] as const)
      .map((k) => [k, c?.[k] ?? null] as const)
      .filter((x): x is readonly [(typeof x)[0], number] => x[1] !== null)
      .sort((a, b) => a[1] - b[1])[0];
    if (weakest) add(weakest[0] === 'answer' ? 'no_answer_first' : weakest[0] === 'facts' ? 'no_data' : 'weak_trust', 0.3);
    else add('too_thin', 0.2);
  }
  return out.sort((a, b) => b[1] - a[1]).slice(0, 4).map(([r]) => r);
}

/** Make a new page, or rework the one we have? A page with the wrong angle is a new page in all but name. */
export function actionFor(reasons: readonly SkipReason[], match: number | null): 'create' | 'rewrite' {
  if (reasons.includes('no_page')) return 'create';
  if (reasons.includes('wrong_angle') && (match ?? 0) < 0.45) return 'create';
  return 'rewrite';
}

export const detailOf = (criteria: CriteriaScores | null): { criteria: CriteriaScores; score10: number } | null => {
  if (!criteria) return null;
  const index = citabilityIndex(criteria);
  return index === null ? null : { criteria, score10: score10(index) };
};

/** Plain reasons a page is cited — what it does best, in Bulgarian. */
export function whyCited(criteria: CriteriaScores | null, m: PageMetrics, ageMonths: number | null): string[] {
  const out: string[] = [];
  if (!criteria) return out;
  if ((criteria.answer ?? 0) >= 0.7) out.push('Отговорът е в първите изречения');
  if ((criteria.faq ?? 0) >= 0.8) out.push('Въпроси и отговори с FAQPage schema');
  if ((criteria.compare ?? 0) >= 0.9) out.push('Таблица за сравнение');
  if ((criteria.fresh ?? 0) >= 0.9 && ageMonths !== null) out.push(`Обновена преди ${Math.max(1, Math.round(ageMonths))} мес.`);
  if ((criteria.sources ?? 0) >= 0.6) out.push(`Цитира ${m.externalDomains} външни източника`);
  if ((criteria.facts ?? 0) >= 0.7) out.push('Много конкретни факти и числа');
  if ((criteria.author ?? 0) >= 0.7) out.push('Посочени автор и данни за фирмата');
  if (m.wordCount >= 1200) out.push(`Подробен материал (около ${Math.round(m.wordCount / 100) * 100} думи)`);
  if (schemaRichness(m.schemaTypes) >= 0.75) out.push(`Структурирани данни: ${m.schemaTypes.slice(0, 3).join(', ')}`);
  return out.slice(0, 6);
}

/** A cited page, read, as the report shows it. */
export function winnerPageOf(input: { engine: WinnerPage['engine']; domain: string; url: string; title: string; citedIn: number; judged: JudgedPage | null }): WinnerPage {
  const j = input.judged;
  const m = j?.read.extracted?.metrics ?? null;
  const c = j?.criteria ?? null;
  const index = c ? citabilityIndex(c) : null;
  return {
    engine: input.engine,
    domain: input.domain,
    url: input.url,
    title: input.title.slice(0, 200),
    kind: sourceKindOf({ domain: input.domain, type: j?.type ?? null, criteria: c }),
    citedIn: input.citedIn,
    whyCited: m && c ? whyCited(c, m, j?.ageMonths ?? null) : [],
    radar: { answer: c?.answer ?? null, entity: c?.facts ?? null, faq: c?.faq ?? null, author: c?.author ?? null, fresh: c?.fresh ?? null, sources: c?.sources ?? null },
    score10: index === null ? 0 : score10(index),
    words: m?.wordCount ?? null,
  };
}
