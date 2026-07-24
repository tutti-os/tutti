package storesqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

var ErrRailSectionConflict = errors.New("workspace agent session rail section conflicts with canonical state")

// Rail section classification buckets sessions in the conversation rail:
// sessions rooted in a known project path land in that project's section,
// everything else in the shared conversations section.
const (
	RailSectionKindConversations = "conversations"
	RailSectionKindProject       = "project"
	RailSectionKeyConversations  = "conversations"
)

// RailSection identifies the rail section a session is classified into.
type RailSection struct {
	Kind        string
	ProjectPath string
	Key         string
}

type existingAgentSessionRailSection struct {
	Section RailSection
	Found   bool
	Valid   bool
}

func (s *Store) classifyAgentSessionRailSectionTx(
	ctx context.Context,
	tx *sql.Tx,
	cwd string,
	runtimeContext map[string]any,
) (RailSection, error) {
	projects, err := s.listRailProjectPaths(ctx, tx)
	if err != nil {
		return RailSection{}, err
	}
	return ClassifyRailSection(cwd, runtimeContext, projects), nil
}

func (s *Store) resolveAgentSessionRailSectionTx(
	ctx context.Context,
	tx *sql.Tx,
	workspaceID string,
	agentSessionID string,
	finalCWD string,
	runtimeContext map[string]any,
	importProjectPath string,
	explicitPlacement *RailSection,
) (RailSection, error) {
	existingRail, err := getExistingAgentSessionRailSectionTx(ctx, tx, workspaceID, agentSessionID)
	if err != nil {
		return RailSection{}, err
	}
	explicitRail, hasExplicitRail, err := explicitAgentSessionRailSection(explicitPlacement)
	if err != nil {
		return RailSection{}, err
	}
	importRail, hasImportRail := importedAgentSessionRailSection(
		finalCWD,
		runtimeContext,
		importProjectPath,
	)
	// Rail membership is assigned when the session is first persisted and is
	// immutable afterwards. Runtime cwd changes must not silently move an
	// existing conversation between rail sections. Historical imports may
	// repair an older ancestor assignment when the same import supplies its
	// exact selected project path.
	if existingRail.Found && existingRail.Valid {
		if hasExplicitRail && existingRail.Section != explicitRail {
			return RailSection{}, ErrRailSectionConflict
		}
		if hasImportRail && shouldRepairImportedAgentSessionRailSection(existingRail.Section, importRail) {
			return importRail, nil
		}
		return existingRail.Section, nil
	}
	if hasExplicitRail {
		return explicitRail, nil
	}
	if hasImportRail {
		return importRail, nil
	}
	return s.classifyAgentSessionRailSectionTx(ctx, tx, finalCWD, runtimeContext)
}

func explicitAgentSessionRailSection(placement *RailSection) (RailSection, bool, error) {
	if placement == nil {
		return RailSection{}, false, nil
	}
	section := normalizeAgentSessionRailSection(*placement)
	if !isValidAgentSessionRailSection(section) {
		return RailSection{}, false, fmt.Errorf("invalid explicit workspace agent rail section")
	}
	return section, true, nil
}

func importedAgentSessionRailSection(
	cwd string,
	runtimeContext map[string]any,
	projectPath string,
) (RailSection, bool) {
	if !runtimeContextBool(runtimeContext["imported"]) || isAgentSessionNoProjectRuntimeContext(runtimeContext) {
		return RailSection{}, false
	}
	projectPath = NormalizeProjectPath(projectPath)
	if projectPath == "" || !agentSessionRailPathContains(projectPath, cwd) {
		return RailSection{}, false
	}
	return RailSection{
		Kind:        RailSectionKindProject,
		ProjectPath: projectPath,
		Key:         RailSectionKeyForProject(projectPath),
	}, true
}

