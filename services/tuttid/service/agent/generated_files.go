package agent

import (
	"context"
	"fmt"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	workspacefiles "github.com/tutti-os/tutti/packages/workspace/files"
	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
)

const (
	generatedFilesCacheTTL = 10 * time.Second
	generatedFilesMaxItems = 200
)

type generatedFilesCacheEntry struct {
	expiresAt time.Time
	value     generatedFilesBase
}

type generatedFilesBase struct {
	files      []generatedFileState
	searchRoot string
}

type generatedFileState struct {
	agentTargetID string
	path          string
}

func (s *Service) cachedGeneratedFilesBase(
	ctx context.Context,
	reader GeneratedFileTurnReader,
	workspaceID string,
	sectionKey string,
) (generatedFilesBase, bool) {
	now := time.Now()
	if s.GeneratedFilesClock != nil {
		now = s.GeneratedFilesClock()
	}
	cacheKey := workspaceID + "\x00" + sectionKey
	s.generatedFilesCacheMu.Lock()
	if entry, ok := s.generatedFilesCache[cacheKey]; ok && now.Before(entry.expiresAt) {
		s.generatedFilesCacheMu.Unlock()
		return entry.value, true
	}
	s.generatedFilesCacheMu.Unlock()

	turns, ok := reader.ListWorkspaceGeneratedFileTurns(ctx, agentactivitybiz.ListWorkspaceGeneratedFileTurnsInput{
		WorkspaceID: workspaceID,
		SectionKey:  sectionKey,
	})
	if !ok {
		return generatedFilesBase{}, false
	}
	base := combineGeneratedFileTurns(turns.Turns)
	s.generatedFilesCacheMu.Lock()
	if s.generatedFilesCache == nil {
		s.generatedFilesCache = make(map[string]generatedFilesCacheEntry)
	}
	for key, entry := range s.generatedFilesCache {
		if !now.Before(entry.expiresAt) {
			delete(s.generatedFilesCache, key)
		}
	}
	s.generatedFilesCache[cacheKey] = generatedFilesCacheEntry{
		expiresAt: now.Add(generatedFilesCacheTTL),
		value:     base,
	}
	s.generatedFilesCacheMu.Unlock()
	return base, true
}

func combineGeneratedFileTurns(turns []agentactivitybiz.GeneratedFileTurn) generatedFilesBase {
	searchRoot := generatedFilesSearchRoot(turns)
	seen := make(map[string]struct{})
	files := make([]generatedFileState, 0)
	for _, turn := range turns {
		turnProjectRoot := normalizeGeneratedFileAbsolutePath(turn.RailProjectPath, "")
		if turn.RailSectionKind == "project" && (searchRoot == "" || turnProjectRoot != searchRoot) {
			continue
		}
		for _, change := range turn.Changes {
			kind := strings.ToLower(strings.TrimSpace(change.Change))
			if kind != "added" && kind != "modified" && kind != "deleted" {
				continue
			}
			filePath := normalizeGeneratedFileAbsolutePath(change.Path, turn.CWD)
			if filePath == "" {
				continue
			}
			if turn.RailSectionKind == "project" && !generatedFilePathWithin(searchRoot, filePath) {
				continue
			}
			if _, exists := seen[filePath]; exists {
				continue
			}
			seen[filePath] = struct{}{}
			if kind == "deleted" {
				continue
			}
			files = append(files, generatedFileState{
				agentTargetID: strings.TrimSpace(turn.AgentTargetID),
				path:          filePath,
			})
		}
	}
	return generatedFilesBase{files: files, searchRoot: searchRoot}
}

func generatedFilesSearchRoot(turns []agentactivitybiz.GeneratedFileTurn) string {
	for _, turn := range turns {
		switch turn.RailSectionKind {
		case "project":
			if root := normalizeGeneratedFileAbsolutePath(turn.RailProjectPath, ""); root != "" {
				return root
			}
		case "conversations":
			return string(filepath.Separator)
		}
	}
	return string(filepath.Separator)
}

