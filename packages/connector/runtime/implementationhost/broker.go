package implementationhost

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"github.com/tutti-os/tutti/packages/connector/runtime/command"
	"gopkg.in/yaml.v3"
)

const (
	invocationQueueLimit       = 16
	connectorSkillEntryName    = "SKILL.md"
	connectorSkillMaxDepth     = 8
	connectorSkillMaxEntries   = 128
	connectorSkillMaxEntrySize = 512 * 1024
)

type ConnectorSummary struct {
	Key         string         `json:"key"`
	Name        string         `json:"name"`
	Description string         `json:"description"`
	Skills      []SkillSummary `json:"skills"`
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

type CapabilitySummary struct {
	ID          string         `json:"id"`
	Kind        string         `json:"kind"`
	Name        string         `json:"name"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"inputSchema"`
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
	commands *CommandRegistry
	gatesMu  sync.Mutex
	gates    map[string]*invocationGate
}

type invocationGate struct {
	mu      sync.Mutex
	waiters int
	slot    chan struct{}
}

func NewConnectorBroker(commands *CommandRegistry) (*ConnectorBroker, error) {
	if commands == nil {
		return nil, errors.New("connector command registry is required")
	}
	return &ConnectorBroker{commands: commands, gates: make(map[string]*invocationGate)}, nil
}

func (broker *ConnectorBroker) Available() ([]ConnectorSummary, error) {
	routes := broker.commands.Routes()
	connectors := make([]ConnectorSummary, 0, len(routes))
	for _, route := range routes {
		descriptor, err := loadConnectorDescriptor(route.InstalledRoot)
		if err != nil {
			return nil, command.ServiceUnavailable("load Connector description", err)
		}
		skills, err := loadConnectorSkills(route.InstalledRoot)
		if err != nil {
			return nil, command.ServiceUnavailable("load Connector Skills", err)
		}
		summaries := make([]SkillSummary, 0, len(skills))
		for _, skill := range skills {
			summaries = append(summaries, skill.SkillSummary)
		}
		connectors = append(connectors, ConnectorSummary{Key: route.ConnectorKey, Name: descriptor.Name,
			Description: descriptor.Description, Skills: summaries})
	}
	return connectors, nil
}

func (broker *ConnectorBroker) RoutingHints() []ConnectorRoutingHint {
	routes := broker.commands.Routes()
	hints := make([]ConnectorRoutingHint, 0, len(routes))
	for _, route := range routes {
		skillRoot := activeConnectorSkillRoot(route.InstalledRoot)
		hints = append(hints, ConnectorRoutingHint{Key: route.ConnectorKey, DisplayName: route.DisplayName,
			Aliases: append([]string(nil), route.RoutingAliases...), SkillRoot: skillRoot})
	}
	return hints
}

func (broker *ConnectorBroker) Skills(connectorKey string) ([]SkillSummary, error) {
	route, err := broker.activeRoute(connectorKey)
	if err != nil {
		return nil, err
	}
	skills, err := loadConnectorSkills(route.InstalledRoot)
	if err != nil {
		return nil, command.ServiceUnavailable("load Connector Skills", err)
	}
	result := make([]SkillSummary, 0, len(skills))
	for _, skill := range skills {
		result = append(result, skill.SkillSummary)
	}
	return result, nil
}

func (broker *ConnectorBroker) Capabilities(connectorKey string) ([]CapabilitySummary, error) {
	connectorKey = strings.TrimSpace(connectorKey)
	if _, err := broker.activeRoute(connectorKey); err != nil {
		return nil, err
	}
	return broker.commands.CapabilitiesForConnector(connectorKey), nil
}

func (broker *ConnectorBroker) ReadSkill(connectorKey, skillName string) (Skill, error) {
	route, err := broker.activeRoute(connectorKey)
	if err != nil {
		return Skill{}, err
	}
	skills, err := loadConnectorSkills(route.InstalledRoot)
	if err != nil {
		return Skill{}, command.ServiceUnavailable("load Connector Skills", err)
	}
	for _, skill := range skills {
		if skill.Name != strings.TrimSpace(skillName) {
			continue
		}
		content, err := os.ReadFile(skill.path)
		if err != nil {
			return Skill{}, command.ServiceUnavailable("read Connector Skill", err)
		}
		skill.Content = string(content)
		return skill.Skill, nil
	}
	return Skill{}, command.InvalidInput("connector_skill_not_found", "Connector Skill was not found", nil)
}

func (broker *ConnectorBroker) Invoke(ctx context.Context, connectorKey, capabilityID string,
	input map[string]any, invokeContext command.InvokeContext) (command.Output, error) {
	connectorKey = strings.TrimSpace(connectorKey)
	if _, err := broker.activeRoute(connectorKey); err != nil {
		return command.Output{}, err
	}
	release, err := broker.acquireInvocation(ctx, connectorKey)
	if err != nil {
		return command.Output{}, err
	}
	defer release()
	return broker.commands.InvokeConnector(ctx, connectorKey, strings.TrimSpace(capabilityID), command.InvokeRequest{
		Input: input, Context: invokeContext,
	})
}

func (broker *ConnectorBroker) acquireInvocation(ctx context.Context, connectorKey string) (func(), error) {
	broker.gatesMu.Lock()
	gate := broker.gates[connectorKey]
	if gate == nil {
		gate = &invocationGate{slot: make(chan struct{}, 1)}
		gate.slot <- struct{}{}
		broker.gates[connectorKey] = gate
	}
	broker.gatesMu.Unlock()
	gate.mu.Lock()
	if gate.waiters >= invocationQueueLimit {
		gate.mu.Unlock()
		return nil, command.ServiceUnavailable("Connector invocation queue is full", nil)
	}
	gate.waiters++
	gate.mu.Unlock()
	select {
	case <-ctx.Done():
		gate.mu.Lock()
		gate.waiters--
		gate.mu.Unlock()
		return nil, ctx.Err()
	case <-gate.slot:
		gate.mu.Lock()
		gate.waiters--
		gate.mu.Unlock()
		return func() { gate.slot <- struct{}{} }, nil
	}
}

func (broker *ConnectorBroker) activeRoute(connectorKey string) (RouteDescriptor, error) {
	connectorKey = strings.TrimSpace(connectorKey)
	if connectorKey == "" {
		return RouteDescriptor{}, command.InvalidInput("connector_key_required", "connector is required", nil)
	}
	for _, route := range broker.commands.Routes() {
		if route.ConnectorKey == connectorKey {
			return route, nil
		}
	}
	return RouteDescriptor{}, command.ServiceUnavailable("Connector runtime is not active", nil)
}

type installedConnectorManifest struct {
	Name        json.RawMessage `json:"name"`
	Description json.RawMessage `json:"description"`
}

type connectorDescriptor struct {
	Name        string
	Description string
}

type connectorSkill struct {
	Skill
	path string
}

func loadConnectorDescriptor(root string) (connectorDescriptor, error) {
	manifest, err := loadInstalledConnectorManifest(root)
	if err != nil {
		return connectorDescriptor{}, err
	}
	name, err := connectorLocalizedText(manifest.Name)
	if err != nil {
		return connectorDescriptor{}, fmt.Errorf("connector name: %w", err)
	}
	description, err := connectorLocalizedText(manifest.Description)
	if err != nil {
		return connectorDescriptor{}, fmt.Errorf("connector description: %w", err)
	}
	return connectorDescriptor{Name: name, Description: description}, nil
}

func loadInstalledConnectorManifest(root string) (installedConnectorManifest, error) {
	manifestBytes, err := os.ReadFile(filepath.Join(root, "tutti.connector.json"))
	if err != nil {
		return installedConnectorManifest{}, err
	}
	var manifest installedConnectorManifest
	if err := json.Unmarshal(manifestBytes, &manifest); err != nil {
		return installedConnectorManifest{}, err
	}
	return manifest, nil
}

func connectorLocalizedText(raw json.RawMessage) (string, error) {
	var text string
	if err := json.Unmarshal(raw, &text); err == nil && strings.TrimSpace(text) != "" {
		return strings.TrimSpace(text), nil
	}
	var localized map[string]string
	if err := json.Unmarshal(raw, &localized); err != nil {
		return "", err
	}
	for _, locale := range []string{"en-US", "en", "zh-CN"} {
		if value := strings.TrimSpace(localized[locale]); value != "" {
			return value, nil
		}
	}
	locales := make([]string, 0, len(localized))
	for locale := range localized {
		locales = append(locales, locale)
	}
	sort.Strings(locales)
	for _, locale := range locales {
		if value := strings.TrimSpace(localized[locale]); value != "" {
			return value, nil
		}
	}
	return "", errors.New("localized text is empty")
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
