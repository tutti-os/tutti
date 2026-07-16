package agentruntime

import (
	"encoding/json"
	"strings"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

// ACP permission requests carry provider-defined option IDs. This file owns
// only ACP decoding and response-envelope details; shared interactive state
// and activity projection live in interactive_projection.go.
func acpPermissionRequestDecisionOptionID(
	raw json.RawMessage,
	decision string,
	filter func([]map[string]any) []map[string]any,
) (string, bool) {
	var params struct {
		Options []map[string]any `json:"options"`
	}
	if err := json.Unmarshal(raw, &params); err != nil {
		return "", false
	}
	if filter != nil {
		params.Options = filter(params.Options)
	}
	return resolveACPPermissionDecisionOptionID(params.Options, decision)
}

func resolveACPPermissionDecisionOptionID(options []map[string]any, decision string) (string, bool) {
	aliases := permissionOptionDecisionAliases(decision)
	if len(aliases) == 0 {
		return "", false
	}
	for _, option := range options {
		resolvedOptionID := firstNonEmpty(asString(option["optionId"]), asString(option["id"]))
		if resolvedOptionID == "" {
			continue
		}
		for _, value := range []string{resolvedOptionID, asString(option["kind"]), asString(option["name"]), asString(option["label"])} {
			token := normalizePermissionOptionToken(value)
			for _, alias := range aliases {
				if token != "" && token == alias {
					return resolvedOptionID, true
				}
			}
		}
	}
	return "", false
}

func acpPermissionResponseResult(optionID string) map[string]any {
	return map[string]any{"outcome": map[string]any{"outcome": "selected", "optionId": strings.TrimSpace(optionID)}}
}

func acpInteractiveResponseResult(action string, optionID string, payload map[string]any) map[string]any {
	outcome := map[string]any{"outcome": firstNonEmpty(strings.TrimSpace(action), "submitted")}
	if optionID = strings.TrimSpace(optionID); optionID != "" {
		outcome["optionId"] = optionID
	}
	if payload = clonePayload(payload); payload != nil {
		outcome["payload"] = payload
	}
	return map[string]any{"outcome": outcome}
}

func acpPermissionOutOfBandResolvedEvents(session Session, turnID string, pending *pendingInteractiveRequest) []activityshared.Event {
	if pending == nil {
		return nil
	}
	callType := firstNonEmpty(strings.TrimSpace(pending.callType), "approval")
	return []activityshared.Event{
		normalizedInteractionSupersededEvent(session, turnID, pending),
		newTurnActivityEventWithID(session, pending.eventID, EventCallFailed, turnID, messageStreamStateFailed, "", pending.name, map[string]any{
			"callId": pending.callID, "callType": callType, "name": pending.name, "toolName": pending.toolName,
			"status": messageStreamStateFailed,
			"error":  map[string]any{"requestId": pending.requestID, "message": "Codex resolved this request without a response from tutti (it may have timed out or been canceled); outcome unknown."},
		}),
		newTurnActivityEvent(session, EventTurnUpdated, turnID, SessionStatusWorking, "", "", map[string]any{
			"phase": string(activityshared.TurnPhaseWorking), "requestId": pending.requestID,
		}),
	}
}

func acpRequestID(raw json.RawMessage) string {
	var text string
	if err := json.Unmarshal(raw, &text); err == nil {
		return strings.TrimSpace(text)
	}
	var number json.Number
	if err := json.Unmarshal(raw, &number); err == nil {
		return strings.TrimSpace(number.String())
	}
	return strings.TrimSpace(string(raw))
}
