package runtimeprep

import (
	"context"
	"errors"
	"fmt"
	"path"
	"sort"
	"strings"
)

type PolicyAnchor string

const (
	PolicyAnchorEnvironment   PolicyAnchor = "environment"
	PolicyAnchorTools         PolicyAnchor = "tools"
	PolicyAnchorSkillStrategy PolicyAnchor = "skill-strategy"
	PolicyAnchorSpecialized   PolicyAnchor = "specialized"
)

var policyAnchorRank = map[PolicyAnchor]int{
	PolicyAnchorEnvironment: 0, PolicyAnchorTools: 1,
	PolicyAnchorSkillStrategy: 2, PolicyAnchorSpecialized: 3,
}

type PolicySection struct {
	Anchor   PolicyAnchor
	Key      string
	Order    int
	Delivery PolicyDelivery
	Body     string
}

type PolicyDelivery string

const (
	PolicyDeliveryProviderRuntime PolicyDelivery = "provider-runtime"
	PolicyDeliverySkillBundle     PolicyDelivery = "skill-bundle"
)

type SkillSpec struct {
	ID        string
	Name      string
	Files     map[string]string
	Providers []string
	Source    string
}

type ProviderSkillBundle = SkillSpec

type CapabilityContribution struct {
	Enabled        bool
	Skills         []SkillSpec
	PolicySections []PolicySection
	EnvOverlay     []string
}

type CapabilityPack struct {
	Name    string
	Resolve func(context.Context, PrepareInput) (CapabilityContribution, error)
}

type DeploymentProfile struct {
	Name      string
	Title     string
	Intro     string
	HostFacts HostFacts
	Packs     []CapabilityPack
}

type SkillContext struct {
	WorkspaceID    string
	AgentSessionID string
	Provider       string
	Cwd            string
}

type SkillSource interface {
	Skills(context.Context, SkillContext) ([]SkillSpec, error)
}

type resolvedCapabilities struct {
	Title          string
	Intro          string
	HostFacts      HostFacts
	Skills         []SkillSpec
	PolicySections []PolicySection
	EnvOverlay     []string
}

type ResolvedBundle struct {
	SystemPrompt string
	Skills       []SkillSpec
	EnvOverlay   []string
}

// Resolve composes a deployment profile without materializing provider files.
// DefaultPreparer uses the same resolver before provider preparation.
func Resolve(ctx context.Context, input PrepareInput, profile DeploymentProfile, sources ...SkillSource) (ResolvedBundle, error) {
	resolved, err := resolveCapabilities(ctx, input, profile, sources)
	if err != nil {
		return ResolvedBundle{}, err
	}
	input.resolved = resolved
	systemPrompt, err := tuttiCLIPolicy(input)
	if err != nil {
		return ResolvedBundle{}, err
	}
	return ResolvedBundle{
		SystemPrompt: systemPrompt,
		Skills:       append([]SkillSpec(nil), resolved.Skills...),
		EnvOverlay:   append([]string(nil), resolved.EnvOverlay...),
	}, nil
}

func StandardProfile() DeploymentProfile {
	return DeploymentProfile{
		Name:      "tutti-standard",
		Title:     "Tutti Runtime",
		Intro:     "This directory is being used by a Tutti AgentGUI session.",
		HostFacts: DefaultHostFacts(),
		Packs: []CapabilityPack{
			CoreSkillsPack(), TuttiDesktopHostPack(), BrowserUsePack(), ComputerUsePack(),
		},
	}
}

