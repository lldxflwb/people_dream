import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { Codex } from "@openai/codex-sdk";

import type { BlockedEvent, CompactResource, DreamReport, ThemeScore } from "./types.js";

interface CodexTheme {
  keyword: string;
  score: number;
}

interface CodexDreamDraft {
  overview: string;
  themes: CodexTheme[];
  unfinishedQuestions: string[];
  connections: string[];
  suggestions: string[];
}

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    overview: { type: "string" },
    themes: {
      type: "array",
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          keyword: { type: "string" },
          score: { type: "integer", minimum: 1, maximum: 10 }
        },
        required: ["keyword", "score"]
      }
    },
    unfinishedQuestions: {
      type: "array",
      maxItems: 3,
      items: { type: "string" }
    },
    connections: {
      type: "array",
      maxItems: 3,
      items: { type: "string" }
    },
    suggestions: {
      type: "array",
      maxItems: 3,
      items: { type: "string" }
    }
  },
  required: ["overview", "themes", "unfinishedQuestions", "connections", "suggestions"]
} as const;

const CODEX_AUTH_PATH = join(homedir(), ".codex", "auth.json");
const LOCAL_CODEX_BIN = join(process.cwd(), "node_modules", ".bin", "codex");
const MODEL_OVERRIDE = process.env.PEOPLE_DREAM_CODEX_MODEL?.trim() || undefined;
const MODEL_LABEL = MODEL_OVERRIDE || "codex-cli-default";
const AUTH_CACHE_TTL_MS = 15_000;

let lastAuthCheck: { checkedAt: number; value: boolean } | undefined;

function trimText(input: string, limit: number): string {
  const text = input.trim();
  const chars = [...text];
  return chars.length <= limit ? text : `${chars.slice(0, limit).join("")}...`;
}

function dedupeLines(values: string[], limit: number, fallback: string[]): string[] {
  const output: string[] = [];
  const seen = new Set<string>();

  for (const rawValue of values) {
    const value = trimText(rawValue.replace(/\s+/g, " "), 120);
    if (!value || seen.has(value)) {
      continue;
    }
    output.push(value);
    seen.add(value);
    if (output.length === limit) {
      return output;
    }
  }

  return fallback.slice(0, limit);
}

function normalizeThemes(values: CodexTheme[], fallback: ThemeScore[]): ThemeScore[] {
  const output: ThemeScore[] = [];
  const seen = new Set<string>();

  for (const candidate of values) {
    const keyword = trimText(String(candidate.keyword || "").replace(/\s+/g, " "), 32);
    const score = Math.max(1, Math.min(10, Math.round(Number(candidate.score) || 0)));
    if (!keyword || seen.has(keyword)) {
      continue;
    }
    output.push({ keyword, score });
    seen.add(keyword);
    if (output.length === 3) {
      return output;
    }
  }

  return fallback.slice(0, 3);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

function asThemeArray(value: unknown): CodexTheme[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (!isObject(item)) {
      return [];
    }
    return [
      {
        keyword: asString(item.keyword),
        score: typeof item.score === "number" ? item.score : 0
      }
    ];
  });
}

function parseDraft(raw: string): CodexDreamDraft {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error("Codex 返回的梦报不是合法 JSON。", { cause: error });
  }

  if (!isObject(parsed)) {
    throw new Error("Codex 返回了未知结构的梦报。");
  }

  return {
    overview: asString(parsed.overview),
    themes: asThemeArray(parsed.themes),
    unfinishedQuestions: asStringArray(parsed.unfinishedQuestions),
    connections: asStringArray(parsed.connections),
    suggestions: asStringArray(parsed.suggestions)
  };
}

function buildResourceDigest(resources: CompactResource[]): string {
  const rankedResources = [...resources]
    .sort((left, right) => {
      const leftScore = left.visitCount * 2 + left.versionCount * 3;
      const rightScore = right.visitCount * 2 + right.versionCount * 3;
      if (leftScore === rightScore) {
        return right.lastSeenAt.localeCompare(left.lastSeenAt);
      }
      return rightScore - leftScore;
    })
    .slice(0, 12);

  return JSON.stringify(
    rankedResources.map((resource) => ({
      title: trimText(resource.latestTitle, 120),
      url: resource.normalizedUrl,
      host: resource.host,
      excerpt: trimText(resource.latestExcerpt, 240),
      visitCount: resource.visitCount,
      versionCount: resource.versionCount,
      lastSeenAt: resource.lastSeenAt,
      visits: resource.visits.map((visit) => ({
        capturedAt: visit.capturedAt,
        dwellMs: visit.dwellMs,
        scrollDepth: visit.scrollDepth,
        reason: visit.reason
      })),
      versions: resource.versions.map((version) => ({
        capturedAt: version.capturedAt,
        title: trimText(version.title, 120),
        excerpt: trimText(version.excerpt, 160),
        wordCount: version.wordCount
      }))
    })),
    null,
    2
  );
}

