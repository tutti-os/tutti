package agent

import (
	"context"
	"database/sql"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

// codexThreadTitles reads the Codex app-server state database and returns a map
// of thread id (the rollout session id) to its generated conversation title.
//
// Codex keeps the human-readable title in `state_<n>.sqlite` (table `threads`,
// column `title`) rather than in the rollout transcript, so importing the title
// requires reading that DB. The schema is versioned and undocumented, so every
// failure path degrades gracefully to an empty map and the caller falls back to
// the message-derived title.
func codexThreadTitles(codexHome string) map[string]string {
	titles := map[string]string{}
	codexHome = strings.TrimSpace(codexHome)
	if codexHome == "" {
		return titles
	}
	dbPath := codexStateDBPath(codexHome)
	if dbPath == "" {
		return titles
	}

	// Open read-only with a short busy timeout so a live Codex process holding
	// the write lock never blocks the import scan.
	db, err := sql.Open("sqlite", codexStateDBDSN(dbPath, runtime.GOOS))
	if err != nil {
		return titles
	}
	defer db.Close()
	db.SetMaxOpenConns(1)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	rows, err := db.QueryContext(ctx, "SELECT id, title FROM threads WHERE title IS NOT NULL AND title != ''")
	if err != nil {
		return titles
	}
	defer rows.Close()
	for rows.Next() {
		var id, title string
		if err := rows.Scan(&id, &title); err != nil {
			continue
		}
		id = strings.TrimSpace(id)
		title = strings.TrimSpace(title)
		if id != "" && title != "" {
			titles[id] = title
		}
	}
	return titles
}

// codexStateDBDSN builds the read-only `file:` DSN for the Codex state
// database. Building the URI via url.URL percent-encodes paths containing
// spaces or other reserved characters rather than corrupting the DSN.
//
// Windows paths need normalizing first. A native path such as
// `C:\Users\me\.codex\state_5.sqlite` has no leading slash, so url.URL treats
// `C:` as the authority and percent-encodes every `\` as `%5C`, producing
// `file://C:%5CUsers%5C...`. SQLite then resolves that to a bogus location and
// fails to open the database, silently degrading every imported Codex
// conversation to its message-derived title instead of the generated one. Match
// the repository's other SQLite DSN builders and convert to forward slashes
// with a leading slash before a drive letter (see
// `services/tuttid/data/workspace/sqlite_store.go` and
// `packages/connector/store-sqlite/store.go`).
func codexStateDBDSN(dbPath string, goos string) string {
	databaseURL := &url.URL{
		Scheme:   "file",
		Path:     dbPath,
		RawQuery: "mode=ro&_pragma=busy_timeout(2000)",
	}
	if goos == "windows" && filepath.IsAbs(dbPath) {
		slashPath := filepath.ToSlash(dbPath)
		if uncPath := strings.TrimPrefix(slashPath, "//"); uncPath != slashPath {
			// UNC path: `\\host\share\...` -> host becomes the URI authority.
			host, path, found := strings.Cut(uncPath, "/")
			if found {
				databaseURL.Host = host
				databaseURL.Path = "/" + path
			}
		} else {
			databaseURL.Path = "/" + slashPath
		}
	}
	return databaseURL.String()
}

// codexStateDBPath returns the highest-versioned state_<n>.sqlite under codexHome.
func codexStateDBPath(codexHome string) string {
	matches, err := filepath.Glob(filepath.Join(codexHome, "state_*.sqlite"))
	if err != nil {
		return ""
	}
	best := ""
	bestVersion := -1
	for _, match := range matches {
		if info, err := os.Stat(match); err != nil || info.IsDir() {
			continue
		}
		name := strings.TrimSuffix(strings.TrimPrefix(filepath.Base(match), "state_"), ".sqlite")
		version, err := strconv.Atoi(name)
		if err != nil {
			continue
		}
		if version > bestVersion {
			bestVersion = version
			best = match
		}
	}
	return best
}
