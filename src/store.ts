import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import Database from "better-sqlite3";

import { generateDreamReportWithCodex, hasLocalCodexAuth } from "./codex.js";
import { buildDreamReport } from "./report.js";
import type {
  BlacklistRule,
  BlockedEvent,
  CapturePayload,
  CaptureResponse,
  CompactResource,
  DreamReport,
  DreamTask,
  DreamTaskCreateResponse,
  PageStatusResponse,
  Settings,
  SnapshotVersion,
  StateSummary,
  Visit
} from "./types.js";

type SqlValue = string | number | null;

interface AppStateRow {
  paused: number;
}

interface RuleRow {
  id: string;
  kind: string;
  pattern: string;
  mode: string;
}

interface EventAtRow {
  event_at: string;
}

interface BlockedEventRow {
  id: string;
  url: string;
  title: string;
  blocked_at: string;
  mode: string;
  rule_id: string;
  rule_kind: string;
  rule_pattern: string;
}

interface ResourceRow {
  id: string;
  normalized_url: string;
  host: string;
  first_seen_at: string;
  last_seen_at: string;
  visit_count: number;
  version_count: number;
  latest_hash: string;
  latest_title: string;
  latest_excerpt: string;
}

interface CompactResourceRow {
  id: string;
  normalized_url: string;
  host: string;
  last_seen_at: string;
  visit_count: number;
  version_count: number;
  latest_hash: string;
  latest_title: string;
  latest_excerpt: string;
}

interface DayResourceRow {
  id: string;
  normalized_url: string;
  host: string;
  last_seen_at: string;
  latest_hash: string;
  latest_title: string;
  latest_excerpt: string;
}

interface VisitRow {
  id: string;
  captured_at: string;
  dwell_ms: number;
  scroll_depth: number;
  reason: string;
}

interface VersionRow {
  id: string;
  captured_at: string;
  title: string;
  text_hash: string;
  excerpt: string;
  word_count: number;
}

interface DreamReportCacheRow {
  day_key: string;
  input_hash: string;
  generated_at: string;
  model: string;
  payload_json: string;
}

interface DreamTaskRow {
  id: string;
  day_key: string;
  status: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  input_hash: string;
  error_message: string | null;
}

interface SanitizedCapturePayload {
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

const TRACKING_PARAMS = new Set(["fbclid", "gclid", "mc_cid", "mc_eid", "ref", "spm"]);
const DEFAULT_BLACKLIST: BlacklistRule[] = [
  { id: "bank", kind: "domain", pattern: "*.bank.*", mode: "drop" },
  { id: "mail", kind: "domain", pattern: "mail.*", mode: "drop" },
  { id: "webmail", kind: "domain", pattern: "webmail.*", mode: "drop" },
  { id: "auth", kind: "domain", pattern: "*.auth.*", mode: "drop" },
  { id: "checkout", kind: "url", pattern: "*://*/checkout*", mode: "drop" },
  { id: "billing", kind: "url", pattern: "*://*/billing*", mode: "drop" },
  { id: "settings", kind: "url", pattern: "*://*/settings*", mode: "drop" },
  { id: "admin", kind: "url", pattern: "*://*/admin*", mode: "drop" },
  { id: "login", kind: "url", pattern: "*://*/login*", mode: "drop" }
];

const SCHEMA_STATEMENTS = [
  `PRAGMA foreign_keys = ON;`,
  `PRAGMA busy_timeout = 5000;`,
  `CREATE TABLE IF NOT EXISTS app_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    paused INTEGER NOT NULL DEFAULT 0
  );`,
  `CREATE TABLE IF NOT EXISTS blacklist_rules (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    pattern TEXT NOT NULL,
    mode TEXT NOT NULL,
    created_at TEXT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS blocked_events (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    title TEXT NOT NULL,
    blocked_at TEXT NOT NULL,
    mode TEXT NOT NULL,
    rule_id TEXT NOT NULL,
    rule_kind TEXT NOT NULL,
    rule_pattern TEXT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS resources (
    id TEXT PRIMARY KEY,
    normalized_url TEXT NOT NULL UNIQUE,
    host TEXT NOT NULL,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    visit_count INTEGER NOT NULL DEFAULT 0,
    version_count INTEGER NOT NULL DEFAULT 0,
    latest_hash TEXT NOT NULL DEFAULT '',
    latest_title TEXT NOT NULL DEFAULT '',
    latest_excerpt TEXT NOT NULL DEFAULT ''
  );`,
  `CREATE TABLE IF NOT EXISTS visits (
    id TEXT PRIMARY KEY,
    resource_id TEXT NOT NULL,
    captured_at TEXT NOT NULL,
    dwell_ms INTEGER NOT NULL,
    scroll_depth INTEGER NOT NULL,
    reason TEXT NOT NULL,
    FOREIGN KEY(resource_id) REFERENCES resources(id) ON DELETE CASCADE
  );`,
  `CREATE TABLE IF NOT EXISTS snapshot_versions (
    id TEXT PRIMARY KEY,
    resource_id TEXT NOT NULL,
    captured_at TEXT NOT NULL,
    title TEXT NOT NULL,
    text_hash TEXT NOT NULL,
    excerpt TEXT NOT NULL,
    word_count INTEGER NOT NULL,
    FOREIGN KEY(resource_id) REFERENCES resources(id) ON DELETE CASCADE
  );`,
  `CREATE TABLE IF NOT EXISTS dream_reports (
    day_key TEXT PRIMARY KEY,
    input_hash TEXT NOT NULL,
    generated_at TEXT NOT NULL,
    model TEXT NOT NULL,
    payload_json TEXT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS dream_report_tasks (
    id TEXT PRIMARY KEY,
    day_key TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    input_hash TEXT NOT NULL,
    error_message TEXT
  );`,
  `CREATE INDEX IF NOT EXISTS idx_blacklist_rules_created_at ON blacklist_rules(created_at DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_blocked_events_blocked_at ON blocked_events(blocked_at DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_resources_last_seen_at ON resources(last_seen_at DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_visits_resource_captured_at ON visits(resource_id, captured_at DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_versions_resource_captured_at ON snapshot_versions(resource_id, captured_at DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_dream_reports_generated_at ON dream_reports(generated_at DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_dream_report_tasks_day_created_at
    ON dream_report_tasks(day_key, created_at DESC);`
] as const;

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function boolToInt(value: boolean): number {
  return value ? 1 : 0;
}

function normalizeWhitespace(input: string): string {
  return input.trim().replace(/\s+/g, " ");
}

function trimChars(input: string, limit: number): string {
  const chars = [...input];
  return chars.length <= limit ? input : chars.slice(0, limit).join("");
}

function shortHash(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 12);
}

