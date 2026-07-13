package storesqlite

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
)

type SessionMetadata struct {
	Visible          bool                     `json:"visible"`
	Imported         bool                     `json:"imported"`
	Capabilities     []string                 `json:"capabilities"`
	Usage            *SessionUsage            `json:"usage,omitempty"`
	BackgroundAgents *SessionBackgroundAgents `json:"backgroundAgents,omitempty"`
	Goal             *SessionGoal             `json:"goal,omitempty"`
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

type SessionBackgroundAgents struct {
	Count int                          `json:"count"`
	Items []SessionBackgroundAgentItem `json:"items"`
}

type SessionBackgroundAgentItem struct {
	TaskID            string `json:"taskId"`
	Description       string `json:"description"`
	Status            string `json:"status"`
	Summary           string `json:"summary,omitempty"`
	LastToolName      string `json:"lastToolName,omitempty"`
	TaskType          string `json:"taskType,omitempty"`
	StartedAtUnixMS   int64  `json:"startedAtUnixMs,omitempty"`
	UpdatedAtUnixMS   int64  `json:"updatedAtUnixMs,omitempty"`
	CompletedAtUnixMS int64  `json:"completedAtUnixMs,omitempty"`
}

type SessionGoal struct {
	Objective  string `json:"objective"`
	Status     string `json:"status"`
	Reason     string `json:"reason,omitempty"`
	Iterations int    `json:"iterations,omitempty"`
	DurationMS int64  `json:"durationMs,omitempty"`
	Tokens     int64  `json:"tokens,omitempty"`
}

var sessionMetadataRuntimeContextKeys = []string{"visible", "imported", "capabilities", "usage", "backgroundAgents", "goal"}

func splitSessionRuntimeContext(runtimeContext map[string]any) (SessionMetadata, map[string]any, error) {
	metadata := SessionMetadata{Visible: true, Capabilities: []string{}}
	if visible, ok := runtimeContext["visible"].(bool); ok {
		metadata.Visible = visible
	}
	metadata.Imported, _ = runtimeContext["imported"].(bool)
	seenCapabilities := map[string]struct{}{}
	for _, raw := range jsonStringSlice(runtimeContext["capabilities"]) {
		if value := strings.TrimSpace(raw); value != "" {
			if !providerregistry.IsKnownCapability(value) {
				continue
			}
			if _, seen := seenCapabilities[value]; seen {
				continue
			}
			seenCapabilities[value] = struct{}{}
			metadata.Capabilities = append(metadata.Capabilities, value)
		}
	}
	if raw := runtimeContext["usage"]; raw != nil {
		var value SessionUsage
		if err := remarshalJSON(raw, &value); err != nil {
			return SessionMetadata{}, nil, err
		}
		if value.Quotas == nil {
			value.Quotas = []SessionUsageQuota{}
		}
		if err := validateSessionUsage(value); err != nil {
			return SessionMetadata{}, nil, err
		}
		metadata.Usage = &value
	}
	if raw := runtimeContext["backgroundAgents"]; raw != nil {
		var value SessionBackgroundAgents
		if err := remarshalJSON(raw, &value); err != nil {
			return SessionMetadata{}, nil, err
		}
		for index := range value.Items {
			value.Items[index].Status = normalizeBackgroundAgentStatus(value.Items[index].Status)
		}
		if err := validateSessionBackgroundAgents(value); err != nil {
			return SessionMetadata{}, nil, err
		}
		metadata.BackgroundAgents = &value
	}
	if raw := runtimeContext["goal"]; raw != nil {
		var value SessionGoal
		if err := remarshalJSON(raw, &value); err != nil {
			return SessionMetadata{}, nil, err
		}
		if err := validateSessionGoal(value); err != nil {
			return SessionMetadata{}, nil, err
		}
		metadata.Goal = &value
	}
	internal := cloneJSONMap(runtimeContext)
	for _, key := range sessionMetadataRuntimeContextKeys {
		delete(internal, key)
	}
	return metadata, internal, nil
}

// SplitSessionRuntimeContext separates durable public session metadata from
// provider-private runtime state at the runtime adapter boundary.
func SplitSessionRuntimeContext(runtimeContext map[string]any) (SessionMetadata, map[string]any, error) {
	return splitSessionRuntimeContext(runtimeContext)
}

func validateSessionBackgroundAgents(value SessionBackgroundAgents) error {
	if value.Count < 0 || value.Items == nil {
		return fmt.Errorf("background agents count must be non-negative and items must be present")
	}
	running := 0
	for _, item := range value.Items {
		if strings.TrimSpace(item.TaskID) == "" || strings.TrimSpace(item.Description) == "" {
			return fmt.Errorf("background agent task id and description are required")
		}
		switch strings.TrimSpace(item.Status) {
		case "running":
			running++
		case "completed", "failed", "canceled":
		default:
			return fmt.Errorf("unsupported background agent status %q", item.Status)
		}
		if item.StartedAtUnixMS < 0 || item.UpdatedAtUnixMS < 0 || item.CompletedAtUnixMS < 0 {
			return fmt.Errorf("background agent timestamps must be non-negative")
		}
		if item.StartedAtUnixMS > 0 && item.UpdatedAtUnixMS > 0 && item.UpdatedAtUnixMS < item.StartedAtUnixMS {
			return fmt.Errorf("background agent updated time precedes start time")
		}
		if item.StartedAtUnixMS > 0 && item.CompletedAtUnixMS > 0 && item.CompletedAtUnixMS < item.StartedAtUnixMS {
			return fmt.Errorf("background agent completion time precedes start time")
		}
	}
	if value.Count != running {
		return fmt.Errorf("background agents count %d does not match %d running items", value.Count, running)
	}
	return nil
}

func normalizeBackgroundAgentStatus(raw string) string {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "completed", "complete", "succeeded", "success":
		return "completed"
	case "failed", "failure", "error", "errored":
		return "failed"
	case "canceled", "cancelled":
		return "canceled"
	default:
		return "running"
	}
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
	if value.Iterations < 0 || value.DurationMS < 0 || value.Tokens < 0 {
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

func marshalSessionMetadata(value SessionMetadata) (string, error) {
	data, err := json.Marshal(value)
	return string(data), err
}

func unmarshalSessionMetadata(raw string) (SessionMetadata, error) {
	var value SessionMetadata
	err := json.Unmarshal([]byte(raw), &value)
	if value.Capabilities == nil {
		value.Capabilities = []string{}
	}
	if value.Usage != nil && value.Usage.Quotas == nil {
		value.Usage.Quotas = []SessionUsageQuota{}
	}
	if err != nil {
		return SessionMetadata{}, err
	}
	if err := validateSessionMetadata(value); err != nil {
		return SessionMetadata{}, err
	}
	return value, nil
}

func validateSessionMetadata(value SessionMetadata) error {
	seen := map[string]struct{}{}
	for _, capability := range value.Capabilities {
		if strings.TrimSpace(capability) != capability || !providerregistry.IsKnownCapability(capability) {
			return fmt.Errorf("unsupported session capability %q", capability)
		}
		if _, ok := seen[capability]; ok {
			return fmt.Errorf("duplicated session capability %q", capability)
		}
		seen[capability] = struct{}{}
	}
	if value.BackgroundAgents != nil {
		if err := validateSessionBackgroundAgents(*value.BackgroundAgents); err != nil {
			return err
		}
	}
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

func joinSessionRuntimeContext(metadata SessionMetadata, internal map[string]any) (map[string]any, error) {
	result := cloneJSONMap(internal)
	if result == nil {
		result = map[string]any{}
	}
	result["visible"] = metadata.Visible
	result["imported"] = metadata.Imported
	result["capabilities"] = append([]string(nil), metadata.Capabilities...)
	if metadata.Usage != nil {
		var value map[string]any
		if err := remarshalJSON(metadata.Usage, &value); err != nil {
			return nil, err
		}
		result["usage"] = value
	}
	if metadata.BackgroundAgents != nil {
		var value map[string]any
		if err := remarshalJSON(metadata.BackgroundAgents, &value); err != nil {
			return nil, err
		}
		result["backgroundAgents"] = value
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
