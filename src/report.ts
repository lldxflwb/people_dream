import type { BlockedEvent, CompactResource, DreamReport, OngoingResource, ThemeScore } from "./types.js";

const LATIN_STOPWORDS = new Set([
  "about",
  "after",
  "again",
  "also",
  "and",
  "been",
  "before",
  "being",
  "browser",
  "context",
  "could",
  "dream",
  "dreams",
  "for",
  "from",
  "have",
  "into",
  "just",
  "localhost",
  "long",
  "means",
  "more",
  "page",
  "people",
  "should",
  "that",
  "their",
  "there",
  "these",
  "they",
  "this",
  "through",
  "were",
  "what",
  "when",
  "with",
  "your"
]);

const CJK_STOPWORDS = new Set([
  "一个",
  "一些",
  "不是",
  "今天",
  "他们",
  "你们",
  "可以",
  "因为",
  "如果",
  "就是",
  "已经",
  "我们",
  "所以",
  "继续",
  "自己",
  "这个",
  "那个",
  "页面",
  "看到",
  "内容",
  "浏览",
  "用户"
]);

const LATIN_WORD_PATTERN = /[a-z][a-z0-9-]{2,}/g;
const HAN_WORD_PATTERN = /[\p{Script=Han}]{2,6}/gu;

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function safeTitle(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return "未命名页面";
  }
  const runes = [...trimmed];
  if (runes.length <= 80) {
    return trimmed;
  }
  return `${runes.slice(0, 80).join("")}...`;
}

function topKeywords(resources: CompactResource[]): ThemeScore[] {
  const scores = new Map<string, number>();

  for (const resource of resources) {
    const baseText = `${resource.latestTitle} ${resource.latestExcerpt}`.toLowerCase();
    const latinTokens = baseText.match(LATIN_WORD_PATTERN) ?? [];
    const hanTokens = `${resource.latestTitle} ${resource.latestExcerpt}`.match(HAN_WORD_PATTERN) ?? [];
    const weight = 1 + resource.visitCount + resource.versionCount * 2;

    for (const token of latinTokens) {
      if (LATIN_STOPWORDS.has(token)) {
        continue;
      }
      scores.set(token, (scores.get(token) ?? 0) + weight);
    }

    for (const token of hanTokens) {
      if (CJK_STOPWORDS.has(token)) {
        continue;
      }
      scores.set(token, (scores.get(token) ?? 0) + weight);
    }
  }

  return [...scores.entries()]
    .map(([keyword, score]) => ({ keyword, score }))
    .sort((left, right) => {
      if (left.score === right.score) {
        return left.keyword.localeCompare(right.keyword);
      }
      return right.score - left.score;
    })
    .slice(0, 6);
}

export function buildDreamReport(resources: CompactResource[], blockedEvents: BlockedEvent[]): DreamReport {
  const sortedResources = [...resources].sort((left, right) => {
    const leftScore = left.visitCount * 2 + left.versionCount * 3;
    const rightScore = right.visitCount * 2 + right.versionCount * 3;
    if (leftScore === rightScore) {
      return right.lastSeenAt.localeCompare(left.lastSeenAt);
    }
    return rightScore - leftScore;
  });

  const themes = topKeywords(sortedResources).slice(0, 3);
  const ongoingResources: OngoingResource[] = sortedResources.slice(0, 5).map((resource) => ({
    id: resource.id,
    title: resource.latestTitle,
    url: resource.normalizedUrl,
    visitCount: resource.visitCount,
    versionCount: resource.versionCount,
    lastSeenAt: resource.lastSeenAt
  }));

  const themeWords = themes.map((theme) => theme.keyword);
  let overview = "今天还没有可用的浏览数据，梦报会在捕获页面后逐渐成形。";
  if (sortedResources.length > 0) {
    const label = themeWords.length > 0 ? themeWords.join("、") : "还没有形成稳定主题";
    overview = `今天的浏览轨迹主要围绕 ${label} 展开，更像是在持续整理一个尚未完全收束的问题空间。`;
  }

  const suggestions: string[] = [];
  if (ongoingResources[0]) {
    suggestions.push(`回看《${safeTitle(ongoingResources[0].title)}》，把它为什么反复出现写成一句问题。`);
  }
  if (themes[0]) {
    suggestions.push(`围绕“${themes[0].keyword}”补一条手写笔记，确认它是短期兴趣还是长期主题。`);
  }

  const hasVersionChange = ongoingResources.some((resource) => resource.versionCount > 1);
  if (hasVersionChange) {
    suggestions.push("挑一条发生过版本变化的页面，对比它的新旧差异，记录你真正关注的变化点。");
  } else if (sortedResources.length > 0) {
    suggestions.push("明天继续追一条今天停留时间最长的页面，确认它是不是值得进入长期记忆。");
  }

  if (blockedEvents.length > 0 && suggestions.length < 3) {
    suggestions.push("黑名单已开始拦截敏感页面，后续可以继续补充站点规则，减少噪声和误采。");
  }

  const totalVisits = sortedResources.reduce((sum, resource) => sum + resource.visitCount, 0);
  const totalVersions = sortedResources.reduce((sum, resource) => sum + resource.versionCount, 0);

  return {
    generatedAt: nowIso(),
    overview,
    themes,
    ongoingResources,
    suggestions: suggestions.slice(0, 3),
    stats: {
      trackedPages: sortedResources.length,
      blockedEvents: blockedEvents.length,
      totalVisits,
      totalVersions
    }
  };
}
