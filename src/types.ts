export interface BlacklistRule {
  id: string;
  kind: "domain" | "url" | "page";
  pattern: string;
  mode: "drop" | "meta-only";
}

export interface Settings {
  paused: boolean;
  blacklist: BlacklistRule[];
}

export interface BlockedEvent {
  id: string;
  url: string;
  title: string;
  blockedAt: string;
  mode: "drop" | "meta-only";
  rule: BlacklistRule;
}

export interface Visit {
  id: string;
  capturedAt: string;
  dwellMs: number;
  scrollDepth: number;
  reason: string;
}

export interface SnapshotVersion {
  id: string;
  capturedAt: string;
  title: string;
  textHash: string;
  excerpt: string;
  wordCount: number;
}

export interface CompactResource {
  id: string;
  normalizedUrl: string;
  host: string;
  latestTitle: string;
  latestExcerpt: string;
  visitCount: number;
  versionCount: number;
  lastSeenAt: string;
  latestHash: string;
  visits: Visit[];
  versions: SnapshotVersion[];
}

export interface ThemeScore {
  keyword: string;
  score: number;
}

export interface ReportStats {
  trackedPages: number;
  blockedEvents: number;
  totalVisits: number;
  totalVersions: number;
}

export interface OngoingResource {
  id: string;
  title: string;
  url: string;
  visitCount: number;
  versionCount: number;
  lastSeenAt: string;
}

export interface DreamReportMeta {
  source: "rule" | "codex";
  model: string;
  authReady: boolean;
  stale: boolean;
}

export type DreamTaskStatus = "pending" | "running" | "completed" | "failed";

export interface DreamTask {
  id: string;
  day: string;
  status: DreamTaskStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  inputHash: string;
  errorMessage?: string;
}

export interface DreamReport {
  generatedAt: string;
  overview: string;
  themes: ThemeScore[];
  ongoingResources: OngoingResource[];
  unfinishedQuestions: string[];
  connections: string[];
  suggestions: string[];
  stats: ReportStats;
  meta: DreamReportMeta;
}

export interface StateSummary {
  currentDay: string;
  availableDays: string[];
  settings: Settings;
  blockedEvents: BlockedEvent[];
  dreamTask?: DreamTask;
  report: DreamReport;
  resources: CompactResource[];
}

export interface CapturePayload {
  url: string;
  title: string;
  textContent: string;
  excerpt: string;
  capturedAt: string;
  dwellMs: number;
  scrollDepth: number;
  reason: string;
  pageSignals: string[];
}

export interface CaptureResponse {
  accepted: boolean;
  reason?: string;
  rule?: BlacklistRule;
  resource?: CompactResource;
  report?: DreamReport;
}

export interface PageStatusResponse {
  url: string;
  normalizedUrl?: string;
  exists: boolean;
  blacklisted: boolean;
  reason?: string;
  rule?: BlacklistRule;
  resource?: CompactResource;
}

export interface DreamTaskCreateResponse {
  created: boolean;
  task: DreamTask;
  message?: string;
}