func shouldRepairImportedAgentSessionRailSection(existing RailSection, requested RailSection) bool {
	if existing.Key == requested.Key {
		return false
	}
	if existing.Kind == RailSectionKindConversations {
		return true
	}
	return existing.Kind == RailSectionKindProject &&
		agentSessionRailPathContains(existing.ProjectPath, requested.ProjectPath)
}

func getExistingAgentSessionRailSectionTx(
	ctx context.Context,
	tx *sql.Tx,
	workspaceID string,
	agentSessionID string,
) (existingAgentSessionRailSection, error) {
	row := tx.QueryRowContext(ctx, `
SELECT rail_section_kind, rail_project_path, rail_section_key
FROM workspace_agent_sessions
WHERE workspace_id = ? AND agent_session_id = ?
`, workspaceID, agentSessionID)
	var section RailSection
	if err := row.Scan(&section.Kind, &section.ProjectPath, &section.Key); err != nil {
		if err == sql.ErrNoRows {
			return existingAgentSessionRailSection{}, nil
		}
		return existingAgentSessionRailSection{}, fmt.Errorf("get workspace agent session rail section: %w", err)
	}
	section = normalizeAgentSessionRailSection(section)
	return existingAgentSessionRailSection{
		Section: section,
		Found:   true,
		Valid:   isValidAgentSessionRailSection(section),
	}, nil
}

func (s *Store) getAgentSessionRailSection(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
) (RailSection, bool, error) {
	row := s.db.QueryRowContext(ctx, `
SELECT rail_section_kind, rail_project_path, rail_section_key
FROM workspace_agent_sessions
WHERE workspace_id = ? AND agent_session_id = ? AND deleted_at_unix_ms = 0
`, workspaceID, agentSessionID)
	var section RailSection
	if err := row.Scan(&section.Kind, &section.ProjectPath, &section.Key); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return RailSection{}, false, nil
		}
		return RailSection{}, false, fmt.Errorf("get workspace agent session rail section: %w", err)
	}
	section = normalizeAgentSessionRailSection(section)
	if !isValidAgentSessionRailSection(section) {
		return RailSection{}, false, fmt.Errorf(
			"workspace agent session %q has an invalid rail section",
			agentSessionID,
		)
	}
	return section, true, nil
}

// ClassifyRailSection classifies a session working directory against the
// given project root paths. Project paths are normalized and matched
// longest-first; sessions marked as external imports without a project, or
// living in scratch date directories, always classify as conversations
// unless the cwd is itself a project root.
func ClassifyRailSection(
	cwd string,
	runtimeContext map[string]any,
	projectPaths []string,
) RailSection {
	projects := normalizeRailProjectPaths(projectPaths)
	normalizedCWD := NormalizeProjectPath(cwd)
	for _, project := range projects {
		if project == normalizedCWD {
			return RailSection{
				Kind:        RailSectionKindProject,
				ProjectPath: project,
				Key:         RailSectionKeyForProject(project),
			}
		}
	}
	if isAgentSessionNoProjectRuntimeContext(runtimeContext) || isAgentSessionScratchCWD(normalizedCWD) {
		return conversationsAgentSessionRailSection()
	}
	for _, project := range projects {
		if agentSessionRailPathContains(project, normalizedCWD) {
			return RailSection{
				Kind:        RailSectionKindProject,
				ProjectPath: project,
				Key:         RailSectionKeyForProject(project),
			}
		}
	}
	return conversationsAgentSessionRailSection()
}

func (s *Store) listRailProjectPaths(ctx context.Context, q Querier) ([]string, error) {
	if s.opts.ProjectPaths == nil {
		return nil, nil
	}
	return s.opts.ProjectPaths.ProjectPaths(ctx, q)
}

func normalizeRailProjectPaths(paths []string) []string {
	projects := make([]string, 0, len(paths))
	for _, path := range paths {
		path = NormalizeProjectPath(path)
		if path != "" {
			projects = append(projects, path)
		}
	}
	sort.SliceStable(projects, func(left, right int) bool {
		if len(projects[left]) == len(projects[right]) {
			return projects[left] < projects[right]
		}
		return len(projects[left]) > len(projects[right])
	})
	return projects
}

