package main

import (
	"context"
	"crypto/rand"
	"crypto/sha1"
	"database/sql"
	"encoding/hex"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

var trackingParams = map[string]struct{}{
	"fbclid": {}, "gclid": {}, "mc_cid": {}, "mc_eid": {}, "ref": {}, "spm": {},
}

var schemaStatements = []string{
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
	`CREATE INDEX IF NOT EXISTS idx_blacklist_rules_created_at ON blacklist_rules(created_at DESC);`,
	`CREATE INDEX IF NOT EXISTS idx_blocked_events_blocked_at ON blocked_events(blocked_at DESC);`,
	`CREATE INDEX IF NOT EXISTS idx_resources_last_seen_at ON resources(last_seen_at DESC);`,
	`CREATE INDEX IF NOT EXISTS idx_visits_resource_captured_at ON visits(resource_id, captured_at DESC);`,
	`CREATE INDEX IF NOT EXISTS idx_versions_resource_captured_at ON snapshot_versions(resource_id, captured_at DESC);`,
}

type blacklistRule struct {
	ID      string `json:"id"`
	Kind    string `json:"kind"`
	Pattern string `json:"pattern"`
	Mode    string `json:"mode"`
}

type settings struct {
	Paused    bool            `json:"paused"`
	Blacklist []blacklistRule `json:"blacklist"`
}

type blockedEvent struct {
	ID        string        `json:"id"`
	URL       string        `json:"url"`
	Title     string        `json:"title"`
	BlockedAt string        `json:"blockedAt"`
	Mode      string        `json:"mode"`
	Rule      blacklistRule `json:"rule"`
}

type visit struct {
	ID          string `json:"id"`
	CapturedAt  string `json:"capturedAt"`
	DwellMs     int    `json:"dwellMs"`
	ScrollDepth int    `json:"scrollDepth"`
	Reason      string `json:"reason"`
}

type snapshotVersion struct {
	ID         string `json:"id"`
	CapturedAt string `json:"capturedAt"`
	Title      string `json:"title"`
	TextHash   string `json:"textHash"`
	Excerpt    string `json:"excerpt"`
	WordCount  int    `json:"wordCount"`
}

type resource struct {
	ID            string            `json:"id"`
	NormalizedURL string            `json:"normalizedUrl"`
	Host          string            `json:"host"`
	FirstSeenAt   string            `json:"firstSeenAt"`
	LastSeenAt    string            `json:"lastSeenAt"`
	VisitCount    int               `json:"visitCount"`
	VersionCount  int               `json:"versionCount"`
	LatestHash    string            `json:"latestHash"`
	LatestTitle   string            `json:"latestTitle"`
	LatestExcerpt string            `json:"latestExcerpt"`
	Visits        []visit           `json:"visits"`
	Versions      []snapshotVersion `json:"versions"`
}

type compactResource struct {
	ID            string            `json:"id"`
	NormalizedURL string            `json:"normalizedUrl"`
	Host          string            `json:"host"`
	LatestTitle   string            `json:"latestTitle"`
	LatestExcerpt string            `json:"latestExcerpt"`
	VisitCount    int               `json:"visitCount"`
	VersionCount  int               `json:"versionCount"`
	LastSeenAt    string            `json:"lastSeenAt"`
	LatestHash    string            `json:"latestHash"`
	Visits        []visit           `json:"visits"`
	Versions      []snapshotVersion `json:"versions"`
}

type stateSummary struct {
	CurrentDay    string            `json:"currentDay"`
	AvailableDays []string          `json:"availableDays"`
	Settings      settings          `json:"settings"`
	BlockedEvents []blockedEvent    `json:"blockedEvents"`
	Report        dreamReport       `json:"report"`
	Resources     []compactResource `json:"resources"`
}

type capturePayload struct {
	URL         string   `json:"url"`
	Title       string   `json:"title"`
	TextContent string   `json:"textContent"`
	Excerpt     string   `json:"excerpt"`
	CapturedAt  string   `json:"capturedAt"`
	DwellMs     int      `json:"dwellMs"`
	ScrollDepth int      `json:"scrollDepth"`
	Reason      string   `json:"reason"`
	PageSignals []string `json:"pageSignals"`
}

type captureResponse struct {
	Accepted bool             `json:"accepted"`
	Reason   string           `json:"reason,omitempty"`
	Rule     *blacklistRule   `json:"rule,omitempty"`
	Resource *compactResource `json:"resource,omitempty"`
	Report   *dreamReport     `json:"report,omitempty"`
}

type store struct {
	mu       sync.Mutex
	db       *sql.DB
	dataPath string
}

func newStore(dataDir string) (*store, error) {
	if strings.TrimSpace(dataDir) == "" {
		dataDir = "data"
	}
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return nil, err
	}

	dbPath := filepath.Join(dataDir, "people-dream.db")
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)

	appStore := &store{
		db:       db,
		dataPath: dbPath,
	}
	if err := appStore.initSchema(); err != nil {
		_ = db.Close()
		return nil, err
	}
	return appStore, nil
}

