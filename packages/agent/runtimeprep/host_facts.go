package runtimeprep

import (
	"errors"
	"fmt"
	"strings"
)

type AgentTurnResourcesMode string

const (
	AgentTurnResourcesLocalPath   AgentTurnResourcesMode = "local-path"
	AgentTurnResourcesReadPath    AgentTurnResourcesMode = "read-path"
	AgentTurnResourcesUnavailable AgentTurnResourcesMode = "unavailable"
)

type AgentWorkspaceScopeMode string

const (
	AgentWorkspaceScopeEnvironment AgentWorkspaceScopeMode = "workspace-environment"
	AgentWorkspaceScopeRoom        AgentWorkspaceScopeMode = "room"
)

type AgentTargetContinuationMode string

const (
	AgentTargetContinuationAll            AgentTargetContinuationMode = "all"
	AgentTargetContinuationExceptPrefixes AgentTargetContinuationMode = "except-prefixes"
)

type AgentTargetContinuationProfile struct {
	Mode                        AgentTargetContinuationMode
	UnsupportedTargetIDPrefixes []string
}

// HostFacts contains runtime behavior that cannot be derived from the
// agent-facing command snapshot. Command presence, paths, inputs, and output
// modes must never be duplicated here.
type HostFacts struct {
	TurnResources      AgentTurnResourcesMode
	WorkspaceScope     AgentWorkspaceScopeMode
	TargetContinuation AgentTargetContinuationProfile
}

func DefaultHostFacts() HostFacts {
	return HostFacts{
		TurnResources:  AgentTurnResourcesLocalPath,
		WorkspaceScope: AgentWorkspaceScopeEnvironment,
		TargetContinuation: AgentTargetContinuationProfile{
			Mode: AgentTargetContinuationAll,
		},
	}
}

func normalizeHostFacts(facts HostFacts) (HostFacts, error) {
	defaults := DefaultHostFacts()
	if facts.TurnResources == "" {
		facts.TurnResources = defaults.TurnResources
	}
	if facts.WorkspaceScope == "" {
		facts.WorkspaceScope = defaults.WorkspaceScope
	}
	if facts.TargetContinuation.Mode == "" {
		facts.TargetContinuation.Mode = defaults.TargetContinuation.Mode
	}
	if facts.TurnResources != AgentTurnResourcesLocalPath &&
		facts.TurnResources != AgentTurnResourcesReadPath &&
		facts.TurnResources != AgentTurnResourcesUnavailable {
		return HostFacts{}, fmt.Errorf("unknown agent turn resources mode %q", facts.TurnResources)
	}
	if facts.WorkspaceScope != AgentWorkspaceScopeEnvironment &&
		facts.WorkspaceScope != AgentWorkspaceScopeRoom {
		return HostFacts{}, fmt.Errorf("unknown agent workspace scope mode %q", facts.WorkspaceScope)
	}
	if facts.TargetContinuation.Mode != AgentTargetContinuationAll &&
		facts.TargetContinuation.Mode != AgentTargetContinuationExceptPrefixes {
		return HostFacts{}, fmt.Errorf("unknown agent target continuation mode %q", facts.TargetContinuation.Mode)
	}
	facts.TargetContinuation.UnsupportedTargetIDPrefixes = normalizedTargetIDPrefixes(
		facts.TargetContinuation.UnsupportedTargetIDPrefixes,
	)
	if facts.TargetContinuation.Mode == AgentTargetContinuationAll &&
		len(facts.TargetContinuation.UnsupportedTargetIDPrefixes) > 0 {
		return HostFacts{}, errors.New("agent target continuation mode all cannot exclude target id prefixes")
	}
	if facts.TargetContinuation.Mode == AgentTargetContinuationExceptPrefixes &&
		len(facts.TargetContinuation.UnsupportedTargetIDPrefixes) == 0 {
		return HostFacts{}, errors.New("agent target continuation except-prefixes requires at least one target id prefix")
	}
	return facts, nil
}

func normalizedTargetIDPrefixes(prefixes []string) []string {
	seen := make(map[string]struct{}, len(prefixes))
	normalized := make([]string, 0, len(prefixes))
	for _, prefix := range prefixes {
		prefix = strings.TrimSpace(prefix)
		if prefix == "" {
			continue
		}
		if _, exists := seen[prefix]; exists {
			continue
		}
		seen[prefix] = struct{}{}
		normalized = append(normalized, prefix)
	}
	return normalized
}

func resolvedHostFacts(input PrepareInput) HostFacts {
	if input.resolved != nil {
		return input.resolved.HostFacts
	}
	if hasHostFacts(input.hostFacts) {
		return input.hostFacts
	}
	return DefaultHostFacts()
}

func hasHostFacts(facts HostFacts) bool {
	return facts.TurnResources != "" ||
		facts.WorkspaceScope != "" ||
		facts.TargetContinuation.Mode != "" ||
		len(facts.TargetContinuation.UnsupportedTargetIDPrefixes) > 0
}
