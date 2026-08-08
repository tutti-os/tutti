package implementationhost

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/tutti-os/tutti/packages/connector/runtime/command"
	"gopkg.in/yaml.v3"
)

const (
	connectorSkillEntryName    = "SKILL.md"
	connectorSkillMaxDepth     = 8
	connectorSkillMaxEntries   = 128
	connectorSkillMaxEntrySize = 512 * 1024
)

type ConnectorSummary struct {
	Key         string                      `json:"key"`
	Name        string                      `json:"name"`
	Description string                      `json:"description"`
	Skills      []DiscoverableSkillSummary  `json:"skills"`
	Interfaces  []ConnectorInterfaceSummary `json:"interfaces"`
}

type DiscoverableSkillSummary struct {
	Name        string `json:"name"`
	Title       string `json:"title"`
	Description string `json:"description"`
}

type ConnectorInterfaceSummary struct {
	Kind       string `json:"kind"`
	ServerName string `json:"serverName,omitempty"`
	ToolPrefix string `json:"toolPrefix,omitempty"`
	Command    string `json:"command,omitempty"`
	Status     string `json:"status"`
}

// ConnectorRoutingHint is a bounded, non-secret projection of one active
// route. It is separate from ConnectorSummary because aliases are injected into
// runtime policy while connector.available returns discoverable capabilities.
type ConnectorRoutingHint struct {
	Key         string
	DisplayName string
	Aliases     []string
	SkillRoot   string
}

type SkillSummary struct {
	Name        string `json:"name"`
	Title       string `json:"title"`
	Description string `json:"description"`
	EntryPath   string `json:"entryPath"`
	BasePath    string `json:"basePath"`
}

type Skill struct {
	SkillSummary
	Content string `json:"content"`
}

type ConnectorBroker struct {
	routes *RouteRegistry
}

func NewConnectorBroker(routes *RouteRegistry) (*ConnectorBroker, error) {
	if routes == nil {
		return nil, errors.New("connector route registry is required")
	}
	return &ConnectorBroker{routes: routes}, nil
}

func (broker *ConnectorBroker) Available() ([]ConnectorSummary, error) {
	routes := broker.routes.Routes()
	connectors := make([]ConnectorSummary, 0, len(routes))
	for _, route := range routes {
		var skills []connectorSkill
		var err error
		if strings.TrimSpace(route.InstalledRoot) != "" {
			skills, err = loadConnectorSkills(route.InstalledRoot)
			if err != nil {
				return nil, command.ServiceUnavailable("load Connector Skills", err)
			}
		}
		summaries := make([]DiscoverableSkillSummary, 0, len(skills))
		for _, skill := range skills {
			summaries = append(summaries, DiscoverableSkillSummary{Name: skill.Name, Title: skill.Title, Description: skill.Description})
		}
		interfaces := make([]ConnectorInterfaceSummary, 0, 2)
		if route.HasMCP {
			interfaces = append(interfaces, ConnectorInterfaceSummary{Kind: "mcp", ServerName: "connector",
				ToolPrefix: route.ConnectorKey + "_", Status: "ready"})
		}
		if route.CLICommand != "" {
			interfaces = append(interfaces, ConnectorInterfaceSummary{Kind: "cli", Command: route.CLICommand, Status: "ready"})
		}
		connectors = append(connectors, ConnectorSummary{Key: route.ConnectorKey, Name: route.DisplayName,
			Description: route.Description, Skills: summaries, Interfaces: interfaces})
	}
	return connectors, nil
}

func (broker *ConnectorBroker) RoutingHints() []ConnectorRoutingHint {
	routes := broker.routes.Routes()
	hints := make([]ConnectorRoutingHint, 0, len(routes))
	for _, route := range routes {
		skillRoot := activeConnectorSkillRoot(route.InstalledRoot)
		hints = append(hints, ConnectorRoutingHint{Key: route.ConnectorKey, DisplayName: route.DisplayName,
			Aliases: append([]string(nil), route.RoutingAliases...), SkillRoot: skillRoot})
	}
	return hints
}

type connectorSkill struct {
	Skill
	path string
}

