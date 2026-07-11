package agent

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
)

const claudeLiveModelCacheCwdScope = "account"
const claudeLiveModelCacheWorkspaceScope = "account"

type composerLiveModelScope struct {
	provider      string
	workspaceID   string
	cwd           string
	agentTargetID string
	authScope     string
}

func newComposerLiveModelScope(provider, workspaceID, cwd, agentTargetID string) composerLiveModelScope {
	return composerLiveModelScope{
		provider:      agentprovider.Normalize(provider),
		workspaceID:   strings.TrimSpace(workspaceID),
		cwd:           strings.TrimSpace(cwd),
		agentTargetID: strings.TrimSpace(agentTargetID),
		authScope:     liveModelAuthScope(provider),
	}
}

func (s composerLiveModelScope) key() string {
	workspaceScope := s.workspaceID
	if isClaudeSDKLiveModelProvider(s.provider) {
		workspaceScope = claudeLiveModelCacheWorkspaceScope
	}
	targetScope := s.agentTargetID
	if targetScope == "" {
		targetScope = "default"
	}
	key := "live-model:" + s.provider + ":" + workspaceScope + ":" +
		liveModelCacheCwdScope(s.provider, s.cwd) + ":target=" + targetScope
	if s.authScope != "" {
		key += ":auth=" + s.authScope
	}
	return key
}

func liveModelCacheCwdScope(provider string, cwd string) string {
	if isClaudeSDKLiveModelProvider(provider) {
		return claudeLiveModelCacheCwdScope
	}
	return strings.TrimSpace(cwd)
}

func (s *Service) resolveLiveModelDiscoveryCwd(
	ctx context.Context,
	provider string,
	requestedCwd string,
) (string, error) {
	if !isClaudeSDKLiveModelProvider(provider) {
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
	discoveryCwd := filepath.Join(stateDir, "agent", "discovery", agentprovider.Normalize(provider))
	if err := os.MkdirAll(discoveryCwd, 0o700); err != nil {
		return "", fmt.Errorf("create Claude live-model discovery directory: %w", err)
	}
	return discoveryCwd, nil
}
