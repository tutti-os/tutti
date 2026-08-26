//go:build windows

package workspace

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
)

type windowsSearchProvider struct{}

func newPlatformLocalFileSearchProvider() localFileSearchProvider {
	return windowsSearchProvider{}
}

func (windowsSearchProvider) Name() string {
	return "windows-system-index"
}

func (windowsSearchProvider) Search(
	ctx context.Context,
	request localFileSearchRequest,
) ([]string, error) {
	query := windowsSearchSQL(request)
	script := strings.Join([]string{
		"$ErrorActionPreference = 'Stop'",
		"$connection = New-Object System.Data.OleDb.OleDbConnection(\"Provider=Search.CollatorDSO;Extended Properties='Application=Windows';\")",
		"try {",
		"  $connection.Open()",
		"  $command = $connection.CreateCommand()",
		"  $command.CommandText = " + powershellSingleQuotedString(query),
		"  $reader = $command.ExecuteReader()",
		"  $items = @()",
		"  while ($reader.Read()) { $items += [string]$reader.GetValue(0) }",
		"  if ($items.Count -gt 0) { $items | ConvertTo-Json -Compress }",
		"} finally {",
		"  $connection.Dispose()",
		"}",
	}, "\n")
	command := exec.CommandContext(
		ctx,
		"powershell.exe",
		"-NoLogo",
		"-NoProfile",
		"-NonInteractive",
		"-ExecutionPolicy", "Bypass",
		"-EncodedCommand", powershellEncodedCommand(script),
	)
	output, err := command.Output()
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return nil, ctxErr
		}
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			if detail := strings.TrimSpace(string(exitErr.Stderr)); detail != "" {
				return nil, fmt.Errorf("%w: %s", err, detail)
			}
		}
		return nil, err
	}
	return parseWindowsSearchOutput(output)
}

func windowsSearchSQL(request localFileSearchRequest) string {
	limit := request.CandidateLimit
	if limit <= 0 {
		limit = defaultMaxSearchCandidates
	}
	scope := "file:" + filepath.ToSlash(filepath.Clean(request.SearchRootPath))
	clauses := []string{"SCOPE='" + windowsSearchSQLEscape(scope) + "'"}
	for _, token := range strings.Fields(request.Query) {
		namePattern := "%" + windowsSearchLikeEscape(token) + "%"
		itemURLPattern := "%" + windowsSearchLikeEscape(windowsSearchItemURLToken(token)) + "%"
		clauses = append(clauses,
			"(System.FileName LIKE '"+namePattern+"' OR System.ItemUrl LIKE '"+itemURLPattern+"')",
		)
	}
	if kindClause := windowsSearchKindClause(request); kindClause != "" {
		clauses = append(clauses, kindClause)
	}
	if filterClause := windowsSearchFilterClause(request.Filters); filterClause != "" {
		clauses = append(clauses, filterClause)
	}
	return "SELECT TOP " + strconv.Itoa(limit) +
		" System.ItemUrl FROM SYSTEMINDEX WHERE " + strings.Join(clauses, " AND ")
}

func windowsSearchKindClause(request localFileSearchRequest) string {
	files, directories := localFileSearchRequestedKinds(request)
	switch {
	case files && !directories:
		return "System.ItemType <> 'Directory'"
	case !files && directories:
		return "System.ItemType = 'Directory'"
	case !files && !directories:
		return "1 = 0"
	default:
		return ""
	}
}

func windowsSearchItemURLToken(value string) string {
	return (&url.URL{Path: filepath.ToSlash(value)}).EscapedPath()
}

func windowsSearchFilterClause(filters []string) string {
	selected := make(map[string]struct{}, len(filters))
	for _, filter := range filters {
		selected[filter] = struct{}{}
	}
	if len(selected) == 0 {
		return ""
	}
	var extensions []string
	for category, categoryExtensions := range referenceFilterCategoryExtensions {
		if _, ok := selected[category]; ok {
			extensions = append(extensions, categoryExtensions...)
		}
	}
	sort.Strings(extensions)
	parts := make([]string, 0, len(extensions)+1)
	for _, extension := range extensions {
		parts = append(parts, "System.FileExtension = '."+windowsSearchSQLEscape(extension)+"'")
	}
	if _, includeOther := selected["other"]; includeOther {
		known := allKnownReferenceFilterExtensions()
		notParts := make([]string, 0, len(known))
		for _, extension := range known {
			notParts = append(notParts, "System.FileExtension <> '."+windowsSearchSQLEscape(extension)+"'")
		}
		parts = append(parts, "(System.FileExtension IS NULL OR ("+strings.Join(notParts, " AND ")+"))")
	}
	if len(parts) == 0 {
		return "1 = 0"
	}
	return "(" + strings.Join(parts, " OR ") + ")"
}

func windowsSearchSQLEscape(value string) string {
	return strings.ReplaceAll(value, "'", "''")
}

func windowsSearchLikeEscape(value string) string {
	value = windowsSearchSQLEscape(value)
	value = strings.ReplaceAll(value, "[", "[[]")
	value = strings.ReplaceAll(value, "%", "[%]")
	return strings.ReplaceAll(value, "_", "[_]")
}

func powershellSingleQuotedString(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}

func powershellEncodedCommand(script string) string {
	encoded := utf16.Encode([]rune(script))
	bytes := make([]byte, len(encoded)*2)
	for index, value := range encoded {
		bytes[index*2] = byte(value)
		bytes[index*2+1] = byte(value >> 8)
	}
	return base64.StdEncoding.EncodeToString(bytes)
}

func parseWindowsSearchOutput(output []byte) ([]string, error) {
	trimmed := strings.TrimSpace(string(output))
	if trimmed == "" {
		return []string{}, nil
	}
	var urls []string
	if err := json.Unmarshal([]byte(trimmed), &urls); err != nil {
		var single string
		if singleErr := json.Unmarshal([]byte(trimmed), &single); singleErr != nil {
			return nil, err
		}
		urls = []string{single}
	}
	paths := make([]string, 0, len(urls))
	for _, itemURL := range urls {
		physicalPath, err := windowsSearchURLToPath(itemURL)
		if err == nil {
			paths = append(paths, physicalPath)
		}
	}
	return paths, nil
}

func windowsSearchURLToPath(value string) (string, error) {
	if !strings.HasPrefix(strings.ToLower(value), "file:") {
		return "", fmt.Errorf("unexpected Windows Search URL %q", value)
	}
	unescaped, err := url.PathUnescape(value[len("file:"):])
	if err != nil {
		return "", err
	}
	unescaped = strings.TrimPrefix(unescaped, "//localhost/")
	unescaped = strings.TrimPrefix(unescaped, "///")
	return filepath.FromSlash(unescaped), nil
}