func normalizeGeneratedFileAbsolutePath(rawPath string, cwd string) string {
	rawPath = strings.TrimSpace(rawPath)
	if rawPath == "" || strings.HasPrefix(rawPath, "{") || strings.HasPrefix(rawPath, "[") {
		return ""
	}
	if !filepath.IsAbs(rawPath) {
		cwd = strings.TrimSpace(cwd)
		if cwd == "" {
			return ""
		}
		rawPath = filepath.Join(cwd, rawPath)
	}
	absolute, err := filepath.Abs(rawPath)
	if err != nil {
		return ""
	}
	return filepath.Clean(absolute)
}

func generatedFilePathWithin(root string, filePath string) bool {
	if root == "" || filePath == "" {
		return false
	}
	relative, err := filepath.Rel(root, filePath)
	if err != nil {
		return false
	}
	return relative == "." || (relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)))
}

func pageGeneratedFiles(
	workspaceID string,
	base generatedFilesBase,
	query string,
	agentTargetIDs []string,
	offset int,
	limit int,
) GeneratedFileList {
	agentTargets := make(map[string]struct{}, len(agentTargetIDs))
	for _, agentTargetID := range agentTargetIDs {
		agentTargets[agentTargetID] = struct{}{}
	}
	filtered := make([]generatedFileState, 0, len(base.files))
	for _, file := range base.files {
		if len(agentTargets) > 0 {
			if _, ok := agentTargets[file.agentTargetID]; !ok {
				continue
			}
		}
		filtered = append(filtered, file)
	}
	if query != "" {
		filtered = rankGeneratedFiles(base.searchRoot, query, filtered)
	} else if len(filtered) > generatedFilesMaxItems {
		filtered = filtered[:generatedFilesMaxItems]
	}
	if offset > len(filtered) {
		offset = len(filtered)
	}
	end := offset + limit
	if end > len(filtered) {
		end = len(filtered)
	}
	files := make([]GeneratedFile, 0, end-offset)
	for _, file := range filtered[offset:end] {
		files = append(files, GeneratedFile{Path: file.path, Label: filepath.Base(file.path)})
	}
	hasMore := end < len(filtered)
	nextCursor := ""
	if hasMore {
		nextCursor = fmt.Sprintf("v1:%d", end)
	}
	return GeneratedFileList{
		WorkspaceID: workspaceID,
		Files:       files,
		HasMore:     hasMore,
		NextCursor:  nextCursor,
	}
}

func rankGeneratedFiles(root string, query string, files []generatedFileState) []generatedFileState {
	if root == "" {
		root = string(filepath.Separator)
	}
	byPath := make(map[string]generatedFileState, len(files))
	candidates := make([]workspacefiles.SearchCandidate, 0, len(files))
	for _, file := range files {
		relative, err := filepath.Rel(root, file.path)
		if err != nil || relative == "." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) || relative == ".." {
			continue
		}
		relative = filepath.ToSlash(relative)
		candidatePath := filepath.ToSlash(file.path)
		byPath[candidatePath] = file
		candidates = append(candidates, workspacefiles.SearchCandidate{
			Kind:         workspacefiles.EntryKindFile,
			RelativePath: relative,
		})
	}
	entries := workspacefiles.ScoreSearchCandidates(
		workspacefiles.LogicalPath(filepath.ToSlash(root)),
		query,
		candidates,
		generatedFilesMaxItems,
	)
	result := make([]generatedFileState, 0, len(entries))
	for _, entry := range entries {
		if file, ok := byPath[entry.Path.String()]; ok {
			result = append(result, file)
		}
	}
	return result
}

func parseGeneratedFilesCursor(raw string) (int, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 0, nil
	}
	if !strings.HasPrefix(raw, "v1:") {
		return 0, fmt.Errorf("unsupported generated files cursor")
	}
	offset, err := strconv.Atoi(strings.TrimPrefix(raw, "v1:"))
	if err != nil || offset < 0 || offset > generatedFilesMaxItems {
		return 0, fmt.Errorf("invalid generated files cursor")
	}
	return offset, nil
}
