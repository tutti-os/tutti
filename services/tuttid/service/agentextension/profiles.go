package agentextension

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
)

type ComposerProfile struct {
	SchemaVersion string          `json:"schemaVersion"`
	Model         json.RawMessage `json:"model"`
	Permission    json.RawMessage `json:"permission"`
	ConfigOptions *struct {
		Model      ComposerConfigOptionReference `json:"model"`
		Permission ComposerConfigOptionReference `json:"permission"`
		Reasoning  ComposerConfigOptionReference `json:"reasoning"`
	} `json:"configOptions,omitempty"`
	PermissionModes []struct {
		RuntimeID         string `json:"runtimeId"`
		Semantic          string `json:"semantic"`
		AutomaticDecision string `json:"automaticDecision,omitempty"`
	} `json:"permissionModes"`
	SlashCommands *struct {
		CommandCatalogAuthoritative bool `json:"commandCatalogAuthoritative"`
		Commands                    []struct {
			Name   string `json:"name"`
			Effect string `json:"effect,omitempty"`
		} `json:"commands"`
	} `json:"slashCommands,omitempty"`
	Skills *struct {
		Invocation    string `json:"invocation"`
		TriggerPrefix string `json:"triggerPrefix"`
		Roots         []struct {
			Scope string `json:"scope"`
			Path  string `json:"path"`
		} `json:"roots"`
	} `json:"skills,omitempty"`
}

type ComposerConfigOptionReference struct {
	ACPOptionID string `json:"acpOptionId"`
}

func (profile ComposerProfile) ACPConfigOptionIDs() (model string, permission string, reasoning string) {
	if strings.TrimSpace(profile.SchemaVersion) == "" {
		return "", "", ""
	}
	if profile.ConfigOptions != nil {
		return strings.TrimSpace(profile.ConfigOptions.Model.ACPOptionID),
			strings.TrimSpace(profile.ConfigOptions.Permission.ACPOptionID),
			strings.TrimSpace(profile.ConfigOptions.Reasoning.ACPOptionID)
	}
	// Compatibility for profiles written before configOptions became the
	// canonical shape. Legacy profiles only declared model/mode sources;
	// reasoning used the established standard ACP alias.
	if len(profile.Model) > 0 && strings.TrimSpace(string(profile.Model)) != "null" {
		model = "model"
	}
	if len(profile.Permission) > 0 && strings.TrimSpace(string(profile.Permission)) != "null" {
		permission = "mode"
	}
	return model, permission, "reasoning_effort"
}

type CapabilitiesProfile struct {
	SchemaVersion string          `json:"schemaVersion"`
	Declared      map[string]bool `json:"declared"`
}

func (m *Manager) LoadComposerProfile(installationID string) (ComposerProfile, error) {
	installation, err := m.loadInstallationByID(strings.TrimSpace(installationID))
	if err != nil {
		return ComposerProfile{}, err
	}
	if installation.Manifest.Profiles.Composer == "" {
		return ComposerProfile{}, nil
	}
	var profile ComposerProfile
	path := filepath.Join(installation.PackageDir, filepath.FromSlash(installation.Manifest.Profiles.Composer))
	if err := readJSON(path, &profile); err != nil {
		return ComposerProfile{}, err
	}
	if err := validateComposerProfile(profile); err != nil {
		return ComposerProfile{}, err
	}
	return profile, nil
}

func (m *Manager) LoadDeclaredCapabilities(installationID string) ([]string, error) {
	installation, err := m.loadInstallationByID(strings.TrimSpace(installationID))
	if err != nil {
		return nil, err
	}
	return loadDeclaredCapabilities(installation)
}

func loadComposerModes(installation Installation) (map[string]string, string, error) {
	if installation.Manifest.Profiles.Composer == "" {
		return nil, "", nil
	}
	var profile ComposerProfile
	path := filepath.Join(installation.PackageDir, filepath.FromSlash(installation.Manifest.Profiles.Composer))
	if err := readJSON(path, &profile); err != nil {
		return nil, "", err
	}
	if err := validateComposerProfile(profile); err != nil {
		return nil, "", err
	}
	modes := map[string]string{}
	planMode := ""
	for _, mode := range profile.PermissionModes {
		runtimeID := strings.TrimSpace(mode.RuntimeID)
		if runtimeID == "" {
			return nil, "", errors.New("composer permission runtimeId is required")
		}
		semantic := strings.TrimSpace(mode.Semantic)
		modes[strings.ToLower(runtimeID)] = runtimeID
		setComposerModeAlias(modes, semantic, runtimeID)
		switch semantic {
		case "ask-before-write":
			setComposerModeAlias(modes, "read-only", runtimeID)
		case "accept-edits":
			setComposerModeAlias(modes, "accept-edits", runtimeID)
			setComposerModeAlias(modes, "auto", runtimeID)
		case "auto":
			modes["auto"] = runtimeID
			setComposerModeAlias(modes, "agent", runtimeID)
		case "locked-down":
			setComposerModeAlias(modes, "locked-down", runtimeID)
			setComposerModeAlias(modes, "dont-ask", runtimeID)
		case "full-access":
			setComposerModeAlias(modes, "full-access", runtimeID)
		case "read-only":
			modes["plan"] = runtimeID
			planMode = runtimeID
		default:
			return nil, "", errors.New("composer permission semantic is unsupported")
		}
	}
	return modes, planMode, nil
}