function buildBlockedDigest(blockedEvents: BlockedEvent[]): string {
  const blockedSummary = blockedEvents.reduce<Record<string, number>>((summary, event) => {
    const key = `${event.rule.kind}:${event.rule.pattern}:${event.mode}`;
    summary[key] = (summary[key] ?? 0) + 1;
    return summary;
  }, {});

  return JSON.stringify(
    {
      blockedCount: blockedEvents.length,
      groupedRules: Object.entries(blockedSummary).map(([rule, count]) => ({
        rule,
        count
      }))
    },
    null,
    2
  );
}

function buildPrompt(dayKey: string, resources: CompactResource[], blockedEvents: BlockedEvent[], baseReport: DreamReport): string {
  return [
    "你是一个“AI 为人类做梦”的本地认知整理器。",
    "你只允许使用我提供的当天浏览数据，不要假设外部事实，不要调用网页，不要补充不存在的来源。",
    "输出必须是中文，并且严格符合 JSON schema。",
    "请把输出分成五部分：overview、themes、unfinishedQuestions、connections、suggestions。",
    "写作要求：",
    "1. overview 要像晨间梦报，明确区分事实和推断，避免过度确定。",
    "2. themes 只保留 1-3 个短主题词，score 用 1-10 表示重要程度。",
    "3. unfinishedQuestions 要指出尚未收束的问题，不要泛泛而谈。",
    "4. connections 要说明不同页面或主题之间的潜在关联。",
    "5. suggestions 要给出明天可继续追踪的方向，动作要具体。",
    "",
    `分析日期：${dayKey}`,
    `当前规则版概览：${baseReport.overview}`,
    "",
    "当天资源摘要：",
    buildResourceDigest(resources),
    "",
    "当天隐私拦截摘要：",
    buildBlockedDigest(blockedEvents)
  ].join("\n");
}

export function hasLocalCodexAuth(): boolean {
  if (existsSync(CODEX_AUTH_PATH)) {
    lastAuthCheck = {
      checkedAt: Date.now(),
      value: true
    };
    return true;
  }

  if (lastAuthCheck && Date.now() - lastAuthCheck.checkedAt < AUTH_CACHE_TTL_MS) {
    return lastAuthCheck.value;
  }

  const command = existsSync(LOCAL_CODEX_BIN) ? LOCAL_CODEX_BIN : "codex";
  const result = spawnSync(command, ["login", "status"], {
    encoding: "utf8"
  });
  if (result.status !== 0) {
    lastAuthCheck = {
      checkedAt: Date.now(),
      value: false
    };
    return false;
  }

  const combinedOutput = `${result.stdout || ""}\n${result.stderr || ""}`;
  const authReady = /logged in/i.test(combinedOutput);
  lastAuthCheck = {
    checkedAt: Date.now(),
    value: authReady
  };
  return authReady;
}

export function createCodexClient(): Codex {
  return new Codex();
}

export async function generateDreamReportWithCodex(
  dayKey: string,
  resources: CompactResource[],
  blockedEvents: BlockedEvent[],
  fallbackReport: DreamReport
): Promise<DreamReport> {
  if (!hasLocalCodexAuth()) {
    throw new Error("未检测到 Codex 本地登录态，请先在终端运行 codex 完成登录。");
  }

  if (resources.length === 0 && blockedEvents.length === 0) {
    throw new Error("当天还没有可用于梦境推理的浏览数据。");
  }

  const codex = createCodexClient();
  const thread = codex.startThread({
    ...(MODEL_OVERRIDE ? { model: MODEL_OVERRIDE } : {}),
    sandboxMode: "read-only",
    approvalPolicy: "never",
    webSearchMode: "disabled",
    networkAccessEnabled: false,
    skipGitRepoCheck: true,
    workingDirectory: process.cwd(),
    modelReasoningEffort: "medium"
  });

  const result = await thread.run(buildPrompt(dayKey, resources, blockedEvents, fallbackReport), {
    outputSchema: OUTPUT_SCHEMA
  });
  const draft = parseDraft(result.finalResponse);

  return {
    ...fallbackReport,
    generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    overview: trimText(draft.overview, 320) || fallbackReport.overview,
    themes: normalizeThemes(draft.themes, fallbackReport.themes),
    unfinishedQuestions: dedupeLines(draft.unfinishedQuestions, 3, fallbackReport.unfinishedQuestions),
    connections: dedupeLines(draft.connections, 3, fallbackReport.connections),
    suggestions: dedupeLines(draft.suggestions, 3, fallbackReport.suggestions),
    meta: {
      source: "codex",
      model: MODEL_LABEL,
      authReady: true,
      stale: false
    }
  };
}
