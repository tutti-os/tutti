package agenttarget

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"

	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
	agentproviderbiz "github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
)

const (
	IDLocalCodex      = providerregistry.CodexTargetID
	IDLocalClaudeCode = providerregistry.ClaudeCodeTargetID
	IDLocalTuttiAgent = providerregistry.TuttiAgentTargetID
	IDLocalCursor     = providerregistry.CursorTargetID
	IDLocalOpenCode   = providerregistry.OpenCodeTargetID

	LaunchRefTypeLocalCLI = "local_cli"

	SourceSystem = "system"
	SourceUser   = "user"
)

var (
	ErrInvalidTarget    = errors.New("invalid agent target")
	ErrInvalidLaunchRef = errors.New("invalid agent target launch ref")
)

type Target struct {
	ID              string
	Provider        string
	LaunchRefJSON   string
	Name            string
	IconKey         string
	Enabled         bool
	Source          string
	SortOrder       int
	CreatedAtUnixMS int64
	UpdatedAtUnixMS int64
}

type LaunchRef struct {
	Type     string `json:"type"`
	Provider string `json:"provider"`
}

func DefaultSystemTargets(nowUnixMS int64) []Target {
	targets := make([]Target, 0, len(providerregistry.Migrated()))
	for _, descriptor := range providerregistry.Migrated() {
		targets = append(targets, systemTargetFromProviderDescriptor(descriptor, nowUnixMS))
	}
	sort.SliceStable(targets, func(left int, right int) bool {
		if targets[left].SortOrder == targets[right].SortOrder {
			return targets[left].ID < targets[right].ID
		}
		return targets[left].SortOrder < targets[right].SortOrder
	})
	return targets
}

func systemTargetFromProviderDescriptor(descriptor providerregistry.ProviderDescriptor, nowUnixMS int64) Target {
	if err := providerregistry.Validate(descriptor); err != nil {
		panic(fmt.Sprintf("invalid migrated provider target descriptor: %v", err))
	}
	if descriptor.Target.LaunchRefType != LaunchRefTypeLocalCLI {
		panic(fmt.Sprintf("provider %q has unsupported target launch ref type %q", descriptor.Identity.ID, descriptor.Target.LaunchRefType))
	}
	return Target{
		ID:              descriptor.Target.ID,
		Provider:        descriptor.Identity.ID,
		LaunchRefJSON:   MustLocalCLILaunchRefJSON(descriptor.Identity.ID),
		Name:            descriptor.Identity.DisplayName,
		IconKey:         descriptor.Identity.IconKey,
		Enabled:         descriptor.Target.Enabled,
		Source:          SourceSystem,
		SortOrder:       descriptor.Target.SortOrder,
		CreatedAtUnixMS: nowUnixMS,
		UpdatedAtUnixMS: nowUnixMS,
	}
}

// EnabledTargetsByProvider returns the first valid enabled target for each
// canonical provider while preserving the target catalog order. Provider
// visibility is owned by Agent Targets; callers must not rebuild this policy
// from runtime availability or app-local allowlists.
func EnabledTargetsByProvider(targets []Target) []Target {
	result := make([]Target, 0, len(targets))
	seen := make(map[string]struct{}, len(targets))
	for _, target := range targets {
		normalized, err := NormalizeTarget(target)
		if err != nil || !normalized.Enabled {
			continue
		}
		if _, ok := seen[normalized.Provider]; ok {
			continue
		}
		seen[normalized.Provider] = struct{}{}
		result = append(result, normalized)
	}
	return result
}

// EnabledTargetForProvider resolves legacy provider input at the ingress but
// only returns a target carrying the canonical provider id.
func EnabledTargetForProvider(targets []Target, provider string) (Target, bool) {
	canonicalProvider := agentproviderbiz.Normalize(provider)
	if canonicalProvider == "" {
		return Target{}, false
	}
	for _, target := range EnabledTargetsByProvider(targets) {
		if target.Provider == canonicalProvider {
			return target, true
		}
	}
	return Target{}, false
}

func MustLocalCLILaunchRefJSON(provider string) string {
	raw, err := CanonicalLaunchRefJSON(provider, LaunchRef{
		Type:     LaunchRefTypeLocalCLI,
		Provider: provider,
	})
	if err != nil {
		panic(err)
	}
	return raw
}