func loadDeclaredCapabilities(installation Installation) ([]string, error) {
	if installation.Manifest.Profiles.Capabilities == "" {
		return nil, nil
	}
	var profile CapabilitiesProfile
	path := filepath.Join(installation.PackageDir, filepath.FromSlash(installation.Manifest.Profiles.Capabilities))
	if err := readJSON(path, &profile); err != nil {
		return nil, err
	}
	if profile.SchemaVersion != "tutti.agent.capabilities.v1" {
		return nil, errors.New("unsupported capabilities profile schema")
	}
	capabilities := make([]string, 0, len(profile.Declared))
	for _, capability := range knownExtensionCapabilities() {
		if profile.Declared[capability] {
			capabilities = append(capabilities, capability)
		}
	}
	return capabilities, nil
}

func knownExtensionCapabilities() []string {
	return []string{
		providerregistry.CapabilityImageInput,
		providerregistry.CapabilityModelImageInputRequired,
		providerregistry.CapabilitySkills,
		providerregistry.CapabilityCompact,
		providerregistry.CapabilityTokenUsage,
		providerregistry.CapabilityRateLimits,
		providerregistry.CapabilityPlanMode,
		providerregistry.CapabilityInterrupt,
		providerregistry.CapabilityActiveTurnGuidance,
		providerregistry.CapabilityBrowserUse,
		providerregistry.CapabilityComputerUse,
		providerregistry.CapabilityGoalPause,
		providerregistry.CapabilityPlanImplementation,
		providerregistry.CapabilityPermissionModeChangeDuringTurn,
		providerregistry.CapabilityPermissionModeChangeDeferred,
		providerregistry.CapabilityReview,
		providerregistry.CapabilityResumeRunningTurn,
	}
}

func setComposerModeAlias(modes map[string]string, alias string, runtimeID string) {
	alias = strings.ToLower(strings.TrimSpace(alias))
	runtimeID = strings.TrimSpace(runtimeID)
	if alias == "" || runtimeID == "" {
		return
	}
	if _, exists := modes[alias]; exists {
		return
	}
	modes[alias] = runtimeID
}

func validateComposerProfile(profile ComposerProfile) error {
	if profile.SchemaVersion != "tutti.agent.composer.v1" {
		return errors.New("unsupported composer profile schema")
	}
	if profile.SlashCommands != nil {
		if len(profile.SlashCommands.Commands) == 0 {
			return errors.New("composer slashCommands requires at least one command")
		}
		seen := map[string]struct{}{}
		for _, command := range profile.SlashCommands.Commands {
			name := strings.ToLower(strings.TrimSpace(command.Name))
			if name == "" {
				return errors.New("composer slash command name is required")
			}
			if !composerSlashCommandName.MatchString(name) {
				return errors.New("composer slash command name is unsupported")
			}
			if _, exists := seen[name]; exists {
				return errors.New("composer slash command name must be unique")
			}
			seen[name] = struct{}{}
			if effect := strings.TrimSpace(command.Effect); effect != "" && !composerSlashCommandEffectSupported(effect) {
				return errors.New("composer slash command effect is unsupported")
			}
		}
	}
	if profile.ConfigOptions != nil {
		for _, option := range []ComposerConfigOptionReference{
			profile.ConfigOptions.Model,
			profile.ConfigOptions.Permission,
			profile.ConfigOptions.Reasoning,
		} {
			if id := strings.TrimSpace(option.ACPOptionID); id != "" && !composerConfigOptionID.MatchString(id) {
				return errors.New("composer ACP config option id is unsupported")
			}
		}
	}
	for _, mode := range profile.PermissionModes {
		decision := strings.TrimSpace(mode.AutomaticDecision)
		if decision == "" {
			continue
		}
		semantic := strings.TrimSpace(mode.Semantic)
		if decision == "approved" && semantic == "full-access" {
			continue
		}
		if decision == "denied" && (semantic == "read-only" || semantic == "locked-down") {
			continue
		}
		return errors.New("composer automatic permission decision is unsafe")
	}
	if profile.Skills == nil {
		return nil
	}
	if profile.Skills.Invocation != "textTrigger" && profile.Skills.Invocation != "promptItem" {
		return errors.New("composer skill invocation is unsupported")
	}
	if profile.Skills.TriggerPrefix != "/" && profile.Skills.TriggerPrefix != "$" {
		return errors.New("composer skill triggerPrefix is unsupported")
	}
	if len(profile.Skills.Roots) == 0 {
		return errors.New("composer skills require at least one root")
	}
	for _, root := range profile.Skills.Roots {
		if root.Scope != "workspace" && root.Scope != "user" {
			return errors.New("composer skill root scope is unsupported")
		}
		cleaned := filepath.Clean(strings.TrimSpace(root.Path))
		if cleaned == "." || filepath.IsAbs(cleaned) || cleaned == ".." || strings.HasPrefix(cleaned, ".."+string(filepath.Separator)) {
			return errors.New("composer skill root path must be a safe relative path")
		}
	}
	return nil
}

