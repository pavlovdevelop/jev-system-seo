import type {
  AnalyzeRequestInput,
  CompetitorOverviewRow,
  JobState,
  Report,
  ReportSummary,
  Settings,
  SettingsPatch,
  StatusResponse,
} from '../../shared/schemas';

export interface DemoDefaults {
  keyword: string;
  businessDescription: string;
  ownDomain: string;
  competitors: string[];
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** The custom header is what protects state-changing calls from cross-site requests (see server CSRF check). */
async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { 'x-requested-with': 'jev-seo-radar', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(res.status, err?.code ?? 'error', err?.message ?? (res.status === 401 ? 'Необходима е парола.' : `Грешка ${res.status}`));
  }
  return data as T;
}

export const api = {
  status: () => request<StatusResponse>('GET', '/api/status'),
  settings: () => request<{ settings: Settings; demoDefaults: DemoDefaults | null }>('GET', '/api/settings'),
  saveSettings: (patch: SettingsPatch) => request<{ settings: Settings }>('PUT', '/api/settings', patch),
  addCompetitor: (domain: string, note = '') => request<{ settings: Settings }>('POST', '/api/competitors', { domain, note }),
  removeCompetitor: (domain: string) => request<{ settings: Settings }>('DELETE', `/api/competitors/${encodeURIComponent(domain)}`),
  competitorOverview: () => request<{ competitors: CompetitorOverviewRow[] }>('GET', '/api/competitors/overview'),
  startAnalysis: (body: AnalyzeRequestInput) => request<{ job: JobState }>('POST', '/api/analyses', body),
  job: (id: string) => request<{ job: JobState }>('GET', `/api/jobs/${encodeURIComponent(id)}`),
  cancelJob: (id: string) => request<{ ok: true }>('DELETE', `/api/jobs/${encodeURIComponent(id)}`),
  reports: () => request<{ reports: ReportSummary[] }>('GET', '/api/reports'),
  report: (id: string) => request<{ report: Report }>('GET', `/api/reports/${encodeURIComponent(id)}`),
  deleteReport: (id: string) => request<{ ok: true }>('DELETE', `/api/reports/${encodeURIComponent(id)}`),
  exportUrl: (id: string, format: 'json' | 'csv' | 'md') => `/api/reports/${encodeURIComponent(id)}/export?format=${format}`,
};