func (s *store) close() error {
	return s.db.Close()
}

func defaultBlacklist() []blacklistRule {
	return []blacklistRule{
		{ID: "bank", Kind: "domain", Pattern: "*.bank.*", Mode: "drop"},
		{ID: "mail", Kind: "domain", Pattern: "mail.*", Mode: "drop"},
		{ID: "webmail", Kind: "domain", Pattern: "webmail.*", Mode: "drop"},
		{ID: "auth", Kind: "domain", Pattern: "*.auth.*", Mode: "drop"},
		{ID: "checkout", Kind: "url", Pattern: "*://*/checkout*", Mode: "drop"},
		{ID: "billing", Kind: "url", Pattern: "*://*/billing*", Mode: "drop"},
		{ID: "settings", Kind: "url", Pattern: "*://*/settings*", Mode: "drop"},
		{ID: "admin", Kind: "url", Pattern: "*://*/admin*", Mode: "drop"},
		{ID: "login", Kind: "url", Pattern: "*://*/login*", Mode: "drop"},
	}
}

func (s *store) initSchema() error {
	ctx := context.Background()
	for _, statement := range schemaStatements {
		if _, err := s.db.ExecContext(ctx, statement); err != nil {
			return err
		}
	}
	if _, err := s.db.ExecContext(ctx, `INSERT OR IGNORE INTO app_state(id, paused) VALUES (1, 0)`); err != nil {
		return err
	}

	var count int
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM blacklist_rules`).Scan(&count); err != nil {
		return err
	}
	if count > 0 {
		return nil
	}

	now := nowISO()
	for _, rule := range defaultBlacklist() {
		if _, err := s.db.ExecContext(
			ctx,
			`INSERT INTO blacklist_rules(id, kind, pattern, mode, created_at) VALUES (?, ?, ?, ?, ?)`,
			rule.ID,
			rule.Kind,
			rule.Pattern,
			rule.Mode,
			now,
		); err != nil {
			return err
		}
	}
	return nil
}

func (s *store) summarize(requestedDay string) (stateSummary, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.summarizeLocked(context.Background(), requestedDay)
}

func (s *store) summarizeLocked(ctx context.Context, requestedDay string) (stateSummary, error) {
	return s.summarizeFromQuerier(ctx, s.db, requestedDay)
}

func (s *store) summarizeFromQuerier(ctx context.Context, querier queryer, requestedDay string) (stateSummary, error) {
	settingsValue, err := s.loadSettings(ctx, querier)
	if err != nil {
		return stateSummary{}, err
	}
	availableDays, err := s.loadAvailableDays(ctx, querier)
	if err != nil {
		return stateSummary{}, err
	}
	activeDay := resolveActiveDay(requestedDay, availableDays)
	startAt, endAt, err := dayRangeUTC(activeDay)
	if err != nil {
		return stateSummary{}, err
	}

	blockedAll, err := s.loadBlockedEventsForDay(ctx, querier, startAt, endAt, 0)
	if err != nil {
		return stateSummary{}, err
	}
	resources, err := s.loadCompactResourcesForDay(ctx, querier, startAt, endAt)
	if err != nil {
		return stateSummary{}, err
	}

	report := buildDreamReport(resources, blockedAll)
	blockedTop := blockedAll
	if blockedTop == nil {
		blockedTop = []blockedEvent{}
	}
	if len(blockedTop) > 20 {
		blockedTop = blockedTop[:20]
	}
	if availableDays == nil {
		availableDays = []string{}
	}
	if resources == nil {
		resources = []compactResource{}
	}

	return stateSummary{
		CurrentDay:    activeDay,
		AvailableDays: availableDays,
		Settings:      settingsValue,
		BlockedEvents: blockedTop,
		Report:        report,
		Resources:     resources,
	}, nil
}

func (s *store) processCapture(input capturePayload) (captureResponse, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	payload, err := sanitizePayload(input)
	if err != nil {
		return captureResponse{Accepted: false, Reason: "invalid-url"}, nil
	}
	if payload.URL == "" {
		return captureResponse{Accepted: false, Reason: "missing-url"}, nil
	}

	normalizedURL, err := normalizeURL(payload.URL)
	if err != nil {
		return captureResponse{Accepted: false, Reason: "invalid-url"}, nil
	}

	ctx := context.Background()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return captureResponse{}, err
	}
	defer func() {
		_ = tx.Rollback()
	}()

	paused, err := s.loadPaused(ctx, tx)
	if err != nil {
		return captureResponse{}, err
	}
	if paused {
		return captureResponse{Accepted: false, Reason: "paused"}, nil
	}

	rules, err := s.loadBlacklistRules(ctx, tx)
	if err != nil {
		return captureResponse{}, err
	}
	if rule := matchBlacklist(rules, payload, normalizedURL); rule != nil {
		if rule.Mode == "meta-only" {
			if _, err := tx.ExecContext(
				ctx,
				`INSERT INTO blocked_events(id, url, title, blocked_at, mode, rule_id, rule_kind, rule_pattern)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				newID(),
				normalizedURL,
				payload.Title,
				payload.CapturedAt,
				rule.Mode,
				rule.ID,
				rule.Kind,
				rule.Pattern,
			); err != nil {
				return captureResponse{}, err
			}
		}
		if err := tx.Commit(); err != nil {
			return captureResponse{}, err
		}
		return captureResponse{Accepted: false, Reason: "blacklisted", Rule: rule}, nil
	}

	resourceID := shortHash(normalizedURL)
	excerpt := firstNonEmpty(payload.Excerpt, trimRunes(payload.TextContent, 240))
	contentHash := shortHash(firstNonEmpty(payload.TextContent, payload.Excerpt, payload.Title))
	host := mustParseHost(normalizedURL)

	current, exists, err := s.loadResourceByID(ctx, tx, resourceID)
	if err != nil {
		return captureResponse{}, err
	}
	lastVersion, hasLastVersion, err := s.loadLatestVersion(ctx, tx, resourceID)
	if err != nil {
		return captureResponse{}, err
	}
	addVersion := !hasLastVersion || lastVersion.TextHash != contentHash || lastVersion.Title != payload.Title

	if !exists {
		versionCount := 0
		latestHash := ""
		if addVersion {
			versionCount = 1
			latestHash = contentHash
		}
		if _, err := tx.ExecContext(
			ctx,
			`INSERT INTO resources(
				id, normalized_url, host, first_seen_at, last_seen_at,
				visit_count, version_count, latest_hash, latest_title, latest_excerpt
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			resourceID,
			normalizedURL,
			host,
			payload.CapturedAt,
			payload.CapturedAt,
			1,
			versionCount,
			latestHash,
			payload.Title,
			excerpt,
		); err != nil {
			return captureResponse{}, err
		}
	} else {
		latestHash := current.LatestHash
		versionCount := current.VersionCount
		if addVersion {
			latestHash = contentHash
			versionCount++
		}
		if _, err := tx.ExecContext(
			ctx,
			`UPDATE resources
			 SET last_seen_at = ?,
			     visit_count = ?,
			     version_count = ?,
			     latest_hash = ?,
			     latest_title = ?,
			     latest_excerpt = ?
			 WHERE id = ?`,
			payload.CapturedAt,
			current.VisitCount+1,
			versionCount,
			latestHash,
			payload.Title,
			excerpt,
			resourceID,
		); err != nil {
			return captureResponse{}, err
		}
	}

	if _, err := tx.ExecContext(
		ctx,
		`INSERT INTO visits(id, resource_id, captured_at, dwell_ms, scroll_depth, reason)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		newID(),
		resourceID,
		payload.CapturedAt,
		payload.DwellMs,
		payload.ScrollDepth,
		payload.Reason,
	); err != nil {
		return captureResponse{}, err
	}

	if addVersion {
		if _, err := tx.ExecContext(
			ctx,
			`INSERT INTO snapshot_versions(id, resource_id, captured_at, title, text_hash, excerpt, word_count)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			newID(),
			resourceID,
			payload.CapturedAt,
			payload.Title,
			contentHash,
			excerpt,
			len([]rune(firstNonEmpty(payload.TextContent, payload.Excerpt))),
		); err != nil {
			return captureResponse{}, err
		}
	}

	summary, err := s.summarizeFromQuerier(ctx, tx, localDayKeyFromTimestamp(payload.CapturedAt))
	if err != nil {
		return captureResponse{}, err
	}
	compact, err := s.loadCompactResourceByID(ctx, tx, resourceID)
	if err != nil {
		return captureResponse{}, err
	}
	if err := tx.Commit(); err != nil {
		return captureResponse{}, err
	}
	return captureResponse{
		Accepted: true,
		Resource: &compact,
		Report:   &summary.Report,
	}, nil
}

func (s *store) updatePaused(paused bool) (stateSummary, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	ctx := context.Background()
	if _, err := s.db.ExecContext(ctx, `UPDATE app_state SET paused = ? WHERE id = 1`, boolToInt(paused)); err != nil {
		return stateSummary{}, err
	}
	return s.summarizeLocked(ctx, "")
}

func (s *store) addBlacklistRule(rule blacklistRule) (stateSummary, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	pattern := normalizeWhitespace(rule.Pattern)
	if pattern == "" {
		return stateSummary{}, errors.New("pattern is required")
	}
	kind := "domain"
	if rule.Kind == "url" {
		kind = "url"
	}
	mode := "drop"
	if rule.Mode == "meta-only" {
		mode = "meta-only"
	}

	ctx := context.Background()
	if _, err := s.db.ExecContext(
		ctx,
		`INSERT INTO blacklist_rules(id, kind, pattern, mode, created_at) VALUES (?, ?, ?, ?, ?)`,
		newID(),
		kind,
		pattern,
		mode,
		nowISO(),
	); err != nil {
		return stateSummary{}, err
	}
	return s.summarizeLocked(ctx, "")
}

func (s *store) deleteBlacklistRule(ruleID string) (stateSummary, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	ctx := context.Background()
	if _, err := s.db.ExecContext(ctx, `DELETE FROM blacklist_rules WHERE id = ?`, ruleID); err != nil {
		return stateSummary{}, err
	}
	return s.summarizeLocked(ctx, "")
}

func (s *store) loadSettings(ctx context.Context, querier queryer) (settings, error) {
	paused, err := s.loadPaused(ctx, querier)
	if err != nil {
		return settings{}, err
	}
	rules, err := s.loadBlacklistRules(ctx, querier)
	if err != nil {
		return settings{}, err
	}
	return settings{
		Paused:    paused,
		Blacklist: rules,
	}, nil
}

func (s *store) loadPaused(ctx context.Context, querier queryer) (bool, error) {
	var paused int
	if err := querier.QueryRowContext(ctx, `SELECT paused FROM app_state WHERE id = 1`).Scan(&paused); err != nil {
		return false, err
	}
	return paused == 1, nil
}

func (s *store) loadBlacklistRules(ctx context.Context, querier queryer) ([]blacklistRule, error) {
	rows, err := querier.QueryContext(
		ctx,
		`SELECT id, kind, pattern, mode FROM blacklist_rules ORDER BY created_at DESC, rowid DESC`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	rules := []blacklistRule{}
	for rows.Next() {
		var rule blacklistRule
		if err := rows.Scan(&rule.ID, &rule.Kind, &rule.Pattern, &rule.Mode); err != nil {
			return nil, err
		}
		rules = append(rules, rule)
	}
	return rules, rows.Err()
}

func (s *store) loadAvailableDays(ctx context.Context, querier queryer) ([]string, error) {
	rows, err := querier.QueryContext(
		ctx,
		`SELECT captured_at AS event_at FROM visits
		 UNION ALL
		 SELECT blocked_at AS event_at FROM blocked_events`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	seen := map[string]struct{}{}
	days := []string{}
	for rows.Next() {
		var eventAt string
		if err := rows.Scan(&eventAt); err != nil {
			return nil, err
		}
		day := localDayKeyFromTimestamp(eventAt)
		if day == "" {
			continue
		}
		if _, exists := seen[day]; exists {
			continue
		}
		seen[day] = struct{}{}
		days = append(days, day)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	sort.Sort(sort.Reverse(sort.StringSlice(days)))
	return days, nil
}

func (s *store) loadBlockedEventsForDay(ctx context.Context, querier queryer, startAt, endAt string, limit int) ([]blockedEvent, error) {
	query := `SELECT id, url, title, blocked_at, mode, rule_id, rule_kind, rule_pattern
	          FROM blocked_events
	          WHERE blocked_at >= ? AND blocked_at < ?
	          ORDER BY blocked_at DESC, rowid DESC`
	args := []any{startAt, endAt}
	if limit > 0 {
		query += ` LIMIT ?`
		args = append(args, limit)
	}

	rows, err := querier.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	events := []blockedEvent{}
	for rows.Next() {
		var item blockedEvent
		if err := rows.Scan(
			&item.ID,
			&item.URL,
			&item.Title,
			&item.BlockedAt,
			&item.Mode,
			&item.Rule.ID,
			&item.Rule.Kind,
			&item.Rule.Pattern,
		); err != nil {
			return nil, err
		}
		item.Rule.Mode = item.Mode
		events = append(events, item)
	}
	return events, rows.Err()
}

func (s *store) loadCompactResourcesForDay(ctx context.Context, querier queryer, startAt, endAt string) ([]compactResource, error) {
	rows, err := querier.QueryContext(
		ctx,
		`SELECT r.id, r.normalized_url, r.host, MAX(v.captured_at) AS last_seen_at,
		        r.latest_hash, r.latest_title, r.latest_excerpt
		 FROM resources r
		 JOIN visits v ON v.resource_id = r.id
		 WHERE v.captured_at >= ? AND v.captured_at < ?
		 GROUP BY r.id, r.normalized_url, r.host, r.latest_hash, r.latest_title, r.latest_excerpt
		 ORDER BY last_seen_at DESC, r.rowid DESC`,
		startAt,
		endAt,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	baseResources := []compactResource{}
	for rows.Next() {
		var item compactResource
		if err := rows.Scan(
			&item.ID,
			&item.NormalizedURL,
			&item.Host,
			&item.LastSeenAt,
			&item.LatestHash,
			&item.LatestTitle,
			&item.LatestExcerpt,
		); err != nil {
			return nil, err
		}

		baseResources = append(baseResources, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	resources := make([]compactResource, 0, len(baseResources))
	for _, item := range baseResources {
		item.Visits, err = s.loadVisitsForResourceDay(ctx, querier, item.ID, startAt, endAt, 10)
		if err != nil {
			return nil, err
		}
		item.VisitCount = len(item.Visits)

		item.Versions, err = s.loadVersionsForResourceDay(ctx, querier, item.ID, startAt, endAt, 6)
		if err != nil {
			return nil, err
		}
		item.VersionCount = len(item.Versions)

		if latestVersion, found, err := s.loadLatestVersionBefore(ctx, querier, item.ID, endAt); err != nil {
			return nil, err
		} else if found {
			item.LatestHash = latestVersion.TextHash
			item.LatestTitle = latestVersion.Title
			item.LatestExcerpt = latestVersion.Excerpt
		}

		resources = append(resources, item)
	}
	return resources, nil
}

func (s *store) loadBlockedEvents(ctx context.Context, querier queryer, limit int) ([]blockedEvent, error) {
	query := `SELECT id, url, title, blocked_at, mode, rule_id, rule_kind, rule_pattern
	          FROM blocked_events
	          ORDER BY blocked_at DESC, rowid DESC`
	args := []any{}
	if limit > 0 {
		query += ` LIMIT ?`
		args = append(args, limit)
	}

	rows, err := querier.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	events := []blockedEvent{}
	for rows.Next() {
		var item blockedEvent
		if err := rows.Scan(
			&item.ID,
			&item.URL,
			&item.Title,
			&item.BlockedAt,
			&item.Mode,
			&item.Rule.ID,
			&item.Rule.Kind,
			&item.Rule.Pattern,
		); err != nil {
			return nil, err
		}
		item.Rule.Mode = item.Mode
		events = append(events, item)
	}
	return events, rows.Err()
}

func (s *store) loadCompactResources(ctx context.Context, querier queryer) ([]compactResource, error) {
	rows, err := querier.QueryContext(
		ctx,
		`SELECT id, normalized_url, host, last_seen_at, visit_count, version_count, latest_hash, latest_title, latest_excerpt
		 FROM resources
		 ORDER BY last_seen_at DESC, rowid DESC`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	baseResources := []compactResource{}
	for rows.Next() {
		var item compactResource
		if err := rows.Scan(
			&item.ID,
			&item.NormalizedURL,
			&item.Host,
			&item.LastSeenAt,
			&item.VisitCount,
			&item.VersionCount,
			&item.LatestHash,
			&item.LatestTitle,
			&item.LatestExcerpt,
		); err != nil {
			return nil, err
		}
		baseResources = append(baseResources, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	resources := make([]compactResource, 0, len(baseResources))
	for _, item := range baseResources {
		item.Visits, err = s.loadVisitsForResource(ctx, querier, item.ID, 10)
		if err != nil {
			return nil, err
		}
		item.Versions, err = s.loadVersionsForResource(ctx, querier, item.ID, 6)
		if err != nil {
			return nil, err
		}
		resources = append(resources, item)
	}
	return resources, nil
}

func (s *store) loadCompactResourceByID(ctx context.Context, querier queryer, resourceID string) (compactResource, error) {
	row := querier.QueryRowContext(
		ctx,
		`SELECT id, normalized_url, host, last_seen_at, visit_count, version_count, latest_hash, latest_title, latest_excerpt
		 FROM resources WHERE id = ?`,
		resourceID,
	)

	var item compactResource
	if err := row.Scan(
		&item.ID,
		&item.NormalizedURL,
		&item.Host,
		&item.LastSeenAt,
		&item.VisitCount,
		&item.VersionCount,
		&item.LatestHash,
		&item.LatestTitle,
		&item.LatestExcerpt,
	); err != nil {
		return compactResource{}, err
	}

	var err error
	item.Visits, err = s.loadVisitsForResource(ctx, querier, item.ID, 10)
	if err != nil {
		return compactResource{}, err
	}
	item.Versions, err = s.loadVersionsForResource(ctx, querier, item.ID, 6)
	if err != nil {
		return compactResource{}, err
	}
	return item, nil
}

func (s *store) loadVisitsForResource(ctx context.Context, querier queryer, resourceID string, limit int) ([]visit, error) {
	rows, err := querier.QueryContext(
		ctx,
		`SELECT id, captured_at, dwell_ms, scroll_depth, reason
		 FROM visits
		 WHERE resource_id = ?
		 ORDER BY captured_at DESC, rowid DESC
		 LIMIT ?`,
		resourceID,
		limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	visits := []visit{}
	for rows.Next() {
		var item visit
		if err := rows.Scan(&item.ID, &item.CapturedAt, &item.DwellMs, &item.ScrollDepth, &item.Reason); err != nil {
			return nil, err
		}
		visits = append(visits, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	reverseVisits(visits)
	return visits, nil
}

func (s *store) loadVisitsForResourceDay(ctx context.Context, querier queryer, resourceID, startAt, endAt string, limit int) ([]visit, error) {
	rows, err := querier.QueryContext(
		ctx,
		`SELECT id, captured_at, dwell_ms, scroll_depth, reason
		 FROM visits
		 WHERE resource_id = ? AND captured_at >= ? AND captured_at < ?
		 ORDER BY captured_at DESC, rowid DESC
		 LIMIT ?`,
		resourceID,
		startAt,
		endAt,
		limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	visits := []visit{}
	for rows.Next() {
		var item visit
		if err := rows.Scan(&item.ID, &item.CapturedAt, &item.DwellMs, &item.ScrollDepth, &item.Reason); err != nil {
			return nil, err
		}
		visits = append(visits, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	reverseVisits(visits)
	return visits, nil
}

func (s *store) loadVersionsForResource(ctx context.Context, querier queryer, resourceID string, limit int) ([]snapshotVersion, error) {
	rows, err := querier.QueryContext(
		ctx,
		`SELECT id, captured_at, title, text_hash, excerpt, word_count
		 FROM snapshot_versions
		 WHERE resource_id = ?
		 ORDER BY captured_at DESC, rowid DESC
		 LIMIT ?`,
		resourceID,
		limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	versions := []snapshotVersion{}
	for rows.Next() {
		var item snapshotVersion
		if err := rows.Scan(&item.ID, &item.CapturedAt, &item.Title, &item.TextHash, &item.Excerpt, &item.WordCount); err != nil {
			return nil, err
		}
		versions = append(versions, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	reverseVersions(versions)
	return versions, nil
}

func (s *store) loadVersionsForResourceDay(ctx context.Context, querier queryer, resourceID, startAt, endAt string, limit int) ([]snapshotVersion, error) {
	rows, err := querier.QueryContext(
		ctx,
		`SELECT id, captured_at, title, text_hash, excerpt, word_count
		 FROM snapshot_versions
		 WHERE resource_id = ? AND captured_at >= ? AND captured_at < ?
		 ORDER BY captured_at DESC, rowid DESC
		 LIMIT ?`,
		resourceID,
		startAt,
		endAt,
		limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	versions := []snapshotVersion{}
	for rows.Next() {
		var item snapshotVersion
		if err := rows.Scan(&item.ID, &item.CapturedAt, &item.Title, &item.TextHash, &item.Excerpt, &item.WordCount); err != nil {
			return nil, err
		}
		versions = append(versions, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	reverseVersions(versions)
	return versions, nil
}

func (s *store) loadResourceByID(ctx context.Context, querier queryer, resourceID string) (resource, bool, error) {
	row := querier.QueryRowContext(
		ctx,
		`SELECT id, normalized_url, host, first_seen_at, last_seen_at, visit_count, version_count, latest_hash, latest_title, latest_excerpt
		 FROM resources
		 WHERE id = ?`,
		resourceID,
	)

	var item resource
	err := row.Scan(
		&item.ID,
		&item.NormalizedURL,
		&item.Host,
		&item.FirstSeenAt,
		&item.LastSeenAt,
		&item.VisitCount,
		&item.VersionCount,
		&item.LatestHash,
		&item.LatestTitle,
		&item.LatestExcerpt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return resource{}, false, nil
	}
	if err != nil {
		return resource{}, false, err
	}
	return item, true, nil
}

func (s *store) loadLatestVersion(ctx context.Context, querier queryer, resourceID string) (snapshotVersion, bool, error) {
	row := querier.QueryRowContext(
		ctx,
		`SELECT id, captured_at, title, text_hash, excerpt, word_count
		 FROM snapshot_versions
		 WHERE resource_id = ?
		 ORDER BY captured_at DESC, rowid DESC
		 LIMIT 1`,
		resourceID,
	)

	var item snapshotVersion
	err := row.Scan(&item.ID, &item.CapturedAt, &item.Title, &item.TextHash, &item.Excerpt, &item.WordCount)
	if errors.Is(err, sql.ErrNoRows) {
		return snapshotVersion{}, false, nil
	}
	if err != nil {
		return snapshotVersion{}, false, err
	}
	return item, true, nil
}

func (s *store) loadLatestVersionBefore(ctx context.Context, querier queryer, resourceID, before string) (snapshotVersion, bool, error) {
	row := querier.QueryRowContext(
		ctx,
		`SELECT id, captured_at, title, text_hash, excerpt, word_count
		 FROM snapshot_versions
		 WHERE resource_id = ? AND captured_at < ?
		 ORDER BY captured_at DESC, rowid DESC
		 LIMIT 1`,
		resourceID,
		before,
	)

	var item snapshotVersion
	err := row.Scan(&item.ID, &item.CapturedAt, &item.Title, &item.TextHash, &item.Excerpt, &item.WordCount)
	if errors.Is(err, sql.ErrNoRows) {
		return snapshotVersion{}, false, nil
	}
	if err != nil {
		return snapshotVersion{}, false, err
	}
	return item, true, nil
}

func sanitizePayload(input capturePayload) (capturePayload, error) {
	output := capturePayload{
		URL:         strings.TrimSpace(input.URL),
		Title:       trimRunes(normalizeWhitespace(input.Title), 200),
		TextContent: trimRunes(normalizeWhitespace(input.TextContent), 20000),
		Excerpt:     trimRunes(normalizeWhitespace(input.Excerpt), 400),
		CapturedAt:  normalizeTime(input.CapturedAt),
		DwellMs:     maxInt(input.DwellMs, 0),
		ScrollDepth: maxInt(minInt(input.ScrollDepth, 100), 0),
		Reason:      trimRunes(normalizeWhitespace(input.Reason), 40),
		PageSignals: sanitizeSignals(input.PageSignals),
	}
	if output.URL == "" {
		return output, nil
	}
	if _, err := url.Parse(output.URL); err != nil {
		return output, err
	}
	if output.Title == "" {
		output.Title = "Untitled page"
	}
	if output.Reason == "" {
		output.Reason = "auto"
	}
	return output, nil
}

func sanitizeSignals(signals []string) []string {
	if len(signals) == 0 {
		return nil
	}
	seen := map[string]struct{}{}
	out := make([]string, 0, minInt(len(signals), 10))
	for _, signal := range signals {
		value := trimRunes(normalizeWhitespace(signal), 40)
		if value == "" {
			continue
		}
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
		if len(out) == 10 {
			break
		}
	}
	return out
}

func matchBlacklist(rules []blacklistRule, payload capturePayload, normalizedURL string) *blacklistRule {
	if pageLooksSensitive(payload.PageSignals) {
		return &blacklistRule{ID: "page-signal", Kind: "page", Pattern: "sensitive-signals", Mode: "drop"}
	}

	host := mustParseHost(normalizedURL)
	for _, rule := range rules {
		pattern := wildcardToRegexp(rule.Pattern)
		switch rule.Kind {
		case "domain":
			if pattern.MatchString(host) {
				copied := rule
				return &copied
			}
		case "url":
			if pattern.MatchString(normalizedURL) {
				copied := rule
				return &copied
			}
		}
	}
	return nil
}

func pageLooksSensitive(signals []string) bool {
	for _, signal := range signals {
		switch signal {
		case "password-input", "payment-form", "identity-form":
			return true
		}
	}
	return false
}

func normalizeURL(raw string) (string, error) {
	parsed, err := url.Parse(raw)
	if err != nil {
		return "", err
	}
	parsed.Fragment = ""
	if parsed.Path != "/" && strings.HasSuffix(parsed.Path, "/") {
		parsed.Path = strings.TrimSuffix(parsed.Path, "/")
	}

	query := parsed.Query()
	keys := make([]string, 0, len(query))
	filtered := url.Values{}
	for key, values := range query {
		if strings.HasPrefix(strings.ToLower(key), "utm_") {
			continue
		}
		if _, blocked := trackingParams[strings.ToLower(key)]; blocked {
			continue
		}
		keys = append(keys, key)
		filtered[key] = values
	}
	sort.Strings(keys)
	parsed.RawQuery = ""
	ordered := url.Values{}
	for _, key := range keys {
		for _, value := range filtered[key] {
			ordered.Add(key, value)
		}
	}
	parsed.RawQuery = ordered.Encode()
	return parsed.String(), nil
}

func wildcardToRegexp(pattern string) *regexp.Regexp {
	escaped := regexp.QuoteMeta(pattern)
	escaped = strings.ReplaceAll(escaped, `\*`, ".*")
	return regexp.MustCompile("^" + escaped + "$")
}

func shortHash(value string) string {
	sum := sha1.Sum([]byte(value))
	return hex.EncodeToString(sum[:])[:12]
}

func newID() string {
	buffer := make([]byte, 16)
	if _, err := rand.Read(buffer); err == nil {
		return hex.EncodeToString(buffer)
	}
	return shortHash(time.Now().UTC().Format(time.RFC3339Nano))
}

func resolveActiveDay(requestedDay string, availableDays []string) string {
	requestedDay = strings.TrimSpace(requestedDay)
	if requestedDay != "" {
		if _, err := time.ParseInLocation("2006-01-02", requestedDay, time.Local); err == nil {
			return requestedDay
		}
	}
	if len(availableDays) > 0 {
		return availableDays[0]
	}
	return time.Now().In(time.Local).Format("2006-01-02")
}

func dayRangeUTC(dayKey string) (string, string, error) {
	localStart, err := time.ParseInLocation("2006-01-02", dayKey, time.Local)
	if err != nil {
		return "", "", err
	}
	localEnd := localStart.Add(24 * time.Hour)
	return localStart.UTC().Format(time.RFC3339), localEnd.UTC().Format(time.RFC3339), nil
}

func localDayKeyFromTimestamp(value string) string {
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return ""
	}
	return parsed.In(time.Local).Format("2006-01-02")
}

func normalizeTime(input string) string {
	if strings.TrimSpace(input) == "" {
		return nowISO()
	}
	parsed, err := time.Parse(time.RFC3339Nano, input)
	if err != nil {
		return nowISO()
	}
	return parsed.UTC().Format(time.RFC3339)
}

func nowISO() string {
	return time.Now().UTC().Format(time.RFC3339)
}

func normalizeWhitespace(input string) string {
	return strings.Join(strings.Fields(input), " ")
}

func trimRunes(input string, limit int) string {
	if limit <= 0 {
		return ""
	}
	runes := []rune(input)
	if len(runes) <= limit {
		return input
	}
	return string(runes[:limit])
}

func mustParseHost(raw string) string {
	parsed, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	return parsed.Hostname()
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func reverseVisits(values []visit) {
	for left, right := 0, len(values)-1; left < right; left, right = left+1, right-1 {
		values[left], values[right] = values[right], values[left]
	}
}

func reverseVersions(values []snapshotVersion) {
	for left, right := 0, len(values)-1; left < right; left, right = left+1, right-1 {
		values[left], values[right] = values[right], values[left]
	}
}

func boolToInt(value bool) int {
	if value {
		return 1
	}
	return 0
}

func maxInt(left, right int) int {
	if left > right {
		return left
	}
	return right
}

func minInt(left, right int) int {
	if left < right {
		return left
	}
	return right
}

type queryer interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
	QueryRowContext(context.Context, string, ...any) *sql.Row
}