// CoreSkillsPack contributes the provider-neutral Tutti CLI and mention
// routing skills. Deployment profiles should include this pack when they want
// the shared skills without inheriting Tutti desktop-host policy.
func CoreSkillsPack() CapabilityPack {
	return CapabilityPack{Name: "tutti-core-skills", Resolve: func(_ context.Context, input PrepareInput) (CapabilityContribution, error) {
		tuttiCLI, err := tuttiCLISkill(input)
		if err != nil {
			return CapabilityContribution{}, err
		}
		handoff, err := tuttiHandoffSkill(input)
		if err != nil {
			return CapabilityContribution{}, err
		}
		issueManager, err := issueManagerSkill(input)
		if err != nil {
			return CapabilityContribution{}, err
		}
		workspaceApp, err := workspaceAppSkill(input)
		if err != nil {
			return CapabilityContribution{}, err
		}
		reference, err := referenceSkill(input)
		if err != nil {
			return CapabilityContribution{}, err
		}
		commandGuide, err := commandGuideReference(input)
		if err != nil {
			return CapabilityContribution{}, err
		}
		return CapabilityContribution{Enabled: true, Skills: []SkillSpec{
			{ID: "tutti/tutti-cli", Name: tuttiSkillName, Files: map[string]string{"SKILL.md": tuttiCLI, commandGuideReferencePath: commandGuide}},
			{ID: "tutti/tutti-handoff", Name: tuttiHandoffSkillName, Files: map[string]string{"SKILL.md": handoff}},
			{ID: "tutti/issue-manager", Name: issueManagerSkillName, Files: map[string]string{"SKILL.md": issueManager}},
			{ID: "tutti/workspace-app", Name: workspaceAppSkillName, Files: map[string]string{"SKILL.md": workspaceApp}},
			{ID: "tutti/reference", Name: referenceSkillName, Files: map[string]string{"SKILL.md": reference}},
		}}, nil
	}}
}

// TuttiDesktopHostPack contributes policy that is true for the local Tutti
// desktop host but not necessarily for other deployments such as managed VMs.
func TuttiDesktopHostPack() CapabilityPack {
	return CapabilityPack{Name: "tutti-desktop-host", Resolve: func(_ context.Context, input PrepareInput) (CapabilityContribution, error) {
		hostContext, err := hostAppContextPolicy(input)
		if err != nil {
			return CapabilityContribution{}, err
		}
		providerExecution, err := renderPolicyTemplate("policy_templates/provider-execution.md", input)
		if err != nil {
			return CapabilityContribution{}, err
		}
		return CapabilityContribution{Enabled: true, PolicySections: []PolicySection{
			{
				Anchor: PolicyAnchorTools,
				Key:    "provider-execution",
				Order:  -100,
				Body:   providerExecution,
			},
			{
				Anchor:   PolicyAnchorSpecialized,
				Key:      "host-app-context",
				Order:    1000,
				Delivery: PolicyDeliveryProviderRuntime,
				Body:     hostContext,
			},
		}}, nil
	}}
}

func BrowserUsePack() CapabilityPack {
	return CapabilityPack{Name: "browser-use", Resolve: func(_ context.Context, input PrepareInput) (CapabilityContribution, error) {
		enabled := input.BrowserUse && BrowserUseDefaultEnabled() &&
			input.commandCapabilities != nil &&
			input.commandCapabilities.HasAll(
				"browser.navigate",
				"browser.snapshot",
				"browser.click",
				"browser.fill",
				"browser.list-pages",
				"browser.select-page",
				"browser.new-page",
				"browser.close-page",
				"browser.eval",
				"browser.screenshot",
			) &&
			hasCommandInputs(input.commandCapabilities, "browser.navigate", "url") &&
			hasCommandInputs(input.commandCapabilities, "browser.click", "uid") &&
			hasCommandInputs(input.commandCapabilities, "browser.fill", "uid", "value") &&
			hasCommandInputs(input.commandCapabilities, "browser.select-page", "page-id") &&
			hasCommandInputs(input.commandCapabilities, "browser.new-page", "url") &&
			hasCommandInputs(input.commandCapabilities, "browser.close-page", "page-id") &&
			hasCommandInputs(input.commandCapabilities, "browser.eval", "script")
		if !enabled {
			return CapabilityContribution{Enabled: false}, nil
		}
		skill, err := browserUseSkill(input)
		if err != nil {
			return CapabilityContribution{}, err
		}
		policy, err := renderPolicyTemplate("policy_templates/browser-use.md", input)
		if err != nil {
			return CapabilityContribution{}, err
		}
		return CapabilityContribution{Enabled: enabled,
			Skills:         []SkillSpec{{ID: "tutti/browser-use", Name: browserUseSkillName, Files: map[string]string{"SKILL.md": skill}}},
			PolicySections: []PolicySection{{Anchor: PolicyAnchorTools, Key: "handoff", Body: policy}},
			EnvOverlay:     browserUseEnv(enabled),
		}, nil
	}}
}