func (profile ComposerProfile) AutomaticPermissionDecisions() map[string]string {
	decisions := map[string]string{}
	for _, mode := range profile.PermissionModes {
		decision := strings.TrimSpace(mode.AutomaticDecision)
		if decision == "" {
			continue
		}
		for _, id := range []string{mode.RuntimeID, mode.Semantic} {
			if normalized := strings.ToLower(strings.TrimSpace(id)); normalized != "" {
				decisions[normalized] = decision
			}
		}
	}
	return decisions
}

var composerSlashCommandName = regexp.MustCompile(`^[a-z0-9][a-z0-9._:-]{0,63}$`)
var composerConfigOptionID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)

func validateInstalledProfiles(root string, manifest Manifest) error {
	for file, schema := range map[string]string{
		manifest.Profiles.Discovery:    "tutti.agent.discovery.v1",
		manifest.Profiles.Tools:        "tutti.agent.tools.v1",
		manifest.Profiles.Capabilities: "tutti.agent.capabilities.v1",
		manifest.Profiles.Composer:     "tutti.agent.composer.v1",
		manifest.Profiles.Events:       "tutti.agent.events.v1",
	} {
		if file == "" {
			continue
		}
		var header struct {
			SchemaVersion string `json:"schemaVersion"`
		}
		raw, readErr := os.ReadFile(filepath.Join(root, filepath.FromSlash(file)))
		if readErr != nil || json.Unmarshal(raw, &header) != nil || header.SchemaVersion != schema {
			return fmt.Errorf("installed extension profile %s must use %s", file, schema)
		}
	}
	var discovery DiscoveryProfile
	if err := readJSON(filepath.Join(root, filepath.FromSlash(manifest.Profiles.Discovery)), &discovery); err != nil {
		return err
	}
	if err := validateDiscoveryProfile(discovery); err != nil {
		return err
	}
	installation := Installation{PackageDir: root, Manifest: manifest}
	if _, _, err := loadComposerModes(installation); err != nil {
		return err
	}
	if _, err := loadDeclaredCapabilities(installation); err != nil {
		return err
	}
	if _, err := loadToolAliases(installation); err != nil {
		return err
	}
	return nil
}

func composerSlashCommandEffectSupported(effect string) bool {
	switch providerregistry.SlashCommandEffect(strings.TrimSpace(effect)) {
	case "",
		providerregistry.SlashCommandEffectSubmitImmediate,
		providerregistry.SlashCommandEffectShowReviewPicker,
		providerregistry.SlashCommandEffectActivateGoalMode,
		providerregistry.SlashCommandEffectTogglePlanMode,
		providerregistry.SlashCommandEffectShowStatus,
		providerregistry.SlashCommandEffectToggleSpeed:
		return true
	default:
		return false
	}
}

func loadToolAliases(installation Installation) (map[string]string, error) {
	if installation.Manifest.Profiles.Tools == "" {
		return nil, nil
	}
	var profile struct {
		SchemaVersion string `json:"schemaVersion"`
		Tools         []struct {
			Match struct {
				IDs []string `json:"ids"`
			} `json:"match"`
			CanonicalID  string          `json:"canonicalId"`
			Category     string          `json:"category"`
			Presentation json.RawMessage `json:"presentation"`
			FileEffect   json.RawMessage `json:"fileEffect"`
			Command      json.RawMessage `json:"command"`
		} `json:"tools"`
	}
	path := filepath.Join(installation.PackageDir, filepath.FromSlash(installation.Manifest.Profiles.Tools))
	if err := readJSON(path, &profile); err != nil {
		return nil, err
	}
	if profile.SchemaVersion != "tutti.agent.tools.v1" {
		return nil, errors.New("unsupported tool profile schema")
	}
	aliases := map[string]string{}
	for _, tool := range profile.Tools {
		canonical := strings.TrimSpace(tool.CanonicalID)
		if canonical == "" {
			return nil, errors.New("tool profile canonicalId is required")
		}
		for _, id := range tool.Match.IDs {
			normalized := strings.ToLower(strings.TrimSpace(id))
			if normalized == "" {
				return nil, errors.New("tool profile id is required")
			}
			aliases[normalized] = canonical
		}
	}
	return aliases, nil
}
