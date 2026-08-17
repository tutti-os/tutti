package agentruntime

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strings"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

var (
	appServerFileCitationPattern          = regexp.MustCompile(`:codex-file-citation\{([^{}\r\n]*)\}`)
	appServerFileCitationAttributePattern = regexp.MustCompile(`(?:^|\s)(path|purpose)="([^"\r\n]*)"`)
)

func (a *CodexAppServerAdapter) appServerInfo(raw json.RawMessage) map[string]any {
	runtimeName := ""
	displayName := ""
	if a != nil {
		runtimeName = strings.TrimSpace(a.config.runtimeName)
		displayName = strings.TrimSpace(a.config.displayName)
	}
	info := map[string]any{
		"name":  runtimeName,
		"title": displayName,
	}
	if len(raw) == 0 {
		return info
	}
	var result struct {
		UserAgent string `json:"userAgent"`
		CodexHome string `json:"codexHome"`
		// The Tutti Agent fork renames the initialize home field; its serde
		// alias only applies to deserialization, so both spellings must be
		// accepted here.
		TuttiAgentHome string `json:"tuttiAgentHome"`
		PlatformOS     string `json:"platformOs"`
		PlatformFamily string `json:"platformFamily"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return info
	}
	if result.UserAgent != "" {
		info["userAgent"] = result.UserAgent
	}
	if result.CodexHome == "" {
		result.CodexHome = result.TuttiAgentHome
	}
	if result.CodexHome != "" {
		info["codexHome"] = result.CodexHome
	}
	if result.PlatformOS != "" {
		info["platformOs"] = result.PlatformOS
	}
	return info
}

func appServerThreadID(raw json.RawMessage) (string, error) {
	var result struct {
		Thread struct {
			ID string `json:"id"`
		} `json:"thread"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return "", err
	}
	if strings.TrimSpace(result.Thread.ID) == "" {
		return "", errors.New("app-server thread/start returned empty thread id")
	}
	return strings.TrimSpace(result.Thread.ID), nil
}