func ComputerUsePack() CapabilityPack {
	return CapabilityPack{Name: "computer-use", Resolve: func(_ context.Context, input PrepareInput) (CapabilityContribution, error) {
		enabled := input.ComputerUse && ComputerUseDefaultEnabled() &&
			input.commandCapabilities != nil &&
			input.commandCapabilities.HasAll(
				"computer.screenshot",
				"computer.click",
				"computer.double-click",
				"computer.right-click",
				"computer.type",
				"computer.press-key",
				"computer.scroll",
				"computer.move-cursor",
				"computer.tool.list",
				"computer.tool.describe",
				"computer.tool.call",
			) &&
			hasCommandInputs(input.commandCapabilities, "computer.screenshot", "pid", "window-id") &&
			hasCommandInputs(input.commandCapabilities, "computer.click", "pid", "window-id", "x", "y") &&
			hasCommandInputs(input.commandCapabilities, "computer.double-click", "pid", "window-id", "x", "y") &&
			hasCommandInputs(input.commandCapabilities, "computer.right-click", "pid", "window-id", "x", "y") &&
			hasCommandInputs(input.commandCapabilities, "computer.type", "pid", "window-id", "text") &&
			hasCommandInputs(input.commandCapabilities, "computer.press-key", "pid", "window-id", "key") &&
			hasCommandInputs(input.commandCapabilities, "computer.scroll", "pid", "window-id", "x", "y", "direction", "amount") &&
			hasCommandInputs(input.commandCapabilities, "computer.move-cursor", "x", "y") &&
			hasCommandInputs(input.commandCapabilities, "computer.tool.describe", "name") &&
			hasCommandInputs(input.commandCapabilities, "computer.tool.call", "name", "arguments-json")
		if !enabled {
			return CapabilityContribution{Enabled: false}, nil
		}
		skill, err := computerUseSkill(input)
		if err != nil {
			return CapabilityContribution{}, err
		}
		policy, err := renderPolicyTemplate("policy_templates/computer-use.md", input)
		if err != nil {
			return CapabilityContribution{}, err
		}
		return CapabilityContribution{Enabled: enabled,
			Skills:         []SkillSpec{{ID: "tutti/computer-use", Name: computerUseSkillName, Files: map[string]string{"SKILL.md": skill}}},
			PolicySections: []PolicySection{{Anchor: PolicyAnchorTools, Key: "handoff", Body: policy}},
			EnvOverlay:     computerUseEnv(enabled),
		}, nil
	}}
}

func hasCommandInputs(resolver *CommandResolver, id string, names ...string) bool {
	if resolver == nil {
		return false
	}
	for _, name := range names {
		if !resolver.HasInput(id, name) {
			return false
		}
	}
	return true
}

