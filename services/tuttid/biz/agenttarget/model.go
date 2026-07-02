package agenttarget

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"

	agentproviderbiz "github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
)

const (
	IDLocalCodex      = "local:codex"
	IDLocalClaudeCode = "local:claude-code"

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
	return []Target{
		{
			ID:              IDLocalCodex,
			Provider:        agentproviderbiz.Codex,
			LaunchRefJSON:   MustLocalCLILaunchRefJSON(agentproviderbiz.Codex),
			Name:            "Codex",
			IconKey:         "codex",
			Enabled:         true,
			Source:          SourceSystem,
			SortOrder:       10,
			CreatedAtUnixMS: nowUnixMS,
			UpdatedAtUnixMS: nowUnixMS,
		},
		{
			ID:              IDLocalClaudeCode,
			Provider:        agentproviderbiz.ClaudeCode,
			LaunchRefJSON:   MustLocalCLILaunchRefJSON(agentproviderbiz.ClaudeCode),
			Name:            "Claude Code",
			IconKey:         "claude-code",
			Enabled:         true,
			Source:          SourceSystem,
			SortOrder:       20,
			CreatedAtUnixMS: nowUnixMS,
			UpdatedAtUnixMS: nowUnixMS,
		},
	}
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
	switch agentproviderbiz.Normalize(value) {
	case agentproviderbiz.Codex:
		return agentproviderbiz.Codex
	case agentproviderbiz.ClaudeCode:
		return agentproviderbiz.ClaudeCode
	default:
		return ""
	}
}