function normalizeTime(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return nowIso();
  }
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? nowIso() : parsed.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function localDayKeyFromTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "";
  }
  const year = parsed.getFullYear();
  const month = `${parsed.getMonth() + 1}`.padStart(2, "0");
  const day = `${parsed.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function resolveActiveDay(requestedDay: string, availableDays: string[]): string {
  const trimmed = requestedDay.trim();
  if (trimmed) {
    const parsed = new Date(`${trimmed}T00:00:00`);
    if (!Number.isNaN(parsed.getTime())) {
      return trimmed;
    }
  }
  if (availableDays[0]) {
    return availableDays[0];
  }
  return localDayKeyFromTimestamp(nowIso());
}

function dayRangeUtc(dayKey: string): { startAt: string; endAt: string } {
  const [yearPart, monthPart, dayPart] = dayKey.split("-");
  const year = Number(yearPart);
  const month = Number(monthPart);
  const day = Number(dayPart);
  const localStart = new Date(year, month - 1, day, 0, 0, 0, 0);
  const localEnd = new Date(year, month - 1, day + 1, 0, 0, 0, 0);
  return {
    startAt: localStart.toISOString().replace(/\.\d{3}Z$/, "Z"),
    endAt: localEnd.toISOString().replace(/\.\d{3}Z$/, "Z")
  };
}

function reverseInPlace<T>(values: T[]): T[] {
  values.reverse();
  return values;
}

function buildDayInputHash(resources: CompactResource[], blockedEvents: BlockedEvent[]): string {
  const payload = JSON.stringify({
    resources: resources.map((resource) => ({
      id: resource.id,
      latestHash: resource.latestHash,
      latestTitle: resource.latestTitle,
      latestExcerpt: resource.latestExcerpt,
      visitCount: resource.visitCount,
      versionCount: resource.versionCount,
      lastSeenAt: resource.lastSeenAt,
      visits: resource.visits.map((visit) => ({
        id: visit.id,
        capturedAt: visit.capturedAt,
        dwellMs: visit.dwellMs,
        scrollDepth: visit.scrollDepth,
        reason: visit.reason
      })),
      versions: resource.versions.map((version) => ({
        id: version.id,
        capturedAt: version.capturedAt,
        title: version.title,
        textHash: version.textHash,
        excerpt: version.excerpt,
        wordCount: version.wordCount
      }))
    })),
    blockedEvents: blockedEvents.map((event) => ({
      id: event.id,
      blockedAt: event.blockedAt,
      mode: event.mode,
      ruleId: event.rule.id,
      ruleKind: event.rule.kind,
      rulePattern: event.rule.pattern
    }))
  });

  return createHash("sha1").update(payload).digest("hex");
}

function parseStoredDreamReport(payload: string): DreamReport | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload) as unknown;
  } catch {
    return undefined;
  }

  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }

  const report = parsed as Partial<DreamReport>;
  if (
    typeof report.generatedAt !== "string" ||
    typeof report.overview !== "string" ||
    !Array.isArray(report.themes) ||
    !Array.isArray(report.ongoingResources) ||
    !Array.isArray(report.unfinishedQuestions) ||
    !Array.isArray(report.connections) ||
    !Array.isArray(report.suggestions) ||
    typeof report.stats !== "object" ||
    report.stats === null
  ) {
    return undefined;
  }

  return report as DreamReport;
}

function firstNonEmpty(...values: string[]): string {
  for (const value of values) {
    if (value.trim()) {
      return value;
    }
  }
  return "";
}

function sanitizeSignals(signals: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const rawSignal of signals) {
    const signal = trimChars(normalizeWhitespace(rawSignal), 40);
    if (!signal || seen.has(signal)) {
      continue;
    }
    output.push(signal);
    seen.add(signal);
    if (output.length === 10) {
      break;
    }
  }
  return output;
}

function pageLooksSensitive(signals: string[]): boolean {
  return signals.some((signal) => signal === "password-input" || signal === "payment-form" || signal === "identity-form");
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

function normalizeUrl(rawUrl: string): string {
  const parsed = new URL(rawUrl);
  parsed.hash = "";

  if (parsed.pathname !== "/" && parsed.pathname.endsWith("/")) {
    parsed.pathname = parsed.pathname.slice(0, -1);
  }

  const entries = [...parsed.searchParams.entries()]
    .filter(([key]) => !key.toLowerCase().startsWith("utm_") && !TRACKING_PARAMS.has(key.toLowerCase()))
    .sort(([left], [right]) => left.localeCompare(right));

  parsed.search = "";
  for (const [key, value] of entries) {
    parsed.searchParams.append(key, value);
  }

  return parsed.toString();
}

function sanitizePayload(input: CapturePayload): SanitizedCapturePayload {
  const url = input.url.trim();
  if (url) {
    new URL(url);
  }

  return {
    url,
    title: trimChars(normalizeWhitespace(input.title || "Untitled page"), 200) || "Untitled page",
    textContent: trimChars(normalizeWhitespace(input.textContent), 20000),
    excerpt: trimChars(normalizeWhitespace(input.excerpt), 400),
    capturedAt: normalizeTime(input.capturedAt),
    dwellMs: Math.max(0, Math.round(input.dwellMs)),
    scrollDepth: Math.max(0, Math.min(100, Math.round(input.scrollDepth))),
    reason: trimChars(normalizeWhitespace(input.reason || "auto"), 40) || "auto",
    pageSignals: sanitizeSignals(input.pageSignals)
  };
}

function matchBlacklist(rules: BlacklistRule[], normalizedUrl: string, pageSignals: string[]): BlacklistRule | undefined {
  if (pageLooksSensitive(pageSignals)) {
    return {
      id: "page-signal",
      kind: "page",
      pattern: "sensitive-signals",
      mode: "drop"
    };
  }

  const host = new URL(normalizedUrl).hostname;
  for (const rule of rules) {
    const pattern = wildcardToRegExp(rule.pattern);
    if (rule.kind === "domain" && pattern.test(host)) {
      return rule;
    }
    if (rule.kind === "url" && pattern.test(normalizedUrl)) {
      return rule;
    }
  }
  return undefined;
}

function mapRuleRow(row: RuleRow): BlacklistRule {
  return {
    id: row.id,
    kind: row.kind === "url" ? "url" : row.kind === "page" ? "page" : "domain",
    pattern: row.pattern,
    mode: row.mode === "meta-only" ? "meta-only" : "drop"
  };
}

function mapVisitRow(row: VisitRow): Visit {
  return {
    id: row.id,
    capturedAt: row.captured_at,
    dwellMs: row.dwell_ms,
    scrollDepth: row.scroll_depth,
    reason: row.reason
  };
}

function mapVersionRow(row: VersionRow): SnapshotVersion {
  return {
    id: row.id,
    capturedAt: row.captured_at,
    title: row.title,
    textHash: row.text_hash,
    excerpt: row.excerpt,
    wordCount: row.word_count
  };
}

function mapDreamTaskRow(row: DreamTaskRow): DreamTask {
  return {
    id: row.id,
    day: row.day_key,
    status:
      row.status === "running"
        ? "running"
        : row.status === "completed"
          ? "completed"
          : row.status === "failed"
            ? "failed"
            : "pending",
    createdAt: row.created_at,
    inputHash: row.input_hash,
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    ...(row.error_message ? { errorMessage: row.error_message } : {})
  };
}

export class Store {
  private readonly db: Database.Database;
  private readonly activeDreamTasks = new Set<string>();

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    const dbPath = join(dataDir, "people-dream.db");
    this.db = new Database(dbPath);
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.initSchema();
    this.recoverInterruptedDreamTasks();
  }

  close(): void {
    this.db.close();
  }

  summarize(requestedDay: string): StateSummary {
    const settings = this.loadSettings();
    const availableDays = this.loadAvailableDays();
    const activeDay = resolveActiveDay(requestedDay, availableDays);
    const { startAt, endAt } = dayRangeUtc(activeDay);
    const blockedEvents = this.loadBlockedEventsForDay(startAt, endAt);
    const resources = this.loadCompactResourcesForDay(startAt, endAt);
    const authReady = hasLocalCodexAuth();
    const inputHash = buildDayInputHash(resources, blockedEvents);
    const cachedDreamReport = this.loadDreamReport(activeDay);
    const stale = cachedDreamReport !== undefined && cachedDreamReport.input_hash !== inputHash;

    let report = buildDreamReport(resources, blockedEvents, { authReady, stale });
    if (cachedDreamReport && cachedDreamReport.input_hash === inputHash) {
      const storedReport = parseStoredDreamReport(cachedDreamReport.payload_json);
      if (storedReport) {
        report = {
          ...storedReport,
          meta: {
            source: "codex",
            model: cachedDreamReport.model,
            authReady,
            stale: false
          }
        };
      }
    }

    const dreamTask = this.loadLatestDreamTaskForDay(activeDay);

    return {
      currentDay: activeDay,
      availableDays,
      settings,
      blockedEvents: blockedEvents.slice(0, 20),
      report,
      resources,
      ...(dreamTask ? { dreamTask } : {})
    };
  }

  createDreamReportTask(requestedDay: string): DreamTaskCreateResponse {
    const availableDays = this.loadAvailableDays();
    const activeDay = resolveActiveDay(requestedDay, availableDays);
    const { startAt, endAt } = dayRangeUtc(activeDay);
    const blockedEvents = this.loadBlockedEventsForDay(startAt, endAt);
    const resources = this.loadCompactResourcesForDay(startAt, endAt);
    const inputHash = buildDayInputHash(resources, blockedEvents);
    const cachedDreamReport = this.loadDreamReport(activeDay);

    if (!hasLocalCodexAuth()) {
      throw new Error("未检测到 Codex 本地登录态，请先在终端运行 codex 完成登录。");
    }
    if (resources.length === 0 && blockedEvents.length === 0) {
      throw new Error("当天还没有可用于梦境推理的浏览数据。");
    }

    const latestTask = this.loadLatestDreamTaskForDay(activeDay);
    if (latestTask && (latestTask.status === "pending" || latestTask.status === "running")) {
      return {
        created: false,
        task: latestTask,
        message: "该日期已有进行中的梦境推理任务。"
      };
    }

    if (latestTask && latestTask.status === "completed" && latestTask.inputHash === inputHash) {
      throw new Error("该日期的梦境推理已经生成过了。");
    }
    if (cachedDreamReport && cachedDreamReport.input_hash === inputHash) {
      throw new Error("该日期的梦境推理已经生成过了。");
    }

    const task = this.insertDreamTask(activeDay, inputHash);
    queueMicrotask(() => {
      void this.runDreamReportTask(task.id);
    });

    return {
      created: true,
      task,
      message: "梦境推理任务已创建。"
    };
  }

  getDreamReportTask(taskId: string): DreamTask {
    const task = this.loadDreamTaskById(taskId);
    if (!task) {
      throw new Error("dream task not found");
    }
    return task;
  }

  processCapture(input: CapturePayload): CaptureResponse {
    const payload = sanitizePayload(input);
    if (!payload.url) {
      return { accepted: false, reason: "missing-url" };
    }

    const normalizedUrl = normalizeUrl(payload.url);
    const paused = this.loadPaused();
    if (paused) {
      return { accepted: false, reason: "paused" };
    }

    const transaction = this.db.transaction((sanitized: SanitizedCapturePayload): CaptureResponse => {
      const rules = this.loadBlacklistRules();
      const matchedRule = matchBlacklist(rules, normalizedUrl, sanitized.pageSignals);
      if (matchedRule) {
        if (matchedRule.mode === "meta-only") {
          this.run(
            `INSERT INTO blocked_events(id, url, title, blocked_at, mode, rule_id, rule_kind, rule_pattern)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              randomUUID().replace(/-/g, ""),
              normalizedUrl,
              sanitized.title,
              sanitized.capturedAt,
              matchedRule.mode,
              matchedRule.id,
              matchedRule.kind,
              matchedRule.pattern
            ]
          );
        }
        return {
          accepted: false,
          reason: "blacklisted",
          rule: matchedRule
        };
      }

      const resourceId = shortHash(normalizedUrl);
      const excerpt = firstNonEmpty(sanitized.excerpt, trimChars(sanitized.textContent, 240));
      const contentHash = shortHash(firstNonEmpty(sanitized.textContent, sanitized.excerpt, sanitized.title));
      const currentResource = this.findResourceById(resourceId);
      const latestVersion = this.loadLatestVersion(resourceId);
      const addVersion =
        latestVersion === undefined ||
        latestVersion.textHash !== contentHash ||
        latestVersion.title !== sanitized.title;

      if (!currentResource) {
        this.run(
          `INSERT INTO resources(
            id, normalized_url, host, first_seen_at, last_seen_at,
            visit_count, version_count, latest_hash, latest_title, latest_excerpt
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            resourceId,
            normalizedUrl,
            new URL(normalizedUrl).hostname,
            sanitized.capturedAt,
            sanitized.capturedAt,
            1,
            addVersion ? 1 : 0,
            addVersion ? contentHash : "",
            sanitized.title,
            excerpt
          ]
        );
      } else {
        const nextVersionCount = addVersion ? currentResource.versionCount + 1 : currentResource.versionCount;
        this.run(
          `UPDATE resources
             SET last_seen_at = ?,
                 visit_count = ?,
                 version_count = ?,
                 latest_hash = ?,
                 latest_title = ?,
                 latest_excerpt = ?
           WHERE id = ?`,
          [
            sanitized.capturedAt,
            currentResource.visitCount + 1,
            nextVersionCount,
            addVersion ? contentHash : currentResource.latestHash,
            sanitized.title,
            excerpt,
            resourceId
          ]
        );
      }

      this.run(
        `INSERT INTO visits(id, resource_id, captured_at, dwell_ms, scroll_depth, reason)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          randomUUID().replace(/-/g, ""),
          resourceId,
          sanitized.capturedAt,
          sanitized.dwellMs,
          sanitized.scrollDepth,
          sanitized.reason
        ]
      );

      if (addVersion) {
        this.run(
          `INSERT INTO snapshot_versions(id, resource_id, captured_at, title, text_hash, excerpt, word_count)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            randomUUID().replace(/-/g, ""),
            resourceId,
            sanitized.capturedAt,
            sanitized.title,
            contentHash,
            excerpt,
            [...firstNonEmpty(sanitized.textContent, sanitized.excerpt)].length
          ]
        );
      }

      const summary = this.summarize(localDayKeyFromTimestamp(sanitized.capturedAt));
      const resource = this.loadCompactResourceById(resourceId);
      if (!resource) {
        throw new Error("resource not found after capture");
      }
      return {
        accepted: true,
        resource,
        report: summary.report
      };
    });

    return transaction(payload);
  }

  pageStatus(rawUrl: string): PageStatusResponse {
    const trimmed = rawUrl.trim();
    if (!trimmed) {
      return {
        url: rawUrl,
        exists: false,
        blacklisted: false,
        reason: "missing-url"
      };
    }

    let normalizedUrl = "";
    try {
      normalizedUrl = normalizeUrl(trimmed);
    } catch {
      return {
        url: rawUrl,
        exists: false,
        blacklisted: false,
        reason: "invalid-url"
      };
    }

    const rules = this.loadBlacklistRules();
    const matchedRule = matchBlacklist(rules, normalizedUrl, []);
    if (matchedRule) {
      return {
        url: rawUrl,
        normalizedUrl,
        exists: false,
        blacklisted: true,
        reason: "blacklisted",
        rule: matchedRule
      };
    }

    const resource = this.loadCompactResourceById(shortHash(normalizedUrl));
    if (!resource) {
      return {
        url: rawUrl,
        normalizedUrl,
        exists: false,
        blacklisted: false
      };
    }

    return {
      url: rawUrl,
      normalizedUrl,
      exists: true,
      blacklisted: false,
      resource
    };
  }

  updatePaused(paused: boolean): StateSummary {
    this.run(`UPDATE app_state SET paused = ? WHERE id = 1`, [boolToInt(paused)]);
    return this.summarize("");
  }

  addBlacklistRule(rule: Pick<BlacklistRule, "kind" | "pattern" | "mode">): StateSummary {
    const pattern = normalizeWhitespace(rule.pattern);
    if (!pattern) {
      throw new Error("pattern is required");
    }
    const kind: BlacklistRule["kind"] = rule.kind === "url" ? "url" : "domain";
    const mode: BlacklistRule["mode"] = rule.mode === "meta-only" ? "meta-only" : "drop";

    this.run(
      `INSERT INTO blacklist_rules(id, kind, pattern, mode, created_at) VALUES (?, ?, ?, ?, ?)`,
      [randomUUID().replace(/-/g, ""), kind, pattern, mode, nowIso()]
    );
    return this.summarize("");
  }

  deleteBlacklistRule(ruleId: string): StateSummary {
    this.run(`DELETE FROM blacklist_rules WHERE id = ?`, [ruleId]);
    return this.summarize("");
  }

  deleteResource(resourceId: string, requestedDay: string): StateSummary {
    this.run(`DELETE FROM resources WHERE id = ?`, [resourceId]);
    return this.summarize(requestedDay);
  }

  private initSchema(): void {
    for (const statement of SCHEMA_STATEMENTS) {
      this.db.exec(statement);
    }
    this.run(`INSERT OR IGNORE INTO app_state(id, paused) VALUES (1, 0)`);

    const countRow = this.get<{ count: number }>(`SELECT COUNT(*) AS count FROM blacklist_rules`);
    const count = countRow?.count ?? 0;
    if (count > 0) {
      return;
    }

    const createdAt = nowIso();
    for (const rule of DEFAULT_BLACKLIST) {
      this.run(
        `INSERT INTO blacklist_rules(id, kind, pattern, mode, created_at) VALUES (?, ?, ?, ?, ?)`,
        [rule.id, rule.kind, rule.pattern, rule.mode, createdAt]
      );
    }
  }

  private recoverInterruptedDreamTasks(): void {
    this.run(
      `UPDATE dream_report_tasks
          SET status = 'failed',
              completed_at = ?,
              error_message = COALESCE(error_message, '任务在服务重启前中断，请重新生成。')
        WHERE status IN ('pending', 'running')`,
      [nowIso()]
    );
  }

  private insertDreamTask(dayKey: string, inputHash: string): DreamTask {
    const taskId = randomUUID().replace(/-/g, "");
    const createdAt = nowIso();
    this.run(
      `INSERT INTO dream_report_tasks(id, day_key, status, created_at, input_hash)
       VALUES (?, ?, 'pending', ?, ?)`,
      [taskId, dayKey, createdAt, inputHash]
    );
    const task = this.loadDreamTaskById(taskId);
    if (!task) {
      throw new Error("dream task not found after insert");
    }
    return task;
  }

  private async runDreamReportTask(taskId: string): Promise<void> {
    if (this.activeDreamTasks.has(taskId)) {
      return;
    }

    this.activeDreamTasks.add(taskId);
    try {
      const task = this.loadDreamTaskById(taskId);
      if (!task) {
        throw new Error("dream task not found");
      }
      if (task.status !== "pending" && task.status !== "running") {
        return;
      }

      const startedAt = nowIso();
      this.run(
        `UPDATE dream_report_tasks
            SET status = 'running',
                started_at = ?,
                error_message = NULL
          WHERE id = ?`,
        [startedAt, taskId]
      );

      const { startAt, endAt } = dayRangeUtc(task.day);
      const blockedEvents = this.loadBlockedEventsForDay(startAt, endAt);
      const resources = this.loadCompactResourcesForDay(startAt, endAt);
      const currentInputHash = buildDayInputHash(resources, blockedEvents);
      const fallbackReport = buildDreamReport(resources, blockedEvents, {
        authReady: true,
        stale: false
      });
      const report = await generateDreamReportWithCodex(task.day, resources, blockedEvents, fallbackReport);
      this.saveDreamReport(task.day, currentInputHash, report);
      this.run(
        `UPDATE dream_report_tasks
            SET status = 'completed',
                completed_at = ?,
                input_hash = ?,
                error_message = NULL
          WHERE id = ?`,
        [nowIso(), currentInputHash, taskId]
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "dream task failed";
      this.run(
        `UPDATE dream_report_tasks
            SET status = 'failed',
                completed_at = ?,
                error_message = ?
          WHERE id = ?`,
        [nowIso(), message, taskId]
      );
    } finally {
      this.activeDreamTasks.delete(taskId);
    }
  }

  private loadSettings(): Settings {
    return {
      paused: this.loadPaused(),
      blacklist: this.loadBlacklistRules()
    };
  }

  private loadPaused(): boolean {
    const row = this.get<AppStateRow>(`SELECT paused FROM app_state WHERE id = 1`);
    if (!row) {
      throw new Error("missing app_state row");
    }
    return row.paused === 1;
  }

  private loadBlacklistRules(): BlacklistRule[] {
    return this.all<RuleRow>(
      `SELECT id, kind, pattern, mode FROM blacklist_rules ORDER BY created_at DESC, rowid DESC`
    ).map(mapRuleRow);
  }

  private loadAvailableDays(): string[] {
    const rows = this.all<EventAtRow>(
      `SELECT captured_at AS event_at FROM visits
       UNION ALL
       SELECT blocked_at AS event_at FROM blocked_events`
    );
    const seen = new Set<string>();
    const days: string[] = [];
    for (const row of rows) {
      const day = localDayKeyFromTimestamp(row.event_at);
      if (!day || seen.has(day)) {
        continue;
      }
      seen.add(day);
      days.push(day);
    }
    return days.sort((left, right) => right.localeCompare(left));
  }

  private loadBlockedEventsForDay(startAt: string, endAt: string): BlockedEvent[] {
    return this.all<BlockedEventRow>(
      `SELECT id, url, title, blocked_at, mode, rule_id, rule_kind, rule_pattern
         FROM blocked_events
        WHERE blocked_at >= ? AND blocked_at < ?
        ORDER BY blocked_at DESC, rowid DESC`,
      [startAt, endAt]
    ).map((row) => ({
      id: row.id,
      url: row.url,
      title: row.title,
      blockedAt: row.blocked_at,
      mode: row.mode === "meta-only" ? "meta-only" : "drop",
      rule: {
        id: row.rule_id,
        kind: row.rule_kind === "url" ? "url" : row.rule_kind === "page" ? "page" : "domain",
        pattern: row.rule_pattern,
        mode: row.mode === "meta-only" ? "meta-only" : "drop"
      }
    }));
  }

  private loadCompactResourcesForDay(startAt: string, endAt: string): CompactResource[] {
    const baseResources = this.all<DayResourceRow>(
      `SELECT r.id, r.normalized_url, r.host, MAX(v.captured_at) AS last_seen_at,
              r.latest_hash, r.latest_title, r.latest_excerpt
         FROM resources r
         JOIN visits v ON v.resource_id = r.id
        WHERE v.captured_at >= ? AND v.captured_at < ?
        GROUP BY r.id, r.normalized_url, r.host, r.latest_hash, r.latest_title, r.latest_excerpt
        ORDER BY last_seen_at DESC, r.rowid DESC`,
      [startAt, endAt]
    );

    return baseResources.map((row) => {
      const visits = this.loadVisitsForResourceDay(row.id, startAt, endAt, 10);
      const versions = this.loadVersionsForResourceDay(row.id, startAt, endAt, 6);
      const latestVersion = this.loadLatestVersionBefore(row.id, endAt);
      return {
        id: row.id,
        normalizedUrl: row.normalized_url,
        host: row.host,
        latestTitle: latestVersion?.title ?? row.latest_title,
        latestExcerpt: latestVersion?.excerpt ?? row.latest_excerpt,
        visitCount: visits.length,
        versionCount: versions.length,
        lastSeenAt: row.last_seen_at,
        latestHash: latestVersion?.textHash ?? row.latest_hash,
        visits,
        versions
      };
    });
  }

  private loadCompactResources(): CompactResource[] {
    const baseResources = this.all<CompactResourceRow>(
      `SELECT id, normalized_url, host, last_seen_at, visit_count, version_count, latest_hash, latest_title, latest_excerpt
         FROM resources
        ORDER BY last_seen_at DESC, rowid DESC`
    );

    return baseResources.map((row) => ({
      id: row.id,
      normalizedUrl: row.normalized_url,
      host: row.host,
      latestTitle: row.latest_title,
      latestExcerpt: row.latest_excerpt,
      visitCount: row.visit_count,
      versionCount: row.version_count,
      lastSeenAt: row.last_seen_at,
      latestHash: row.latest_hash,
      visits: this.loadVisitsForResource(row.id, 10),
      versions: this.loadVersionsForResource(row.id, 6)
    }));
  }

  private loadCompactResourceById(resourceId: string): CompactResource | undefined {
    const row = this.get<CompactResourceRow>(
      `SELECT id, normalized_url, host, last_seen_at, visit_count, version_count, latest_hash, latest_title, latest_excerpt
         FROM resources
        WHERE id = ?`,
      [resourceId]
    );
    if (!row) {
      return undefined;
    }

    return {
      id: row.id,
      normalizedUrl: row.normalized_url,
      host: row.host,
      latestTitle: row.latest_title,
      latestExcerpt: row.latest_excerpt,
      visitCount: row.visit_count,
      versionCount: row.version_count,
      lastSeenAt: row.last_seen_at,
      latestHash: row.latest_hash,
      visits: this.loadVisitsForResource(row.id, 10),
      versions: this.loadVersionsForResource(row.id, 6)
    };
  }

  private findResourceById(resourceId: string): CompactResource | undefined {
    return this.loadCompactResourceById(resourceId);
  }

  private loadVisitsForResource(resourceId: string, limit: number): Visit[] {
    const rows = this.all<VisitRow>(
      `SELECT id, captured_at, dwell_ms, scroll_depth, reason
         FROM visits
        WHERE resource_id = ?
        ORDER BY captured_at DESC, rowid DESC
        LIMIT ?`,
      [resourceId, limit]
    );
    return reverseInPlace(rows.map(mapVisitRow));
  }

  private loadVisitsForResourceDay(resourceId: string, startAt: string, endAt: string, limit: number): Visit[] {
    const rows = this.all<VisitRow>(
      `SELECT id, captured_at, dwell_ms, scroll_depth, reason
         FROM visits
        WHERE resource_id = ? AND captured_at >= ? AND captured_at < ?
        ORDER BY captured_at DESC, rowid DESC
        LIMIT ?`,
      [resourceId, startAt, endAt, limit]
    );
    return reverseInPlace(rows.map(mapVisitRow));
  }

  private loadVersionsForResource(resourceId: string, limit: number): SnapshotVersion[] {
    const rows = this.all<VersionRow>(
      `SELECT id, captured_at, title, text_hash, excerpt, word_count
         FROM snapshot_versions
        WHERE resource_id = ?
        ORDER BY captured_at DESC, rowid DESC
        LIMIT ?`,
      [resourceId, limit]
    );
    return reverseInPlace(rows.map(mapVersionRow));
  }

  private loadVersionsForResourceDay(resourceId: string, startAt: string, endAt: string, limit: number): SnapshotVersion[] {
    const rows = this.all<VersionRow>(
      `SELECT id, captured_at, title, text_hash, excerpt, word_count
         FROM snapshot_versions
        WHERE resource_id = ? AND captured_at >= ? AND captured_at < ?
        ORDER BY captured_at DESC, rowid DESC
        LIMIT ?`,
      [resourceId, startAt, endAt, limit]
    );
    return reverseInPlace(rows.map(mapVersionRow));
  }

  private loadLatestVersion(resourceId: string): SnapshotVersion | undefined {
    const row = this.get<VersionRow>(
      `SELECT id, captured_at, title, text_hash, excerpt, word_count
         FROM snapshot_versions
        WHERE resource_id = ?
        ORDER BY captured_at DESC, rowid DESC
        LIMIT 1`,
      [resourceId]
    );
    return row ? mapVersionRow(row) : undefined;
  }

  private loadLatestVersionBefore(resourceId: string, before: string): SnapshotVersion | undefined {
    const row = this.get<VersionRow>(
      `SELECT id, captured_at, title, text_hash, excerpt, word_count
         FROM snapshot_versions
        WHERE resource_id = ? AND captured_at < ?
        ORDER BY captured_at DESC, rowid DESC
        LIMIT 1`,
      [resourceId, before]
    );
    return row ? mapVersionRow(row) : undefined;
  }

  private loadDreamReport(dayKey: string): DreamReportCacheRow | undefined {
    return this.get<DreamReportCacheRow>(
      `SELECT day_key, input_hash, generated_at, model, payload_json
         FROM dream_reports
        WHERE day_key = ?`,
      [dayKey]
    );
  }

  private loadLatestDreamTaskForDay(dayKey: string): DreamTask | undefined {
    const row = this.get<DreamTaskRow>(
      `SELECT id, day_key, status, created_at, started_at, completed_at, input_hash, error_message
         FROM dream_report_tasks
        WHERE day_key = ?
        ORDER BY created_at DESC, rowid DESC
        LIMIT 1`,
      [dayKey]
    );
    return row ? mapDreamTaskRow(row) : undefined;
  }

  private loadDreamTaskById(taskId: string): DreamTask | undefined {
    const row = this.get<DreamTaskRow>(
      `SELECT id, day_key, status, created_at, started_at, completed_at, input_hash, error_message
         FROM dream_report_tasks
        WHERE id = ?`,
      [taskId]
    );
    return row ? mapDreamTaskRow(row) : undefined;
  }

  private saveDreamReport(dayKey: string, inputHash: string, report: DreamReport): void {
    this.run(
      `INSERT INTO dream_reports(day_key, input_hash, generated_at, model, payload_json)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(day_key) DO UPDATE SET
         input_hash = excluded.input_hash,
         generated_at = excluded.generated_at,
         model = excluded.model,
         payload_json = excluded.payload_json`,
      [dayKey, inputHash, report.generatedAt, report.meta.model, JSON.stringify(report)]
    );
  }

  private get<Row>(sql: string, params: SqlValue[] = []): Row | undefined {
    return this.db.prepare(sql).get(...params) as Row | undefined;
  }

  private all<Row>(sql: string, params: SqlValue[] = []): Row[] {
    return this.db.prepare(sql).all(...params) as Row[];
  }

  private run(sql: string, params: SqlValue[] = []): void {
    this.db.prepare(sql).run(...params);
  }
}
