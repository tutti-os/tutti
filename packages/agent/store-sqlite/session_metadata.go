package storesqlite

import (
	"encoding/json"
	"fmt"
	"strings"

	canonical "github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
)

type SessionMetadata struct {
	Visible  bool          `json:"visible"`
	Imported bool          `json:"imported"`
	Usage    *SessionUsage `json:"usage,omitempty"`
	Goal     *SessionGoal  `json:"goal,omitempty"`
}

// persistedSessionMetadata is the private compatibility carrier for
// session_metadata_json. CapabilitiesReported distinguishes legacy empty
// arrays (unknown) from an explicitly reported empty capability snapshot.
type persistedSessionMetadata struct {
	SessionMetadata
	Capabilities         []string `json:"capabilities"`
	CapabilitiesReported bool     `json:"capabilitiesReported,omitempty"`
}

type SessionUsage struct {
	ContextWindow *SessionUsageContextWindow `json:"contextWindow"`
	Quotas        []SessionUsageQuota        `json:"quotas"`
}

type SessionUsageContextWindow struct {
	UsedTokens  int64 `json:"usedTokens"`
	TotalTokens int64 `json:"totalTokens"`
}

type SessionUsageQuota struct {
	QuotaType        string  `json:"quotaType"`
	PercentRemaining float64 `json:"percentRemaining"`
	ResetsAtUnixMS   *int64  `json:"resetsAtUnixMs"`
}

type SessionGoal struct {
	Objective       string `json:"objective"`
	Status          string `json:"status"`
	Reason          string `json:"reason,omitempty"`
	StartedAtUnixMS int64  `json:"startedAtUnixMs,omitempty"`
	Iterations      int    `json:"iterations,omitempty"`
	DurationMS      int64  `json:"durationMs,omitempty"`
	Tokens          int64  `json:"tokens,omitempty"`
}

// DecodeSessionGoal validates and decodes the canonical goal payload shared by
// goal state and session metadata into the public typed session contract.
func DecodeSessionGoal(raw any) (*SessionGoal, error) {
	if raw == nil {
		return nil, nil
	}
	var value SessionGoal
	if err := remarshalJSON(raw, &value); err != nil {
		return nil, err
	}
	if err := validateSessionGoal(value); err != nil {
		return nil, err
	}
	return &value, nil
}

var sessionMetadataRuntimeContextKeys = []string{"visible", "imported", "capabilities", "capabilitiesReported", "usage", "goal"}

func splitSessionRuntimeContext(runtimeContext map[string]any) (SessionMetadata, *canonical.CapabilitySnapshot, map[string]any, error) {
	metadata := SessionMetadata{Visible: true}
	if visible, ok := runtimeContext["visible"].(bool); ok {
		metadata.Visible = visible
	}
	metadata.Imported, _ = runtimeContext["imported"].(bool)
	capabilityValues, capabilitiesPresent := runtimeContext["capabilities"]
	capabilitiesReported, _ := runtimeContext["capabilitiesReported"].(bool)
	capabilitiesReported = capabilitiesReported || capabilitiesPresent
	seenCapabilities := map[string]struct{}{}
	capabilities := []string{}
	for _, raw := range jsonStringSlice(capabilityValues) {
		if value := strings.TrimSpace(raw); value != "" {
			if !canonical.IsKnownCapability(value) {
				continue
			}
			if _, seen := seenCapabilities[value]; seen {
				continue
			}
			seenCapabilities[value] = struct{}{}
			capabilities = append(capabilities, value)
		}
	}
	if raw := runtimeContext["usage"]; raw != nil {
		var value SessionUsage
		if err := remarshalJSON(raw, &value); err != nil {
			return SessionMetadata{}, nil, nil, err
		}
		if value.Quotas == nil {
			value.Quotas = []SessionUsageQuota{}
		}
		if err := validateSessionUsage(value); err != nil {
			return SessionMetadata{}, nil, nil, err
		}
		metadata.Usage = &value
	}
	if raw := runtimeContext["goal"]; raw != nil {
		value, err := DecodeSessionGoal(raw)
		if err != nil {
			return SessionMetadata{}, nil, nil, err
		}
		metadata.Goal = value
	}
	internal := cloneJSONMap(runtimeContext)
	for _, key := range sessionMetadataRuntimeContextKeys {
		delete(internal, key)
	}
	var capabilitySnapshot *canonical.CapabilitySnapshot
	if capabilitiesReported {
		capabilitySnapshot = canonical.NewCapabilitySnapshot(capabilities)
	}
	return metadata, capabilitySnapshot, internal, nil
}

// SplitSessionRuntimeContext separates durable public session metadata from
// provider-private runtime state at the runtime adapter boundary.
func SplitSessionRuntimeContext(runtimeContext map[string]any) (SessionMetadata, map[string]any, error) {
	metadata, _, internal, err := splitSessionRuntimeContext(runtimeContext)
	return metadata, internal, err
}

func validateSessionGoal(value SessionGoal) error {
	if strings.TrimSpace(value.Objective) == "" {
		return fmt.Errorf("goal objective is required")
	}
	switch strings.TrimSpace(value.Status) {
	case "active", "paused", "blocked", "usageLimited", "budgetLimited", "complete":
	default:
		return fmt.Errorf("unsupported goal status %q", value.Status)
	}
	if value.StartedAtUnixMS < 0 || value.Iterations < 0 || value.DurationMS < 0 || value.Tokens < 0 {
		return fmt.Errorf("goal counters must be non-negative")
	}
	return nil
}