func resolveCapabilities(ctx context.Context, input PrepareInput, profile DeploymentProfile, sources []SkillSource) (*resolvedCapabilities, error) {
	if strings.TrimSpace(profile.Name) == "" && len(profile.Packs) == 0 {
		profile = StandardProfile()
	}
	hostFacts, err := normalizeHostFacts(profile.HostFacts)
	if err != nil {
		return nil, fmt.Errorf("resolve host facts: %w", err)
	}
	input.hostFacts = hostFacts
	resolved := &resolvedCapabilities{
		Title:     strings.TrimSpace(profile.Title),
		Intro:     strings.TrimSpace(profile.Intro),
		HostFacts: hostFacts,
	}
	if resolved.Title == "" {
		resolved.Title = "Tutti Runtime"
	}
	if resolved.Intro == "" {
		resolved.Intro = "This directory is being used by a Tutti AgentGUI session."
	}
	packNames := make(map[string]struct{}, len(profile.Packs))
	for _, pack := range profile.Packs {
		name := strings.TrimSpace(pack.Name)
		if name == "" || pack.Resolve == nil {
			return nil, errors.New("runtime preparation capability pack requires name and resolver")
		}
		if _, exists := packNames[name]; exists {
			return nil, fmt.Errorf("runtime preparation capability pack %q is duplicated", name)
		}
		packNames[name] = struct{}{}
		contribution, err := pack.Resolve(ctx, input)
		if err != nil {
			return nil, fmt.Errorf("resolve capability pack %s: %w", name, err)
		}
		if !contribution.Enabled {
			continue
		}
		for index := range contribution.Skills {
			if contribution.Skills[index].Source == "" {
				contribution.Skills[index].Source = "pack:" + name
			}
		}
		for index := range contribution.PolicySections {
			section := &contribution.PolicySections[index]
			if _, ok := policyAnchorRank[section.Anchor]; !ok {
				return nil, fmt.Errorf("capability pack %s uses unknown policy anchor %q", name, section.Anchor)
			}
			if strings.TrimSpace(section.Key) == "" {
				section.Key = fmt.Sprintf("section-%d", index)
			}
			if section.Delivery != "" && section.Delivery != PolicyDeliveryProviderRuntime && section.Delivery != PolicyDeliverySkillBundle {
				return nil, fmt.Errorf("capability pack %s uses unknown policy delivery %q", name, section.Delivery)
			}
			renderedBody, err := renderRuntimeTemplate(
				fmt.Sprintf("policy-section:%s/%s", name, section.Key),
				section.Body,
				input,
				nil,
			)
			if err != nil {
				return nil, fmt.Errorf("render capability pack %s policy section %s: %w", name, section.Key, err)
			}
			section.Body = renderedBody
			section.Key = name + "/" + section.Key
		}
		resolved.Skills = append(resolved.Skills, contribution.Skills...)
		resolved.PolicySections = append(resolved.PolicySections, contribution.PolicySections...)
		resolved.EnvOverlay = append(resolved.EnvOverlay, contribution.EnvOverlay...)
	}
	for _, source := range sources {
		if source == nil {
			continue
		}
		skills, err := source.Skills(ctx, SkillContext{WorkspaceID: input.WorkspaceID, AgentSessionID: input.AgentSessionID, Provider: input.Provider, Cwd: input.Cwd})
		if err != nil {
			return nil, fmt.Errorf("resolve runtime preparation skill source: %w", err)
		}
		for index := range skills {
			if skills[index].Source == "" {
				skills[index].Source = "host"
			}
		}
		resolved.Skills = append(resolved.Skills, skills...)
	}
	resolved.Skills = append(resolved.Skills, input.ExtraSkills...)
	if err := validateResolvedSkills(resolved.Skills, input.Provider); err != nil {
		return nil, err
	}
	sort.SliceStable(resolved.PolicySections, func(left, right int) bool {
		lhs, rhs := resolved.PolicySections[left], resolved.PolicySections[right]
		if policyAnchorRank[lhs.Anchor] != policyAnchorRank[rhs.Anchor] {
			return policyAnchorRank[lhs.Anchor] < policyAnchorRank[rhs.Anchor]
		}
		if lhs.Order != rhs.Order {
			return lhs.Order < rhs.Order
		}
		return lhs.Key < rhs.Key
	})
	return resolved, nil
}

func validateResolvedSkills(skills []SkillSpec, provider string) error {
	ids := make(map[string]struct{}, len(skills))
	for _, skill := range skills {
		if !skillSupportsProvider(skill, provider) {
			continue
		}
		id, name := strings.TrimSpace(skill.ID), strings.TrimSpace(skill.Name)
		if name == "" {
			return errors.New("runtime preparation skill name is required")
		}
		if id == "" {
			id = "tutti/" + name
		}
		if _, exists := ids[id]; exists {
			return fmt.Errorf("runtime preparation skill id %q is duplicated", id)
		}
		ids[id] = struct{}{}
		for filePath := range skill.Files {
			cleaned := path.Clean(strings.TrimSpace(filePath))
			if cleaned == "." || path.IsAbs(cleaned) || cleaned == ".." || strings.HasPrefix(cleaned, "../") {
				return fmt.Errorf("runtime preparation skill %s has invalid file path %q", id, filePath)
			}
		}
	}
	return nil
}

func skillSupportsProvider(skill SkillSpec, provider string) bool {
	if len(skill.Providers) == 0 {
		return true
	}
	for _, candidate := range skill.Providers {
		if strings.TrimSpace(candidate) == strings.TrimSpace(provider) {
			return true
		}
	}
	return false
}

func renderPolicySections(input PrepareInput, anchor PolicyAnchor, delivery PolicyDelivery) string {
	if input.resolved == nil {
		return ""
	}
	var bodies []string
	for _, section := range input.resolved.PolicySections {
		if section.Anchor == anchor &&
			(section.Delivery == "" || section.Delivery == delivery) &&
			strings.TrimSpace(section.Body) != "" {
			bodies = append(bodies, strings.TrimSpace(section.Body))
		}
	}
	return strings.Join(bodies, "\n")
}