func appServerTurnFromResult(raw json.RawMessage) map[string]any {
	if len(raw) == 0 {
		return nil
	}
	var result struct {
		Turn map[string]any `json:"turn"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return nil
	}
	return result.Turn
}

func appServerTurnFinalAssistantText(turn map[string]any) string {
	items, _ := turn["items"].([]any)
	for index := len(items) - 1; index >= 0; index-- {
		item := payloadObject(items[index])
		if asString(item["type"]) == "agentMessage" {
			return normalizeAppServerFileCitations(strings.TrimSpace(asStringRaw(item["text"])))
		}
	}
	return ""
}

func normalizeAppServerFileCitations(text string) string {
	return appServerFileCitationPattern.ReplaceAllStringFunc(text, func(marker string) string {
		body := strings.TrimSuffix(strings.TrimPrefix(marker, ":codex-file-citation{"), "}")
		attributes := appServerFileCitationAttributePattern.FindAllStringSubmatch(body, -1)
		values := make(map[string]string, len(attributes))
		for _, attribute := range attributes {
			if len(attribute) != 3 || values[attribute[1]] != "" {
				return marker
			}
			values[attribute[1]] = attribute[2]
		}

		filePath := strings.TrimSpace(values["path"])
		if values["purpose"] != "output" || !isAppServerAbsoluteFilePath(filePath) {
			return marker
		}

		normalizedPath := filePath
		if isAppServerWindowsAbsoluteFilePath(normalizedPath) {
			normalizedPath = strings.ReplaceAll(normalizedPath, `\`, "/")
		}
		fileName := normalizedPath
		if separator := strings.LastIndex(normalizedPath, "/"); separator >= 0 {
			fileName = normalizedPath[separator+1:]
		}
		if fileName == "" {
			return marker
		}

		return fmt.Sprintf(
			"[@%s](<%s>)",
			escapeAppServerMarkdownLabel(fileName),
			escapeAppServerMarkdownPath(normalizedPath),
		)
	})
}

func isAppServerAbsoluteFilePath(filePath string) bool {
	return (strings.HasPrefix(filePath, "/") && !strings.HasPrefix(filePath, "//")) ||
		isAppServerWindowsAbsoluteFilePath(filePath)
}

func isAppServerWindowsAbsoluteFilePath(filePath string) bool {
	return len(filePath) >= 3 &&
		((filePath[0] >= 'a' && filePath[0] <= 'z') || (filePath[0] >= 'A' && filePath[0] <= 'Z')) &&
		filePath[1] == ':' &&
		(filePath[2] == '/' || filePath[2] == '\\')
}

func escapeAppServerMarkdownLabel(label string) string {
	replacer := strings.NewReplacer(`\`, `\\`, "[", `\[`, "]", `\]`)
	return replacer.Replace(label)
}

func escapeAppServerMarkdownPath(filePath string) string {
	segments := strings.Split(filePath, "/")
	for index, segment := range segments {
		if index == 0 && isAppServerWindowsAbsoluteFilePath(filePath) {
			continue
		}
		segments[index] = url.PathEscape(segment)
	}
	return strings.Join(segments, "/")
}

func appServerTurnTerminalEvents(
	session Session,
	turnID string,
	turn map[string]any,
	normalizer *acpTurnNormalizer,
) []activityshared.Event {
	status := asString(turn["status"])
	providerTurnID := firstNonEmpty(asString(turn["id"]), turnID)
	switch status {
	case "interrupted":
		events := normalizer.FinishInterrupted(session, turnID, "interrupted")
		terminal := appServerRootProviderTurnCompletedEvent(session, turnID, providerTurnID, activityshared.TurnOutcomeCanceled, map[string]any{"stopReason": "canceled"})
		return append(events, terminal)
	case "failed":
		events := normalizer.FinishFailed(session, turnID)
		metadata := map[string]any{
			"stopReason": "failed",
		}
		if turnError := payloadObject(turn["error"]); len(turnError) > 0 {
			if message := asStringRaw(turnError["message"]); message != "" {
				metadata["error"] = message
				metadata["errorMessage"] = message
			}
			if codexErrorInfo := turnError["codexErrorInfo"]; codexErrorInfo != nil {
				metadata["codexErrorInfo"] = clonePayloadValue(codexErrorInfo)
			}
			if details := asStringRaw(turnError["additionalDetails"]); details != "" {
				metadata["additionalDetails"] = details
			}
		}
		terminal := appServerRootProviderTurnCompletedEvent(session, turnID, providerTurnID, activityshared.TurnOutcomeFailed, metadata)
		return append(events, terminal)
	default:
		events := normalizer.FinishCompleted(session, turnID)
		terminal := appServerRootProviderTurnCompletedEvent(session, turnID, providerTurnID, activityshared.TurnOutcomeCompleted, map[string]any{"stopReason": "end_turn"})
		return append(events, terminal)
	}
}

func appServerRootProviderTurnCompletedEvent(
	session Session,
	rootTurnID string,
	providerTurnID string,
	outcome activityshared.TurnOutcome,
	metadata map[string]any,
) activityshared.Event {
	providerTurnID = firstNonEmpty(strings.TrimSpace(providerTurnID), strings.TrimSpace(rootTurnID))
	ctx, ok := activityEventContext(session, "root-provider-turn-completed:"+providerTurnID, rootTurnID)
	if !ok {
		return activityshared.Event{}
	}
	event := activityshared.NewRootProviderTurnCompleted(ctx, rootTurnID, providerTurnID, outcome)
	event.Payload.Metadata = clonePayload(metadata)
	return event
}

// --- session capability metadata ---

func codexAppServerCommands() []AgentSessionCommand {
	return []AgentSessionCommand{
		{Name: "review", Description: "Review code changes", InputHint: "instructions (optional)"},
		{Name: "goal", Description: "Show or update the thread goal", InputHint: "objective, status, or clear"},
		{Name: "compact", Description: "Compact the conversation context"},
		{Name: "undo", Description: "Drop the last turn from the conversation"},
	}
}

func codexAppServerCapabilities(planMode bool) []string {
	capabilities := []string{
		CapabilityImageInput,
		CapabilitySkills,
		CapabilityInterrupt,
		CapabilityActiveTurnGuidance,
		CapabilityCompact,
		CapabilityRateLimits,
		CapabilityTokenUsage,
		"review",
		"goal",
		CapabilityGoalPause,
		CapabilityPlanImplementation,
		CapabilityPermissionModeChangeDuringTurn,
		CapabilityPermissionModeChangeDeferred,
		"rollback",
		"fork",
		"perTurnModelOverride",
	}
	if planMode {
		// Negotiated at session start via the experimental
		// collaborationMode/list probe.
		capabilities = append(capabilities, CapabilityPlanMode)
	}
	return capabilities
}

// asStringRaw returns string values without trimming, so streaming deltas keep
// their whitespace. Non-strings return "".
func asStringRaw(value any) string {
	typed, _ := value.(string)
	return typed
}

// appServerSearchQueries reads action.queries[] (Codex app-server webSearch
// schema) into a []any of non-empty trimmed strings, suitable for the GUI's
// search_query rendering. Returns nil when absent or empty.
func appServerSearchQueries(value any) []any {
	raw, ok := value.([]any)
	if !ok {
		return nil
	}
	out := make([]any, 0, len(raw))
	for _, entry := range raw {
		if text := asString(entry); text != "" {
			out = append(out, text)
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// firstAppServerQuery returns the first non-empty query string from a
// search_query list produced by appServerSearchQueries.
func firstAppServerQuery(queries []any) string {
	for _, q := range queries {
		if text := asString(q); text != "" {
			return text
		}
	}
	return ""
}

// appServerItemJSON renders a raw thread item as compact JSON for diagnostics,
// falling back to Go formatting if the item is not JSON-serializable.
func appServerItemJSON(item map[string]any) string {
	if encoded, err := json.Marshal(item); err == nil {
		return string(encoded)
	}
	return fmt.Sprintf("%+v", item)
}

// appServerReasoningText pulls the human-readable text out of a completed
// `reasoning` thread item. Per the Codex app-server schema, the ThreadItem
// reasoning variant is {id, summary, content} where summary and content are
// usually string arrays. Some app-server versions also stream reasoning via
// summaryTextDelta/textDelta and may emit completed items before those arrays
// are populated, so callers should still handle streaming deltas.
func appServerReasoningText(item map[string]any) string {
	if text := reasoningSectionsText(item["summary"]); text != "" {
		return text
	}
	if text := reasoningSectionsText(item["content"]); text != "" {
		return text
	}
	return firstNonEmpty(asStringRaw(item["text"]), asString(item["text"]))
}

// appServerReasoningDeltaText reads a reasoning delta payload. Most app-server
// versions use `delta`, but some event shapes expose the chunk as `text`.
// Streaming chunks must preserve their leading/trailing whitespace (e.g. a
// "Need " token followed by "context.") so concatenated reasoning text keeps
// word boundaries; do not trim here.
func appServerReasoningDeltaText(params map[string]any) string {
	if delta := asStringRaw(params["delta"]); delta != "" {
		return delta
	}
	return asStringRaw(params["text"])
}

// reasoningSectionsText joins the non-empty sections of a reasoning
// summary/content value, separating sections with a blank line.
func reasoningSectionsText(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case []string:
		return joinReasoningSectionTexts(typed)
	case []any:
		parts := make([]string, 0, len(typed))
		for _, raw := range typed {
			if text := reasoningSectionText(raw); text != "" {
				parts = append(parts, text)
			}
		}
		return strings.Join(parts, "\n\n")
	default:
		return ""
	}
}

func joinReasoningSectionTexts(values []string) string {
	var b strings.Builder
	for _, value := range values {
		text := asStringRaw(value)
		if text == "" {
			continue
		}
		if b.Len() > 0 {
			b.WriteString("\n\n")
		}
		b.WriteString(text)
	}
	return b.String()
}

func reasoningSectionText(raw any) string {
	if text := asStringRaw(raw); text != "" {
		return text
	}
	item, ok := raw.(map[string]any)
	if !ok {
		return ""
	}
	return firstNonEmpty(
		asStringRaw(item["text"]),
		asStringRaw(item["summary_text"]),
		asStringRaw(item["summaryText"]),
		asStringRaw(item["summary"]),
		asStringRaw(item["content"]),
		asString(item["text"]),
		asString(item["summary_text"]),
		asString(item["summaryText"]),
		asString(item["summary"]),
		asString(item["content"]),
	)
}