func validateSessionUsage(value SessionUsage) error {
	if value.ContextWindow == nil && len(value.Quotas) == 0 {
		return fmt.Errorf("session usage requires a context window or quotas")
	}
	if value.ContextWindow != nil && (value.ContextWindow.UsedTokens < 0 || value.ContextWindow.TotalTokens <= 0) {
		return fmt.Errorf("session usage context tokens must be non-negative with a positive total")
	}
	for _, quota := range value.Quotas {
		if strings.TrimSpace(quota.QuotaType) == "" || quota.PercentRemaining < 0 || quota.PercentRemaining > 100 {
			return fmt.Errorf("session usage quota is invalid")
		}
		if quota.ResetsAtUnixMS != nil && *quota.ResetsAtUnixMS < 0 {
			return fmt.Errorf("session usage quota reset time must be non-negative")
		}
	}
	return nil
}

func jsonStringSlice(raw any) []string {
	switch values := raw.(type) {
	case []string:
		return append([]string(nil), values...)
	case []any:
		result := make([]string, 0, len(values))
		for _, value := range values {
			if text, ok := value.(string); ok {
				result = append(result, text)
			}
		}
		return result
	default:
		return nil
	}
}

func remarshalJSON(raw any, target any) error {
	data, err := json.Marshal(raw)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, target)
}

func marshalSessionMetadata(value SessionMetadata, capabilities *canonical.CapabilitySnapshot) (string, error) {
	record := persistedSessionMetadata{SessionMetadata: value, Capabilities: []string{}}
	if capabilities != nil {
		record.Capabilities = append([]string{}, capabilities.Values...)
		record.CapabilitiesReported = true
	}
	data, err := json.Marshal(record)
	return string(data), err
}

// EncodeSessionMetadataJSON serializes the replication/persistence carrier
// without exposing its legacy presence marker as public domain state.
func EncodeSessionMetadataJSON(value SessionMetadata, capabilities *canonical.CapabilitySnapshot) ([]byte, error) {
	raw, err := marshalSessionMetadata(value, capabilities)
	return []byte(raw), err
}

func unmarshalSessionMetadata(raw string) (SessionMetadata, *canonical.CapabilitySnapshot, error) {
	var record persistedSessionMetadata
	err := json.Unmarshal([]byte(raw), &record)
	if record.Capabilities == nil {
		record.Capabilities = []string{}
	}
	if len(record.Capabilities) > 0 {
		// Legacy metadata did not carry capabilitiesReported. A non-empty
		// canonical list is sufficient evidence that a snapshot was reported.
		record.CapabilitiesReported = true
	}
	if record.Usage != nil && record.Usage.Quotas == nil {
		record.Usage.Quotas = []SessionUsageQuota{}
	}
	if err != nil {
		return SessionMetadata{}, nil, err
	}
	if err := validateSessionMetadata(record.SessionMetadata); err != nil {
		return SessionMetadata{}, nil, err
	}
	if err := validateSessionCapabilities(record.Capabilities); err != nil {
		return SessionMetadata{}, nil, err
	}
	var capabilities *canonical.CapabilitySnapshot
	if record.CapabilitiesReported {
		capabilities = canonical.NewCapabilitySnapshot(record.Capabilities)
	}
	return record.SessionMetadata, capabilities, nil
}

// DecodeSessionMetadataJSON normalizes legacy metadata into the public typed
// session metadata and optional capability snapshot.
func DecodeSessionMetadataJSON(raw []byte) (SessionMetadata, *canonical.CapabilitySnapshot, error) {
	return unmarshalSessionMetadata(string(raw))
}

func validateSessionMetadata(value SessionMetadata) error {
	if value.Usage != nil {
		if err := validateSessionUsage(*value.Usage); err != nil {
			return err
		}
	}
	if value.Goal != nil {
		if err := validateSessionGoal(*value.Goal); err != nil {
			return err
		}
	}
	return nil
}

func validateSessionCapabilities(capabilities []string) error {
	seen := map[string]struct{}{}
	for _, capability := range capabilities {
		if strings.TrimSpace(capability) != capability || !canonical.IsKnownCapability(capability) {
			return fmt.Errorf("unsupported session capability %q", capability)
		}
		if _, ok := seen[capability]; ok {
			return fmt.Errorf("duplicated session capability %q", capability)
		}
		seen[capability] = struct{}{}
	}
	return nil
}

func joinSessionRuntimeContext(metadata SessionMetadata, internal map[string]any) (map[string]any, error) {
	result := cloneJSONMap(internal)
	if result == nil {
		result = map[string]any{}
	}
	result["visible"] = metadata.Visible
	result["imported"] = metadata.Imported
	if metadata.Usage != nil {
		var value map[string]any
		if err := remarshalJSON(metadata.Usage, &value); err != nil {
			return nil, err
		}
		result["usage"] = value
	}
	if metadata.Goal != nil {
		var value map[string]any
		if err := remarshalJSON(metadata.Goal, &value); err != nil {
			return nil, err
		}
		result["goal"] = value
	}
	return result, nil
}

func JoinSessionRuntimeContext(metadata SessionMetadata, internal map[string]any) map[string]any {
	value, err := joinSessionRuntimeContext(metadata, internal)
	if err != nil {
		panic(err)
	}
	return value
}
