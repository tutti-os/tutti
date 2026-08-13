//go:build darwin

package workspace

import (
	"bufio"
	"context"
	"errors"
	"io"
	"os/exec"
	"strings"
)

type spotlightSearchProvider struct{}

func newPlatformLocalFileSearchProvider() localFileSearchProvider {
	return spotlightSearchProvider{}
}

func (spotlightSearchProvider) Name() string {
	return "macos-spotlight"
}

func (spotlightSearchProvider) Search(
	ctx context.Context,
	request localFileSearchRequest,
) ([]string, error) {
	command := exec.CommandContext(
		ctx,
		"mdfind",
		"-onlyin", request.SearchRootPath,
		spotlightSearchQuery(request),
	)
	stdout, err := command.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := command.Start(); err != nil {
		return nil, err
	}
	limit := request.CandidateLimit
	if limit <= 0 {
		limit = defaultMaxSearchCandidates
	}
	paths := make([]string, 0, request.CandidateLimit)
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	limitReached := false
	for scanner.Scan() {
		value := strings.TrimSpace(scanner.Text())
		if value == "" {
			continue
		}
		paths = append(paths, value)
		if len(paths) >= limit {
			limitReached = true
			_ = command.Process.Kill()
			break
		}
	}
	scanErr := scanner.Err()
	waitErr := command.Wait()
	if ctxErr := ctx.Err(); ctxErr != nil {
		return nil, ctxErr
	}
	if scanErr != nil && !errors.Is(scanErr, io.ErrClosedPipe) {
		return nil, scanErr
	}
	if waitErr != nil && !limitReached {
		return nil, waitErr
	}
	return paths, nil
}

func spotlightSearchQuery(request localFileSearchRequest) string {
	var clauses []string
	for _, token := range strings.Fields(request.Query) {
		escaped := spotlightQueryEscape(token)
		clauses = append(clauses,
			"(kMDItemFSName == '*"+escaped+"*'cd || kMDItemPath == '*"+escaped+"*'cd)",
		)
	}
	if kindClause := spotlightKindClause(request); kindClause != "" {
		clauses = append(clauses, kindClause)
	}
	if filterClause := spotlightFilterClause(request.Filters); filterClause != "" {
		clauses = append(clauses, filterClause)
	}
	if ignoredClause := spotlightIgnoredDirectoriesClause(request); ignoredClause != "" {
		clauses = append(clauses, ignoredClause)
	}
	if len(clauses) == 0 {
		return "kMDItemFSName == '*'cd"
	}
	return strings.Join(clauses, " && ")
}

func spotlightIgnoredDirectoriesClause(request localFileSearchRequest) string {
	if request.IncludeHidden {
		return ""
	}
	parts := make([]string, 0, len(nativeSearchIgnoredDirectoryNames)*2)
	for _, name := range nativeSearchIgnoredDirectoryNames {
		escapedName := spotlightQueryEscape(name)
		parts = append(parts,
			"kMDItemPath != '*/"+escapedName+"/*'cd",
			"kMDItemPath != '*/"+escapedName+"'cd",
		)
	}
	return "(" + strings.Join(parts, " && ") + ")"
}

func spotlightKindClause(request localFileSearchRequest) string {
	files, directories := localFileSearchRequestedKinds(request)
	switch {
	case files && !directories:
		return "kMDItemContentTypeTree != 'public.directory'"
	case !files && directories:
		return "kMDItemContentTypeTree == 'public.directory'"
	case !files && !directories:
		return "kMDItemFSName == '__tutti_no_matching_entry_kind__'c"
	default:
		return ""
	}
}

func spotlightFilterClause(filters []string) string {
	selected := make(map[string]struct{}, len(filters))
	for _, filter := range filters {
		selected[filter] = struct{}{}
	}
	if len(selected) == 0 {
		return ""
	}
	var parts []string
	for category, extensions := range referenceFilterCategoryExtensions {
		if _, ok := selected[category]; !ok {
			continue
		}
		for _, extension := range extensions {
			parts = append(parts, "kMDItemFSName == '*."+spotlightQueryEscape(extension)+"'cd")
		}
	}
	if _, includeOther := selected["other"]; includeOther {
		var exclusions []string
		for _, extension := range allKnownReferenceFilterExtensions() {
			exclusions = append(exclusions,
				"kMDItemFSName != '*."+spotlightQueryEscape(extension)+"'cd",
			)
		}
		parts = append(parts, "("+strings.Join(exclusions, " && ")+")")
	}
	if len(parts) == 0 {
		return "kMDItemFSName == '__tutti_no_matching_file_type__'c"
	}
	return "(" + strings.Join(parts, " || ") + ")"
}

func spotlightQueryEscape(value string) string {
	value = strings.ReplaceAll(value, "\\", "\\\\")
	value = strings.ReplaceAll(value, "'", "\\'")
	return strings.ReplaceAll(value, "*", "\\*")
}
