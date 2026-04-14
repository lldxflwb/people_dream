package main

import (
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"
)

var latinStopwords = map[string]struct{}{
	"about": {}, "after": {}, "again": {}, "also": {}, "and": {}, "been": {},
	"before": {}, "being": {}, "browser": {}, "context": {}, "could": {},
	"dream": {}, "dreams": {}, "for": {}, "from": {}, "have": {}, "into": {},
	"just": {}, "localhost": {}, "long": {}, "means": {}, "more": {},
	"page": {}, "people": {}, "should": {}, "that": {}, "their": {},
	"there": {}, "these": {}, "they": {}, "this": {}, "through": {},
	"were": {}, "what": {}, "when": {}, "with": {}, "your": {},
}

var cjkStopwords = map[string]struct{}{
	"一个": {}, "一些": {}, "不是": {}, "今天": {}, "他们": {}, "你们": {},
	"可以": {}, "因为": {}, "如果": {}, "就是": {}, "已经": {}, "我们": {},
	"所以": {}, "继续": {}, "自己": {}, "这个": {}, "那个": {}, "页面": {},
	"看到": {}, "内容": {}, "浏览": {}, "用户": {},
}

var latinWordPattern = regexp.MustCompile(`[a-z][a-z0-9-]{2,}`)
var hanWordPattern = regexp.MustCompile(`[\p{Han}]{2,6}`)

type themeScore struct {
	Keyword string `json:"keyword"`
	Score   int    `json:"score"`
}

type reportStats struct {
	TrackedPages  int `json:"trackedPages"`
	BlockedEvents int `json:"blockedEvents"`
	TotalVisits   int `json:"totalVisits"`
	TotalVersions int `json:"totalVersions"`
}

type ongoingResource struct {
	ID           string `json:"id"`
	Title        string `json:"title"`
	URL          string `json:"url"`
	VisitCount   int    `json:"visitCount"`
	VersionCount int    `json:"versionCount"`
	LastSeenAt   string `json:"lastSeenAt"`
}

type dreamReport struct {
	GeneratedAt      string            `json:"generatedAt"`
	Overview         string            `json:"overview"`
	Themes           []themeScore      `json:"themes"`
	OngoingResources []ongoingResource `json:"ongoingResources"`
	Suggestions      []string          `json:"suggestions"`
	Stats            reportStats       `json:"stats"`
}

func topKeywords(resources []compactResource) []themeScore {
	scores := map[string]int{}

	for _, resource := range resources {
		baseText := strings.ToLower(resource.LatestTitle + " " + resource.LatestExcerpt)
		weight := 1 + resource.VisitCount + resource.VersionCount*2

		for _, token := range latinWordPattern.FindAllString(baseText, -1) {
			if _, blocked := latinStopwords[token]; blocked {
				continue
			}
			scores[token] += weight
		}

		for _, token := range hanWordPattern.FindAllString(resource.LatestTitle+" "+resource.LatestExcerpt, -1) {
			if _, blocked := cjkStopwords[token]; blocked {
				continue
			}
			scores[token] += weight
		}
	}

	out := make([]themeScore, 0, len(scores))
	for keyword, score := range scores {
		out = append(out, themeScore{Keyword: keyword, Score: score})
	}

	sort.Slice(out, func(i, j int) bool {
		if out[i].Score == out[j].Score {
			return out[i].Keyword < out[j].Keyword
		}
		return out[i].Score > out[j].Score
	})

	if len(out) > 6 {
		out = out[:6]
	}
	return out
}

func buildDreamReport(resources []compactResource, blockedEvents []blockedEvent) dreamReport {
	sortedResources := append([]compactResource(nil), resources...)
	sort.Slice(sortedResources, func(i, j int) bool {
		left := sortedResources[i].VisitCount*2 + sortedResources[i].VersionCount*3
		right := sortedResources[j].VisitCount*2 + sortedResources[j].VersionCount*3
		if left == right {
			return sortedResources[i].LastSeenAt > sortedResources[j].LastSeenAt
		}
		return left > right
	})

	themes := topKeywords(sortedResources)
	if len(themes) > 3 {
		themes = themes[:3]
	}

	ongoing := make([]ongoingResource, 0, minInt(len(sortedResources), 5))
	for _, resource := range sortedResources[:minInt(len(sortedResources), 5)] {
		ongoing = append(ongoing, ongoingResource{
			ID:           resource.ID,
			Title:        resource.LatestTitle,
			URL:          resource.NormalizedURL,
			VisitCount:   resource.VisitCount,
			VersionCount: resource.VersionCount,
			LastSeenAt:   resource.LastSeenAt,
		})
	}

	themeWords := make([]string, 0, len(themes))
	for _, theme := range themes {
		themeWords = append(themeWords, theme.Keyword)
	}

	overview := "今天还没有可用的浏览数据，梦报会在捕获页面后逐渐成形。"
	if len(sortedResources) > 0 {
		label := "还没有形成稳定主题"
		if len(themeWords) > 0 {
			label = strings.Join(themeWords, "、")
		}
		overview = "今天的浏览轨迹主要围绕 " + label + " 展开，更像是在持续整理一个尚未完全收束的问题空间。"
	}

	suggestions := make([]string, 0, 3)
	if len(ongoing) > 0 {
		suggestions = append(suggestions, "回看《"+safeTitle(ongoing[0].Title)+"》，把它为什么反复出现写成一句问题。")
	}
	if len(themes) > 0 {
		suggestions = append(suggestions, "围绕“"+themes[0].Keyword+"”补一条手写笔记，确认它是短期兴趣还是长期主题。")
	}

	hasVersionChange := false
	for _, resource := range ongoing {
		if resource.VersionCount > 1 {
			hasVersionChange = true
			break
		}
	}

	switch {
	case hasVersionChange:
		suggestions = append(suggestions, "挑一条发生过版本变化的页面，对比它的新旧差异，记录你真正关注的变化点。")
	case len(sortedResources) > 0:
		suggestions = append(suggestions, "明天继续追一条今天停留时间最长的页面，确认它是不是值得进入长期记忆。")
	}

	if len(blockedEvents) > 0 && len(suggestions) < 3 {
		suggestions = append(suggestions, "黑名单已开始拦截敏感页面，后续可以继续补充站点规则，减少噪声和误采。")
	}

	totalVisits := 0
	totalVersions := 0
	for _, resource := range sortedResources {
		totalVisits += resource.VisitCount
		totalVersions += resource.VersionCount
	}

	return dreamReport{
		GeneratedAt:      nowISO(),
		Overview:         overview,
		Themes:           themes,
		OngoingResources: ongoing,
		Suggestions:      suggestions,
		Stats: reportStats{
			TrackedPages:  len(sortedResources),
			BlockedEvents: len(blockedEvents),
			TotalVisits:   totalVisits,
			TotalVersions: totalVersions,
		},
	}
}

func safeTitle(input string) string {
	if strings.TrimSpace(input) == "" {
		return "未命名页面"
	}
	if utf8.RuneCountInString(input) > 80 {
		runes := []rune(input)
		return string(runes[:80]) + "..."
	}
	return input
}
