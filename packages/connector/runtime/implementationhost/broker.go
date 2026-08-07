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

const invocationQueueLimit = 16

type ConnectorSummary struct {
	Key         string `json:"key"`
	Name        string `json:"name"`
	Description string `json:"description"`
}

// ConnectorRoutingHint is a bounded, non-secret projection of one active
// route. It is separate from ConnectorSummary so connector.available keeps its
// stable agent-facing response contract.
type ConnectorRoutingHint struct {
	Key         string
	DisplayName string
	Aliases     []string
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
		connectors = append(connectors, ConnectorSummary{Key: route.ConnectorKey, Name: descriptor.Name,
			Description: descriptor.Description})
	}
	return connectors, nil
}

func (broker *ConnectorBroker) RoutingHints() []ConnectorRoutingHint {
	routes := broker.commands.Routes()
	hints := make([]ConnectorRoutingHint, 0, len(routes))
	for _, route := range routes {
		hints = append(hints, ConnectorRoutingHint{Key: route.ConnectorKey, DisplayName: route.DisplayName,
			Aliases: append([]string(nil), route.RoutingAliases...)})
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
	Skills      []string        `json:"skills"`
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
	manifest, err := loadInstalledConnectorManifest(root)
	if err != nil {
		return nil, err
	}
	skills := make([]connectorSkill, 0, len(manifest.Skills))
	seen := make(map[string]struct{}, len(manifest.Skills))
	for _, relative := range manifest.Skills {
		path, err := safeConnectorSkillPath(root, relative)
		if err != nil {
			return nil, err
		}
		content, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		metadata, err := parseConnectorSkill(string(content))
		if err != nil {
			return nil, fmt.Errorf("%s: %w", relative, err)
		}
		if _, duplicate := seen[metadata.Name]; duplicate {
			return nil, fmt.Errorf("duplicate Connector Skill %q", metadata.Name)
		}
		seen[metadata.Name] = struct{}{}
		metadata.path = path
		skills = append(skills, metadata)
	}
	sort.Slice(skills, func(left, right int) bool { return skills[left].Name < skills[right].Name })
	return skills, nil
}

func safeConnectorSkillPath(root, relative string) (string, error) {
	if !strings.HasPrefix(relative, "./") || !strings.HasSuffix(relative, "/SKILL.md") {
		return "", errors.New("connector Skill path is invalid")
	}
	root = filepath.Clean(root)
	path := filepath.Clean(filepath.Join(root, filepath.FromSlash(strings.TrimPrefix(relative, "./"))))
	if path == root || !strings.HasPrefix(path, root+string(filepath.Separator)) {
		return "", errors.New("connector Skill path escapes the installed package")
	}
	return path, nil
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
	if metadata.Name == "" || metadata.Description == "" || metadata.Title == "" {
		return connectorSkill{}, errors.New("SKILL.md name, description, and level-1 title are required")
	}
	return metadata, nil
}