func loadConnectorSkills(root string) ([]connectorSkill, error) {
	skillRoot := filepath.Join(filepath.Clean(root), "skills")
	info, err := os.Lstat(skillRoot)
	if os.IsNotExist(err) {
		return []connectorSkill{}, nil
	}
	if err != nil {
		return nil, err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return nil, errors.New("connector skills root must be a directory, not a symlink")
	}
	skills := make([]connectorSkill, 0)
	seen := make(map[string]struct{})
	err = filepath.WalkDir(skillRoot, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if path == skillRoot {
			return nil
		}
		relative, err := filepath.Rel(skillRoot, path)
		if err != nil {
			return err
		}
		depth := strings.Count(filepath.ToSlash(relative), "/") + 1
		if depth > connectorSkillMaxDepth {
			return fmt.Errorf("connector Skill tree path %q exceeds depth %d", filepath.ToSlash(relative), connectorSkillMaxDepth)
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("connector Skill tree contains symlink %q", filepath.ToSlash(relative))
		}
		if entry.IsDir() || entry.Name() != connectorSkillEntryName {
			return nil
		}
		entryInfo, err := entry.Info()
		if err != nil {
			return err
		}
		if !entryInfo.Mode().IsRegular() {
			return fmt.Errorf("connector Skill entry %q must be a regular file", filepath.ToSlash(relative))
		}
		if entryInfo.Size() > connectorSkillMaxEntrySize {
			return fmt.Errorf("connector Skill entry %q exceeds %d bytes", filepath.ToSlash(relative), connectorSkillMaxEntrySize)
		}
		content, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		metadata, err := parseConnectorSkill(string(content))
		if err != nil {
			return fmt.Errorf("%s: %w", filepath.ToSlash(relative), err)
		}
		if _, duplicate := seen[metadata.Name]; duplicate {
			return fmt.Errorf("duplicate Connector Skill %q", metadata.Name)
		}
		if len(skills) >= connectorSkillMaxEntries {
			return fmt.Errorf("connector Skill count exceeds %d", connectorSkillMaxEntries)
		}
		seen[metadata.Name] = struct{}{}
		metadata.path = path
		metadata.EntryPath = path
		metadata.BasePath = filepath.Dir(path)
		skills = append(skills, metadata)
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Slice(skills, func(left, right int) bool { return skills[left].Name < skills[right].Name })
	return skills, nil
}

func activeConnectorSkillRoot(root string) string {
	skillRoot := filepath.Join(filepath.Clean(root), "skills")
	info, err := os.Lstat(skillRoot)
	if err != nil || info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return ""
	}
	return skillRoot
}

func parseConnectorSkill(content string) (connectorSkill, error) {
	content = strings.ReplaceAll(content, "\r\n", "\n")
	if !strings.HasPrefix(content, "---\n") {
		return connectorSkill{}, errors.New("SKILL.md frontmatter is required")
	}
	end := strings.Index(content[4:], "\n---")
	if end < 0 {
		return connectorSkill{}, errors.New("SKILL.md frontmatter is malformed")
	}
	frontmatter := content[4 : 4+end]
	body := content[4+end+4:]
	var header struct {
		Name        string `yaml:"name"`
		Description string `yaml:"description"`
	}
	if err := yaml.Unmarshal([]byte(frontmatter), &header); err != nil {
		return connectorSkill{}, errors.New("SKILL.md frontmatter is malformed")
	}
	metadata := connectorSkill{Skill: Skill{SkillSummary: SkillSummary{
		Name: strings.TrimSpace(header.Name), Description: strings.TrimSpace(header.Description),
	}}}
	for _, line := range strings.Split(body, "\n") {
		if strings.HasPrefix(line, "# ") {
			metadata.Title = strings.TrimSpace(strings.TrimPrefix(line, "# "))
			break
		}
	}
	if metadata.Name == "" || metadata.Description == "" {
		return connectorSkill{}, errors.New("SKILL.md name and description are required")
	}
	if metadata.Title == "" {
		metadata.Title = metadata.Name
	}
	return metadata, nil
}
