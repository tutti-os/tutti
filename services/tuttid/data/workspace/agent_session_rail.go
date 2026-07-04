package workspace

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const (
	agentSessionRailSectionKindConversations = "conversations"
	agentSessionRailSectionKindProject       = "project"
	agentSessionRailSectionKeyConversations  = "conversations"
)

type agentSessionRailSection struct {
	Kind        string
	ProjectPath string
	Key         string
}

type existingAgentSessionRailSection struct {
	Section agentSessionRailSection
	Found   bool
	Valid   bool
}

type agentSessionRailProject struct {
	Path string
}

type agentSessionRailProjectQueryer interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

func classifyAgentSessionRailSectionTx(
	ctx context.Context,
	tx *sql.Tx,
	cwd string,
	runtimeContext map[string]any,
) (agentSessionRailSection, error) {
	projects, err := listAgentSessionRailProjects(ctx, tx)
	if err != nil {
		return agentSessionRailSection{}, err
	}
	return classifyAgentSessionRailSection(cwd, runtimeContext, projects), nil
}

func resolveAgentSessionRailSectionTx(
	ctx context.Context,
	tx *sql.Tx,
	workspaceID string,
	agentSessionID string,
	hasExisting bool,
	existingCWD string,
	finalCWD string,
	runtimeContext map[string]any,
) (agentSessionRailSection, error) {
	existingRail, err := getExistingAgentSessionRailSectionTx(ctx, tx, workspaceID, agentSessionID)
	if err != nil {
		return agentSessionRailSection{}, err
	}
	if hasExisting && existingRail.Found && existingRail.Valid && strings.TrimSpace(existingCWD) == strings.TrimSpace(finalCWD) {
		return existingRail.Section, nil
	}
	return classifyAgentSessionRailSectionTx(ctx, tx, finalCWD, runtimeContext)
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
	var section agentSessionRailSection
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

func classifyAgentSessionRailSection(
	cwd string,
	runtimeContext map[string]any,
	projects []agentSessionRailProject,
) agentSessionRailSection {
	normalizedCWD := normalizeAgentSessionRailPath(cwd)
	for _, project := range projects {
		if project.Path == normalizedCWD {
			return agentSessionRailSection{
				Kind:        agentSessionRailSectionKindProject,
				ProjectPath: project.Path,
				Key:         agentSessionRailSectionKeyForProject(project.Path),
			}
		}
	}
	if isAgentSessionNoProjectRuntimeContext(runtimeContext) || isAgentSessionScratchCWD(normalizedCWD) {
		return conversationsAgentSessionRailSection()
	}
	for _, project := range projects {
		if agentSessionRailPathContains(project.Path, normalizedCWD) {
			return agentSessionRailSection{
				Kind:        agentSessionRailSectionKindProject,
				ProjectPath: project.Path,
				Key:         agentSessionRailSectionKeyForProject(project.Path),
			}
		}
	}
	return conversationsAgentSessionRailSection()
}

func listAgentSessionRailProjects(
	ctx context.Context,
	queryer agentSessionRailProjectQueryer,
) ([]agentSessionRailProject, error) {
	rows, err := queryer.QueryContext(ctx, `
SELECT path
FROM user_projects
WHERE TRIM(path) != ''
ORDER BY length(path) DESC, path ASC
`)
	if err != nil {
		return nil, fmt.Errorf("list user projects for workspace agent session rail classification: %w", err)
	}
	defer rows.Close()

	projects := make([]agentSessionRailProject, 0)
	for rows.Next() {
		var project agentSessionRailProject
		if err := rows.Scan(&project.Path); err != nil {
			return nil, fmt.Errorf("scan user project for workspace agent session rail classification: %w", err)
		}
		project.Path = normalizeAgentSessionRailPath(project.Path)
		if project.Path != "" {
			projects = append(projects, project)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate user projects for workspace agent session rail classification: %w", err)
	}
	sort.SliceStable(projects, func(left, right int) bool {
		if len(projects[left].Path) == len(projects[right].Path) {
			return projects[left].Path < projects[right].Path
		}
		return len(projects[left].Path) > len(projects[right].Path)
	})
	return projects, nil
}

func normalizeAgentSessionRailPath(path string) string {
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
	parent = normalizeAgentSessionRailPath(parent)
	child = normalizeAgentSessionRailPath(child)
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
	value, ok := runtimeContext["externalImportNoProject"]
	if !ok {
		return false
	}
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
	home = normalizeAgentSessionRailPath(home)
	cwd = normalizeAgentSessionRailPath(cwd)
	if home == "" || cwd == "" {
		return false
	}
	for _, providerDir := range []string{"Codex", "Tutti"} {
		root := normalizeAgentSessionRailPath(filepath.Join(home, "Documents", providerDir))
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

func conversationsAgentSessionRailSection() agentSessionRailSection {
	return agentSessionRailSection{
		Kind: agentSessionRailSectionKindConversations,
		Key:  agentSessionRailSectionKeyConversations,
	}
}

func agentSessionRailSectionKeyForProject(projectPath string) string {
	projectPath = normalizeAgentSessionRailPath(projectPath)
	if projectPath == "" {
		return agentSessionRailSectionKeyConversations
	}
	return "project:" + projectPath
}

func normalizeAgentSessionRailSection(section agentSessionRailSection) agentSessionRailSection {
	section.Kind = strings.TrimSpace(section.Kind)
	section.ProjectPath = normalizeAgentSessionRailPath(section.ProjectPath)
	section.Key = strings.TrimSpace(section.Key)
	if section.Kind == agentSessionRailSectionKindConversations {
		section.ProjectPath = ""
	}
	return section
}

func isValidAgentSessionRailSection(section agentSessionRailSection) bool {
	switch section.Kind {
	case agentSessionRailSectionKindConversations:
		return section.ProjectPath == "" && section.Key == agentSessionRailSectionKeyConversations
	case agentSessionRailSectionKindProject:
		return section.ProjectPath != "" && section.Key == agentSessionRailSectionKeyForProject(section.ProjectPath)
	default:
		return false
	}
}
