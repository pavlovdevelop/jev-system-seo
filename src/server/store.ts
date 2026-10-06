import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SiteAuditReportSchema, type SiteAuditListItem, type SiteAuditReport } from '../shared/audit';
import {
  ReportSchema,
  SettingsSchema,
  type CompetitorOverviewRow,
  type Report,
  type ReportSummary,
  type Settings,
  type SettingsPatch,
  type TrackedCompetitor,
} from '../shared/schemas';
import { ID_PATTERN } from '../shared/ids';
import { domainOf } from './providers/serp/types';

// File-based storage: one JSON file per report, a small index for fast listing, and a settings file.
// A single user's research tool does not need a database; the Store interface is the seam if that changes.

export interface IndexDigest {
  domain: string;
  role: 'own' | 'tracked' | 'discovered';
  keywordsSeen: number;
  top3: number;
  shareOfVoice: number;
  bestPosition: number | null;
}

export interface IndexEntry extends ReportSummary {
  digest: IndexDigest[];
}

export { ID_PATTERN };
export const newId = (prefix: 'r' | 'j' | 'a'): string => `${prefix}_${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  await writeFile(tmp, JSON.stringify(value), { encoding: 'utf-8', mode: 0o600 });
  await rename(tmp, file);
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, 'utf-8')) as T;
  } catch {
    return null;
  }
}

export function summarize(report: Report): IndexEntry {
  const opportunities = report.opportunities.filter((o) => !o.deep);
  return {
    id: report.id,
    keyword: report.seed.keyword,
    market: report.request.market,
    mode: report.mode,
    status: report.status,
    createdAt: report.createdAt,
    quickWins: opportunities.filter((o) => o.label === 'quick_win').length,
    opportunities: opportunities.length,
    difficulty: report.seed.assessment?.difficulty ?? null,
    topDomain: report.seed.serp.results[0]?.domain ?? null,
    digest: report.competitors.map((c) => ({
      domain: c.domain,
      role: c.role,
      keywordsSeen: c.visibility.keywordsSeen,
      top3: c.visibility.top3,
      shareOfVoice: c.visibility.shareOfVoice,
      bestPosition: c.visibility.bestPosition,
    })),
  };
}

export function summarizeAudit(report: SiteAuditReport): SiteAuditListItem {
  return {
    id: report.id,
    domain: report.site.domain,
    market: report.request.market,
    mode: report.mode,
    status: report.status,
    createdAt: report.createdAt,
    pagesAudited: report.site.pagesAudited,
    figures: report.figures,
  };
}

export class Store {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly dir: string) {}

  /** Serialises writes so concurrent jobs cannot clobber the index or the settings file. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private get reportsDir(): string {
    return join(this.dir, 'reports');
  }
  private get indexFile(): string {
    return join(this.reportsDir, '_index.json');
  }
  private get auditsDir(): string {
    return join(this.dir, 'audits');
  }
  private get auditIndexFile(): string {
    return join(this.auditsDir, '_index.json');
  }
  private get settingsFile(): string {
    return join(this.dir, 'settings.json');
  }

  async init(): Promise<void> {
    await mkdir(this.reportsDir, { recursive: true, mode: 0o700 });
    await mkdir(this.auditsDir, { recursive: true, mode: 0o700 });
  }

  // ───────────── settings & competitor registry ─────────────

  async getSettings(): Promise<Settings> {
    const raw = await readJson<unknown>(this.settingsFile);
    const parsed = SettingsSchema.safeParse(raw ?? {});
    return parsed.success ? parsed.data : SettingsSchema.parse({});
  }

  async updateSettings(patch: SettingsPatch): Promise<Settings> {
    return this.exclusive(async () => {
      const current = await this.getSettings();
      const next = SettingsSchema.parse({ ...current, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) });
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      await writeJsonAtomic(this.settingsFile, next);
      return next;
    });
  }

  async addCompetitor(domain: string, note = ''): Promise<Settings> {
    return this.exclusive(async () => {
      const current = await this.getSettings();
      const normalized = domainOf(`https://${domain}`);
      if (current.competitors.some((c) => domainOf(`https://${c.domain}`) === normalized)) return current;
      const entry: TrackedCompetitor = { domain: normalized, note: note.trim().slice(0, 200), addedAt: new Date().toISOString() };
      const next = SettingsSchema.parse({ ...current, competitors: [...current.competitors, entry] });
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      await writeJsonAtomic(this.settingsFile, next);
      return next;
    });
  }

  async removeCompetitor(domain: string): Promise<Settings> {
    return this.exclusive(async () => {
      const current = await this.getSettings();
      const normalized = domainOf(`https://${domain}`);
      const next = SettingsSchema.parse({ ...current, competitors: current.competitors.filter((c) => domainOf(`https://${c.domain}`) !== normalized) });
      await writeJsonAtomic(this.settingsFile, next);
      return next;
    });
  }

  // ───────────── reports ─────────────

  async saveReport(report: Report): Promise<void> {
    await this.exclusive(async () => {
      await mkdir(this.reportsDir, { recursive: true, mode: 0o700 });
      await writeJsonAtomic(join(this.reportsDir, `${report.id}.json`), report);
      const index = await this.loadIndex();
      const next = [summarize(report), ...index.filter((e) => e.id !== report.id)];
      await writeJsonAtomic(this.indexFile, next);
    });
  }

  async getReport(id: string): Promise<Report | null> {
    if (!ID_PATTERN.test(id)) return null;
    const raw = await readJson<unknown>(join(this.reportsDir, `${id}.json`));
    if (!raw) return null;
    const parsed = ReportSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  }

  async deleteReport(id: string): Promise<boolean> {
    if (!ID_PATTERN.test(id)) return false;
    return this.exclusive(async () => {
      const file = join(this.reportsDir, `${id}.json`);
      const existed = (await readJson<unknown>(file)) !== null;
      await rm(file, { force: true });
      const index = await this.loadIndex();
      await writeJsonAtomic(this.indexFile, index.filter((e) => e.id !== id));
      return existed;
    });
  }

  async listReports(): Promise<ReportSummary[]> {
    const index = await this.loadIndex();
    return index.map(({ digest: _digest, ...summary }) => summary).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** The index is a cache: if it is missing or damaged it is rebuilt from the report files. */
  private async loadIndex(): Promise<IndexEntry[]> {
    const cached = await readJson<IndexEntry[]>(this.indexFile);
    if (Array.isArray(cached)) return cached;
    const rebuilt: IndexEntry[] = [];
    let files: string[] = [];
    try {
      files = await readdir(this.reportsDir);
    } catch {
      return [];
    }
    for (const f of files) {
      if (!f.endsWith('.json') || f.startsWith('_')) continue;
      const parsed = ReportSchema.safeParse(await readJson<unknown>(join(this.reportsDir, f)));
      if (parsed.success) rebuilt.push(summarize(parsed.data));
    }
    return rebuilt;
  }

  // ───────────── site audits ─────────────

  async saveAudit(report: SiteAuditReport): Promise<void> {
    await this.exclusive(async () => {
      await mkdir(this.auditsDir, { recursive: true, mode: 0o700 });
      await writeJsonAtomic(join(this.auditsDir, `${report.id}.json`), report);
      const index = await this.loadAuditIndex();
      await writeJsonAtomic(this.auditIndexFile, [summarizeAudit(report), ...index.filter((e) => e.id !== report.id)]);
    });
  }

  async getAudit(id: string): Promise<SiteAuditReport | null> {
    if (!ID_PATTERN.test(id)) return null;
    const raw = await readJson<unknown>(join(this.auditsDir, `${id}.json`));
    if (!raw) return null;
    const parsed = SiteAuditReportSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  }

  async deleteAudit(id: string): Promise<boolean> {
    if (!ID_PATTERN.test(id)) return false;
    return this.exclusive(async () => {
      const file = join(this.auditsDir, `${id}.json`);
      const existed = (await readJson<unknown>(file)) !== null;
      await rm(file, { force: true });
      const index = await this.loadAuditIndex();
      await writeJsonAtomic(this.auditIndexFile, index.filter((e) => e.id !== id));
      return existed;
    });
  }

  async listAudits(): Promise<SiteAuditListItem[]> {
    return (await this.loadAuditIndex()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** The index is a cache: if it is missing or damaged it is rebuilt from the audit files. */
  private async loadAuditIndex(): Promise<SiteAuditListItem[]> {
    const cached = await readJson<SiteAuditListItem[]>(this.auditIndexFile);
    if (Array.isArray(cached)) return cached;
    let files: string[] = [];
    try {
      files = await readdir(this.auditsDir);
    } catch {
      return [];
    }
    const rebuilt: SiteAuditListItem[] = [];
    for (const f of files) {
      if (!f.endsWith('.json') || f.startsWith('_')) continue;
      const parsed = SiteAuditReportSchema.safeParse(await readJson<unknown>(join(this.auditsDir, f)));
      if (parsed.success) rebuilt.push(summarizeAudit(parsed.data));
    }
    return rebuilt;
  }

  /** Competitors across every saved report: who keeps showing up, how visible, and since when. */
  async competitorOverview(): Promise<CompetitorOverviewRow[]> {
    const [index, settings] = await Promise.all([this.loadIndex(), this.getSettings()]);
    const tracked = new Set(settings.competitors.map((c) => domainOf(`https://${c.domain}`)));
    const own = settings.ownDomain ? domainOf(`https://${settings.ownDomain}`) : null;

    const rows = new Map<string, { reports: number; keywords: number; share: number; best: number | null; last: string }>();
    for (const entry of index) {
      for (const d of entry.digest) {
        const row = rows.get(d.domain) ?? { reports: 0, keywords: 0, share: 0, best: null, last: entry.createdAt };
        row.reports++;
        row.keywords += d.keywordsSeen;
        row.share += d.shareOfVoice;
        row.best = d.bestPosition === null ? row.best : row.best === null ? d.bestPosition : Math.min(row.best, d.bestPosition);
        if (entry.createdAt > row.last) row.last = entry.createdAt;
        rows.set(d.domain, row);
      }
    }
    for (const d of tracked) if (!rows.has(d)) rows.set(d, { reports: 0, keywords: 0, share: 0, best: null, last: '' });

    return [...rows.entries()]
      .map(([domain, r]) => ({
        domain,
        tracked: tracked.has(domain),
        own: domain === own,
        reports: r.reports,
        keywordsSeen: r.keywords,
        avgShareOfVoice: r.reports > 0 ? Math.round((r.share / r.reports) * 1000) / 1000 : 0,
        bestPosition: r.best,
        lastSeen: r.last,
      }))
      .sort((a, b) => Number(b.own) - Number(a.own) || Number(b.tracked) - Number(a.tracked) || b.avgShareOfVoice - a.avgShareOfVoice || a.domain.localeCompare(b.domain));
  }
}
