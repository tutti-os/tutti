package agent

import (
	"strings"

	"github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
)

type providerRuntimeSessionAuthKey struct {
	workspaceID string
	sessionID   string
}

type providerRuntimeSessionAuthGeneration struct {
	provider   string
	generation uint64
}

// InvalidateProviderRuntimeCredentials marks live provider connections as
// stale after the provider's on-disk credentials change.
// Active Turns are not interrupted; SendInput consumes this marker only at
// Host's existing idle reprepare-and-send admission boundary.
func (s *Service) InvalidateProviderRuntimeCredentials(provider string) {
	if s == nil {
		return
	}
	provider = agentprovider.Normalize(provider)
	if provider == "" {
		return
	}
	s.providerRuntimeAuthMu.Lock()
	defer s.providerRuntimeAuthMu.Unlock()
	if s.providerRuntimeAuthGeneration == nil {
		s.providerRuntimeAuthGeneration = make(map[string]uint64)
	}
	s.providerRuntimeAuthGeneration[provider]++
}

func (s *Service) providerRuntimeCredentialGeneration(provider string) uint64 {
	if s == nil {
		return 0
	}
	provider = agentprovider.Normalize(provider)
	s.providerRuntimeAuthMu.Lock()
	defer s.providerRuntimeAuthMu.Unlock()
	return s.providerRuntimeAuthGeneration[provider]
}

func (s *Service) providerRuntimeCredentialsNeedReprepare(
	workspaceID string,
	sessionID string,
	provider string,
) (uint64, bool) {
	if s == nil {
		return 0, false
	}
	workspaceID = strings.TrimSpace(workspaceID)
	sessionID = strings.TrimSpace(sessionID)
	provider = agentprovider.Normalize(provider)
	if workspaceID == "" || sessionID == "" || provider == "" {
		return 0, false
	}
	s.providerRuntimeAuthMu.Lock()
	defer s.providerRuntimeAuthMu.Unlock()
	generation := s.providerRuntimeAuthGeneration[provider]
	applied := s.providerRuntimeSessionAuth[providerRuntimeSessionAuthKey{
		workspaceID: workspaceID,
		sessionID:   sessionID,
	}]
	appliedGeneration := uint64(0)
	if applied.provider == provider {
		appliedGeneration = applied.generation
	}
	return generation, generation > appliedGeneration
}

func (s *Service) markProviderRuntimeCredentialsApplied(
	workspaceID string,
	sessionID string,
	provider string,
	generation uint64,
) {
	if s == nil {
		return
	}
	workspaceID = strings.TrimSpace(workspaceID)
	sessionID = strings.TrimSpace(sessionID)
	provider = agentprovider.Normalize(provider)
	if workspaceID == "" || sessionID == "" || provider == "" {
		return
	}
	s.providerRuntimeAuthMu.Lock()
	defer s.providerRuntimeAuthMu.Unlock()
	if s.providerRuntimeSessionAuth == nil {
		s.providerRuntimeSessionAuth = make(map[providerRuntimeSessionAuthKey]providerRuntimeSessionAuthGeneration)
	}
	key := providerRuntimeSessionAuthKey{workspaceID: workspaceID, sessionID: sessionID}
	current := s.providerRuntimeSessionAuth[key]
	if current.provider == provider && current.generation > generation {
		return
	}
	s.providerRuntimeSessionAuth[key] = providerRuntimeSessionAuthGeneration{
		provider:   provider,
		generation: generation,
	}
}

func (s *Service) forgetProviderRuntimeSessionCredentials(workspaceID string, sessionIDs ...string) {
	if s == nil {
		return
	}
	workspaceID = strings.TrimSpace(workspaceID)
	if workspaceID == "" {
		return
	}
	s.providerRuntimeAuthMu.Lock()
	defer s.providerRuntimeAuthMu.Unlock()
	for _, sessionID := range sessionIDs {
		delete(s.providerRuntimeSessionAuth, providerRuntimeSessionAuthKey{
			workspaceID: workspaceID,
			sessionID:   strings.TrimSpace(sessionID),
		})
	}
}