func RuntimeProviderTargetRef(target Target) (map[string]any, error) {
	normalized, err := NormalizeTarget(target)
	if err != nil {
		return nil, err
	}
	var launchRef LaunchRef
	if err := json.Unmarshal([]byte(normalized.LaunchRefJSON), &launchRef); err != nil {
		return nil, fmt.Errorf("%w: %w", ErrInvalidLaunchRef, err)
	}
	if _, err := CanonicalLaunchRefJSON(normalized.Provider, launchRef); err != nil {
		return nil, err
	}
	return map[string]any{
		"kind":     launchRef.Type,
		"provider": launchRef.Provider,
		"targetId": normalized.ID,
	}, nil
}

func NormalizeTarget(value Target) (Target, error) {
	value.ID = strings.TrimSpace(value.ID)
	value.Provider = normalizeFirstIterationProvider(value.Provider)
	value.Name = strings.TrimSpace(value.Name)
	value.IconKey = strings.TrimSpace(value.IconKey)
	value.Source = normalizeSource(value.Source)
	if value.ID == "" {
		return Target{}, fmt.Errorf("%w: id is required", ErrInvalidTarget)
	}
	if value.Provider == "" {
		return Target{}, fmt.Errorf("%w: provider is unsupported", ErrInvalidTarget)
	}
	if value.Name == "" {
		return Target{}, fmt.Errorf("%w: name is required", ErrInvalidTarget)
	}
	if value.Source == "" {
		return Target{}, fmt.Errorf("%w: source is unsupported", ErrInvalidTarget)
	}
	launchRefJSON, err := CanonicalLaunchRefJSONString(value.Provider, value.LaunchRefJSON)
	if err != nil {
		return Target{}, err
	}
	value.LaunchRefJSON = launchRefJSON
	return value, nil
}

func CanonicalLaunchRefJSONString(tableProvider string, raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", fmt.Errorf("%w: launch ref is required", ErrInvalidLaunchRef)
	}
	var ref LaunchRef
	decoder := json.NewDecoder(bytes.NewReader([]byte(raw)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&ref); err != nil {
		return "", fmt.Errorf("%w: %w", ErrInvalidLaunchRef, err)
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return "", fmt.Errorf("%w: multiple JSON values", ErrInvalidLaunchRef)
	}
	return CanonicalLaunchRefJSON(tableProvider, ref)
}

func CanonicalLaunchRefJSON(tableProvider string, ref LaunchRef) (string, error) {
	tableProvider = normalizeFirstIterationProvider(tableProvider)
	ref.Type = strings.TrimSpace(ref.Type)
	ref.Provider = normalizeFirstIterationProvider(ref.Provider)
	if ref.Type != LaunchRefTypeLocalCLI {
		return "", fmt.Errorf("%w: unsupported type", ErrInvalidLaunchRef)
	}
	if ref.Provider == "" {
		return "", fmt.Errorf("%w: provider is unsupported", ErrInvalidLaunchRef)
	}
	if tableProvider == "" {
		return "", fmt.Errorf("%w: table provider is unsupported", ErrInvalidLaunchRef)
	}
	if ref.Provider != tableProvider {
		return "", fmt.Errorf("%w: provider mismatch", ErrInvalidLaunchRef)
	}
	data, err := json.Marshal(LaunchRef{
		Type:     LaunchRefTypeLocalCLI,
		Provider: ref.Provider,
	})
	if err != nil {
		return "", fmt.Errorf("%w: marshal canonical launch ref: %w", ErrInvalidLaunchRef, err)
	}
	return string(data), nil
}

func IsSystemTarget(target Target) bool {
	return normalizeSource(target.Source) == SourceSystem
}

func normalizeSource(value string) string {
	switch strings.TrimSpace(value) {
	case SourceSystem:
		return SourceSystem
	case SourceUser:
		return SourceUser
	default:
		return ""
	}
}

func normalizeFirstIterationProvider(value string) string {
	normalized := agentproviderbiz.Normalize(value)
	if _, ok := providerregistry.Find(normalized); ok {
		return normalized
	}
	return ""
}
