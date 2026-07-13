package agentruntime

// Nexight's ACP provider config. nexight-acp is codex-acp derived: transport
// retry text arrives as ordinary chunks and stderr logs, and model/effort are
// spawn-time codex config flags.

import (
	"encoding/json"
	"strings"

	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
)

func NewNexightAdapter(transport ProcessTransport) *standardACPAdapter {
	return NewNexightAdapterWithHostMetadata(transport, LegacyHostMetadata())
}

func NewNexightAdapterWithHostMetadata(transport ProcessTransport, host HostMetadata) *standardACPAdapter {
	descriptor, ok := providerregistry.Find(ProviderNexight)
	if !ok {
		panic("nexight provider descriptor is missing")
	}
	return newNexightAdapterFromProviderDescriptor(descriptor, transport, host, nil)
}

func newNexightAdapterFromProviderDescriptor(descriptor providerregistry.ProviderDescriptor, transport ProcessTransport, host HostMetadata, commandResolver ProviderCommandResolver) *standardACPAdapter {
	adapter := newStandardACPAdapterFromProviderDescriptor(descriptor, transport, host, commandResolver)
	adapter.config.allowSyntheticNotice = true
	adapter.config.stderrMessageMapper = nexightACPSystemNoticeMessageFromStderr
	adapter.config.commandWithSettings = nexightACPCommandWithSettings
	adapter.config.requiresNewSessionForSettings = nexightRequiresNewSessionForSettings
	return adapter
}

// nexightACPSystemNoticeMessageFromStderr projects codex-acp "handled error
// during turn" stderr retry logs into a synthetic stream_error session/update
// so reconnect attempts surface as transport notices instead of vanishing.
// (Recovered from the retired CodexAdapter; nexight-acp shares that stderr
// format.)
func nexightACPSystemNoticeMessageFromStderr(stderr []byte) (acpMessage, bool) {
	text := strings.TrimSpace(string(stderr))
	if text == "" {
		return acpMessage{}, false
	}
	normalized := strings.ToLower(text)
	if !strings.Contains(normalized, "handled error during turn") {
		return acpMessage{}, false
	}
	if !strings.Contains(normalized, "responsestreamdisconnected") &&
		!strings.Contains(normalized, "broken pipe") &&
		!strings.Contains(normalized, "response stream") {
		return acpMessage{}, false
	}
	detail := truncateACPLogValue(text, 4000)
	params, err := json.Marshal(map[string]any{
		"update": map[string]any{
			"kind":              "agent_system_notice",
			"sessionUpdate":     "stream_error",
			"message":           "ResponseStreamDisconnected",
			"noticeKind":        "transport_retry",
			"severity":          "warning",
			"title":             "Codex connection interrupted. Reconnecting...",
			"detail":            detail,
			"additionalDetails": detail,
			"retryable":         true,
			"source":            "acp_stderr",
		},
	})
	if err != nil {
		return acpMessage{}, false
	}
	return acpMessage{
		JSONRPC: "2.0",
		Method:  acpMethodUpdate,
		Params:  params,
	}, true
}

// nexightACPConfigFlag is the codex-acp CLI flag for spawn-time config
// overrides (recovered with the settings logic from the retired CodexAdapter).
const nexightACPConfigFlag = "--config"

// nexightACPCommandWithSettings appends the session's model/effort settings as
// spawn-time codex config flags; without them model selection depends entirely
// on the agent advertising a "model" config option after session/new.
func nexightACPCommandWithSettings(base []string, session Session) []string {
	command := append([]string(nil), base...)
	if len(command) == 0 {
		return command
	}
	for _, entry := range nexightACPConfigEntries(session) {
		command = append(command, nexightACPConfigFlag, entry)
	}
	return command
}

func nexightACPConfigEntries(session Session) []string {
	settings := session.SettingsValue()
	entries := make([]string, 0, 4)
	if model := strings.TrimSpace(settings.Model); model != "" {
		entries = append(entries, "model="+model)
		if summary := codexACPReasoningSummaryOverride(model); summary != "" {
			entries = append(entries, codexACPConfigModelReasoningSummary+"="+summary)
		}
	}
	if reasoning := codexACPReasoningEffortValue(settings.ReasoningEffort); reasoning != "" {
		entries = append(entries, "model_reasoning_effort="+reasoning)
	}
	return entries
}

// nexightRequiresNewSessionForSettings forces a new session when the
// spark-family model_reasoning_summary spawn override would change: it is a
// process-start-only flag, so a live session cannot apply it.
func nexightRequiresNewSessionForSettings(session Session, patch SessionSettingsPatch) bool {
	if patch.Model == nil {
		return false
	}
	currentModel := session.SettingsValue().Model
	nextModel := strings.TrimSpace(*patch.Model)
	return codexACPReasoningSummaryOverride(currentModel) != codexACPReasoningSummaryOverride(nextModel)
}
