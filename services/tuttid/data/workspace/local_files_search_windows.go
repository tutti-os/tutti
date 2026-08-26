//go:build windows

package workspace

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"

	workspacefiles "github.com/tutti-os/tutti/packages/workspace/files"
	"golang.org/x/sys/windows"
)

const (
	windowsFilterOnlyDirectoryLimit  = 500
	windowsFilterOnlyEntryLimit      = 20_000
	windowsFilterOnlyReadBatchSize   = 128
	windowsFilterOnlyDeadlineReserve = 250 * time.Millisecond
)

type windowsSearchProvider struct{}

func newPlatformLocalFileSearchProvider() localFileSearchProvider {
	return windowsSearchProvider{}
}

func (windowsSearchProvider) Name() string {
	return "windows-native-search"
}

func (windowsSearchProvider) Search(
	ctx context.Context,
	request localFileSearchRequest,
) ([]string, error) {
	if strings.TrimSpace(request.Query) == "" && len(request.Filters) > 0 {
		return windowsFilterOnlySearch(ctx, request)
	}
	script := windowsSearchPowerShellScript(request)
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

func windowsSearchPowerShellScript(
	request localFileSearchRequest,
) string {
	query := windowsSearchSQL(request)
	return strings.Join([]string{
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
}

func windowsFilterOnlySearch(
	ctx context.Context,
	request localFileSearchRequest,
) ([]string, error) {
	files, _ := localFileSearchRequestedKinds(request)
	selectedExtensions, includeOther := windowsSearchSelectedExtensions(request.Filters)
	if !files || (len(selectedExtensions) == 0 && !includeOther) {
		return []string{}, nil
	}

	candidateLimit := windowsFilterOnlyCandidateLimit(request)
	queue := []string{request.SearchRootPath}
	visitedDirectories := 0
	visitedEntries := 0
	partialReason := ""
	paths := make([]string, 0, candidateLimit)
	for len(queue) > 0 && len(paths) < candidateLimit &&
		visitedDirectories < windowsFilterOnlyDirectoryLimit && visitedEntries < windowsFilterOnlyEntryLimit {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if windowsFilterOnlySoftDeadlineReached(ctx) {
			partialReason = "soft_budget"
			break
		}

		directory := queue[0]
		queue = queue[1:]
		visitedDirectories++
		directoryHandle, err := os.Open(directory)
		if err != nil {
			if visitedDirectories == 1 {
				return nil, err
			}
			continue
		}
		for visitedEntries < windowsFilterOnlyEntryLimit {
			entries, readErr := directoryHandle.ReadDir(windowsFilterOnlyReadBatchSize)
			sort.Slice(entries, func(left, right int) bool {
				return strings.ToLower(entries[left].Name()) < strings.ToLower(entries[right].Name())
			})
			for _, entry := range entries {
				if visitedEntries >= windowsFilterOnlyEntryLimit {
					partialReason = "entry_cap"
					break
				}
				visitedEntries++
				name := entry.Name()
				path := filepath.Join(directory, name)
				if entry.IsDir() {
					if windowsFilterOnlyTraversableDirectory(path, name, request.IncludeHidden) {
						queue = append(queue, path)
					}
					continue
				}
				if matchesReferenceFilterCategories(name, false, request.Filters) &&
					windowsFilterOnlyEligibleFile(path, name, entry.Type(), request.IncludeHidden) {
					paths = append(paths, path)
					if len(paths) >= candidateLimit {
						break
					}
				}
			}
			if len(paths) >= candidateLimit || errors.Is(readErr, io.EOF) {
				break
			}
			if readErr != nil {
				if visitedDirectories == 1 {
					_ = directoryHandle.Close()
					return nil, readErr
				}
				break
			}
			if err := ctx.Err(); err != nil {
				_ = directoryHandle.Close()
				return nil, err
			}
			if windowsFilterOnlySoftDeadlineReached(ctx) {
				partialReason = "soft_budget"
				break
			}
		}
		_ = directoryHandle.Close()
		if partialReason != "" {
			break
		}
	}
	if partialReason == "" {
		switch {
		case len(paths) >= candidateLimit:
			partialReason = "candidate_cap"
		case visitedDirectories >= windowsFilterOnlyDirectoryLimit:
			partialReason = "directory_cap"
		case visitedEntries >= windowsFilterOnlyEntryLimit:
			partialReason = "entry_cap"
		}
	}
	return settleWindowsFilterOnlySearch(paths, partialReason, visitedDirectories, visitedEntries)
}

func settleWindowsFilterOnlySearch(
	paths []string,
	partialReason string,
	visitedDirectories int,
	visitedEntries int,
) ([]string, error) {
	if partialReason == "soft_budget" && len(paths) == 0 {
		return nil, context.DeadlineExceeded
	}
	if partialReason != "" {
		logWindowsFilterOnlyPartial(partialReason, visitedDirectories, visitedEntries, len(paths))
	}
	return paths, nil
}

func windowsFilterOnlyEligibleFile(path string, name string, mode os.FileMode, includeHidden bool) bool {
	if mode&os.ModeSymlink != 0 || (!includeHidden && strings.HasPrefix(name, ".")) {
		return false
	}
	pathPointer, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return false
	}
	attributes, err := windows.GetFileAttributes(pathPointer)
	if err != nil || attributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 ||
		attributes&windows.FILE_ATTRIBUTE_DIRECTORY != 0 {
		return false
	}
	return includeHidden || attributes&windows.FILE_ATTRIBUTE_HIDDEN == 0
}

func logWindowsFilterOnlyPartial(reason string, visitedDirectories int, visitedEntries int, resultCount int) {
	slog.Info(
		"windows filter-only file search returned bounded results",
		"partial", true,
		"partial_reason", reason,
		"visited_directory_count", visitedDirectories,
		"scanned_entry_count", visitedEntries,
		"result_count", resultCount,
	)
}

func windowsFilterOnlySoftDeadlineReached(ctx context.Context) bool {
	deadline, ok := ctx.Deadline()
	return ok && time.Until(deadline) <= windowsFilterOnlyDeadlineReserve
}

func windowsFilterOnlyTraversableDirectory(path string, name string, includeHidden bool) bool {
	if !includeHidden {
		if _, ignored := defaultSearchIgnoredDirectories[strings.ToLower(name)]; ignored {
			return false
		}
		if strings.HasPrefix(name, ".") {
			return false
		}
	}
	pathPointer, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return false
	}
	attributes, err := windows.GetFileAttributes(pathPointer)
	if err != nil || attributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		return false
	}
	return includeHidden || attributes&windows.FILE_ATTRIBUTE_HIDDEN == 0
}

func windowsFilterOnlyCandidateLimit(request localFileSearchRequest) int {
	maxCandidates := request.CandidateLimit
	if maxCandidates <= 0 {
		maxCandidates = defaultMaxSearchCandidates
	}
	resultLimit := request.ResultLimit
	if resultLimit <= 0 {
		resultLimit = workspacefiles.DefaultSearchLimit
	}
	return min(maxCandidates, max(60, resultLimit*2))
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
	extensions, includeOther := windowsSearchSelectedExtensions(filters)
	parts := make([]string, 0, len(extensions)+1)
	for _, extension := range extensions {
		parts = append(parts, "System.FileExtension = '."+windowsSearchSQLEscape(extension)+"'")
	}
	if includeOther {
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

func windowsSearchSelectedExtensions(filters []string) ([]string, bool) {
	selected := make(map[string]struct{}, len(filters))
	for _, filter := range filters {
		selected[filter] = struct{}{}
	}
	var extensions []string
	for category, categoryExtensions := range referenceFilterCategoryExtensions {
		if _, ok := selected[category]; ok {
			extensions = append(extensions, categoryExtensions...)
		}
	}
	sort.Strings(extensions)
	_, includeOther := selected["other"]
	return extensions, includeOther
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
