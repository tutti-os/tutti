package agent

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
)

const accountLiveModelCacheScope = "account"

type composerLiveModelScope struct {
	provider            string
	workspaceID         string
	cwd                 string
	agentTargetID       string
	installationID      string
	settingsSignature   string
	authScope           string
	modelConfigOptionID string
}

func newComposerLiveModelScope(provider, workspaceID, cwd, agentTargetID string) composerLiveModelScope {
	return composerLiveModelScope{
		provider:      agentprovider.NormalizeOpen(provider),
		workspaceID:   strings.TrimSpace(workspaceID),
		cwd:           normalizeComposerProjectScope(cwd),
		agentTargetID: strings.TrimSpace(agentTargetID),
		authScope:     liveModelAuthScope(provider),
	}
}

func newComposerLiveModelScopeForInput(input ComposerOptionsInput, settings ComposerSettings) composerLiveModelScope {
	scope := newComposerLiveModelScope(input.Provider, input.WorkspaceID, input.Cwd, input.AgentTargetID)
	if providerTargetRefKind(input.providerTargetRef) == "agent_extension" {
		scope.installationID = agentExtensionInstallationID(input.providerTargetRef)
		scope.settingsSignature = composerSettingsSignature(settings)
		scope.modelConfigOptionID = strings.TrimSpace(input.extensionComposerProfile.ModelConfigOptionID)
	}
	return scope
}

func (s composerLiveModelScope) key() string {
	workspaceScope := s.workspaceID
	if liveModelCatalogUsesAccountScope(s.provider) {
		workspaceScope = accountLiveModelCacheScope
	}
	targetScope := s.agentTargetID
	if targetScope == "" {
		targetScope = "default"
	}
	key := "live-model:" + s.provider + ":" + workspaceScope + ":" +
		liveModelCacheCwdScope(s.provider, s.cwd) + ":target=" + targetScope
	if s.installationID != "" {
		key += ":installation=" + s.installationID
	}
	if s.settingsSignature != "" {
		key += ":settings=" + s.settingsSignature
	}
	if s.authScope != "" {
		key += ":auth=" + s.authScope
	}
	return key
}

const agentExtensionInstallationRuntimeContextKey = "agentExtensionInstallationId"
const agentExtensionProjectRuntimeContextKey = "agentExtensionProjectScope"
const agentExtensionSettingsRuntimeContextKey = "agentExtensionComposerSettingsSignature"

func agentExtensionInstallationID(providerTargetRef map[string]any) string {
	if providerTargetRefKind(providerTargetRef) != "agent_extension" {
		return ""
	}
	return strings.TrimSpace(stringFromAny(providerTargetRef["extensionInstallationId"]))
}

func normalizeComposerProjectScope(cwd string) string {
	cwd = strings.TrimSpace(cwd)
	if cwd == "" {
		return ""
	}
	cleaned := filepath.Clean(cwd)
	if absolute, err := filepath.Abs(cleaned); err == nil {
		cleaned = absolute
	}
	if evaluated, err := filepath.EvalSymlinks(cleaned); err == nil {
		cleaned = evaluated
	}
	return filepath.Clean(cleaned)
}

func composerSettingsSignature(settings ComposerSettings) string {
	payload, _ := json.Marshal(settings)
	digest := sha256.Sum256(payload)
	return fmt.Sprintf("%x", digest[:8])
}

func stampAgentExtensionComposerScope(
	runtimeContext map[string]any,
	providerTargetRef map[string]any,
	projectScope string,
	settings ComposerSettings,
) map[string]any {
	installationID := agentExtensionInstallationID(providerTargetRef)
	if installationID == "" {
		return clonePayload(runtimeContext)
	}
	result := clonePayload(runtimeContext)
	if result == nil {
		result = map[string]any{}
	}
	result[agentExtensionInstallationRuntimeContextKey] = installationID
	result[agentExtensionProjectRuntimeContextKey] = normalizeComposerProjectScope(projectScope)
	result[agentExtensionSettingsRuntimeContextKey] = composerSettingsSignature(settings)
	return result
}

func (s composerLiveModelScope) matchesExtensionRuntimeContext(runtimeContext map[string]any) bool {
	if s.installationID == "" {
		return true
	}
	return strings.TrimSpace(stringFromAny(runtimeContext[agentExtensionInstallationRuntimeContextKey])) == s.installationID &&
		normalizeComposerProjectScope(stringFromAny(runtimeContext[agentExtensionProjectRuntimeContextKey])) == s.cwd &&
		strings.TrimSpace(stringFromAny(runtimeContext[agentExtensionSettingsRuntimeContextKey])) == s.settingsSignature
}

func liveModelCacheCwdScope(provider string, cwd string) string {
	if liveModelCatalogUsesAccountScope(provider) {
		return accountLiveModelCacheScope
	}
	return strings.TrimSpace(cwd)
}

func liveModelCatalogUsesAccountScope(provider string) bool {
	return composerProfileFor(provider).LiveModelAccountScoped
}

func (s *Service) resolveLiveModelDiscoveryCwd(
	ctx context.Context,
	provider string,
	requestedCwd string,
) (string, error) {
	if !liveModelCatalogUsesAccountScope(provider) {
		resolvedCwd := strings.TrimSpace(requestedCwd)
		if resolvedCwd == "" {
			return "", nil
		}
		return s.resolveCwd(ctx, &resolvedCwd)
	}

	stateDir := filepath.Clean(strings.TrimSpace(tuttitypes.DefaultStateDir()))
	if stateDir == "." || stateDir == string(filepath.Separator) {
		return "", errors.New("agent discovery state directory is not configured")
	}
	discoveryCwd := filepath.Join(stateDir, "agent", "discovery", agentprovider.NormalizeOpen(provider))
	if err := os.MkdirAll(discoveryCwd, 0o700); err != nil {
		return "", fmt.Errorf("create live-model discovery directory: %w", err)
	}
	return discoveryCwd, nil
}

func resolveAgentExtensionComposerDiscoveryCwd(provider string) (string, error) {
	stateDir := filepath.Clean(strings.TrimSpace(tuttitypes.DefaultStateDir()))
	if stateDir == "." || stateDir == string(filepath.Separator) {
		return "", errors.New("agent discovery state directory is not configured")
	}
	provider = agentprovider.NormalizeOpen(provider)
	if provider == "" {
		return "", errors.New("agent extension provider is invalid")
	}
	discoveryCwd := filepath.Join(stateDir, "agent", "discovery", strings.ReplaceAll(provider, ":", "-"))
	if err := os.MkdirAll(discoveryCwd, 0o700); err != nil {
		return "", fmt.Errorf("create agent extension composer discovery directory: %w", err)
	}
	return discoveryCwd, nil
}