// NormalizeProjectPath canonicalizes a project or session path the same way
// rail classification does: absolute, symlink-resolved for existing
// directories, and cleaned.
func NormalizeProjectPath(path string) string {
	path = strings.TrimSpace(path)
	if path == "" {
		return ""
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return filepath.Clean(path)
	}
	if info, statErr := os.Stat(absolute); statErr == nil && info.IsDir() {
		if evaluated, evalErr := filepath.EvalSymlinks(absolute); evalErr == nil {
			absolute = evaluated
		}
	}
	return filepath.Clean(absolute)
}

func agentSessionRailPathContains(parent string, child string) bool {
	parent = NormalizeProjectPath(parent)
	child = NormalizeProjectPath(child)
	if parent == "" || child == "" {
		return false
	}
	if parent == child {
		return true
	}
	rel, err := filepath.Rel(parent, child)
	if err != nil {
		return false
	}
	return rel != "." && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

func isAgentSessionNoProjectRuntimeContext(runtimeContext map[string]any) bool {
	for _, key := range []string{"noProject", "externalImportNoProject"} {
		if runtimeContextBool(runtimeContext[key]) {
			return true
		}
	}
	return false
}

func runtimeContextBool(value any) bool {
	switch typed := value.(type) {
	case bool:
		return typed
	case string:
		return strings.EqualFold(strings.TrimSpace(typed), "true")
	default:
		return false
	}
}

func isAgentSessionScratchCWD(cwd string) bool {
	home, err := os.UserHomeDir()
	if err != nil {
		return false
	}
	home = NormalizeProjectPath(home)
	cwd = NormalizeProjectPath(cwd)
	if home == "" || cwd == "" {
		return false
	}
	for _, providerDir := range []string{"Codex", "Tutti"} {
		root := NormalizeProjectPath(filepath.Join(home, "Documents", providerDir))
		rel, err := filepath.Rel(root, cwd)
		if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			continue
		}
		parts := strings.Split(filepath.ToSlash(rel), "/")
		if len(parts) == 2 && parts[1] != "" && isAgentSessionRailDateSegment(parts[0]) {
			return true
		}
	}
	return false
}

func isAgentSessionRailDateSegment(value string) bool {
	if len(value) != len("2006-01-02") || value[4] != '-' || value[7] != '-' {
		return false
	}
	for index, char := range value {
		if index == 4 || index == 7 {
			continue
		}
		if char < '0' || char > '9' {
			return false
		}
	}
	return true
}

func conversationsAgentSessionRailSection() RailSection {
	return RailSection{
		Kind: RailSectionKindConversations,
		Key:  RailSectionKeyConversations,
	}
}

// RailSectionKeyForProject returns the section key sessions classified into
// the given project are stored under, matching the SectionKey accepted by
// ListSessionSection.
func RailSectionKeyForProject(projectPath string) string {
	projectPath = NormalizeProjectPath(projectPath)
	if projectPath == "" {
		return RailSectionKeyConversations
	}
	return "project:" + projectPath
}

func normalizeAgentSessionRailSection(section RailSection) RailSection {
	section.Kind = strings.TrimSpace(section.Kind)
	section.ProjectPath = NormalizeProjectPath(section.ProjectPath)
	section.Key = strings.TrimSpace(section.Key)
	if section.Kind == RailSectionKindConversations {
		section.ProjectPath = ""
	}
	return section
}

func isValidAgentSessionRailSection(section RailSection) bool {
	switch section.Kind {
	case RailSectionKindConversations:
		return section.ProjectPath == "" && section.Key == RailSectionKeyConversations
	case RailSectionKindProject:
		return section.ProjectPath != "" &&
			section.Key != "" &&
			section.Key != RailSectionKeyConversations
	default:
		return false
	}
}
