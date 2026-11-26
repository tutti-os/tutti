package agentruntime

import (
	"strings"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func acpMetaMap(update map[string]any) map[string]any {
	if len(update) == 0 {
		return nil
	}
	meta, _ := update["_meta"].(map[string]any)
	return meta
}

func acpHasTerminalContent(value any) bool {
	items, ok := value.([]any)
	if !ok {
		return false
	}
	for _, item := range items {
		entry, _ := item.(map[string]any)
		if strings.EqualFold(strings.TrimSpace(asString(entry["type"])), "terminal") {
			return true
		}
	}
	return false
}

func acpHasTerminalToolContract(update map[string]any) bool {
	if acpHasTerminalContent(update["content"]) {
		return true
	}
	meta := acpMetaMap(update)
	if len(meta) == 0 {
		return false
	}
	_, hasInfo := meta["terminal_info"]
	_, hasOutput := meta["terminal_output"]
	_, hasExit := meta["terminal_exit"]
	return hasInfo || hasOutput || hasExit
}

func acpTerminalInfoCWD(update map[string]any) string {
	meta := acpMetaMap(update)
	if len(meta) == 0 {
		return ""
	}
	info, _ := meta["terminal_info"].(map[string]any)
	return strings.TrimSpace(asString(info["cwd"]))
}

func acpTerminalOutputDelta(update map[string]any) string {
	meta := acpMetaMap(update)
	if len(meta) == 0 {
		return ""
	}
	output, _ := meta["terminal_output"].(map[string]any)
	data, _ := output["data"].(string)
	return data
}

func acpTerminalExitMetadata(update map[string]any) (int, string, bool) {
	meta := acpMetaMap(update)
	if len(meta) == 0 {
		return 0, "", false
	}
	exitInfo, ok := meta["terminal_exit"].(map[string]any)
	if !ok || len(exitInfo) == 0 {
		return 0, "", false
	}
	if code, ok := acpIntFromValue(exitInfo["exit_code"]); ok {
		return code, strings.TrimSpace(asString(exitInfo["signal"])), true
	}
	if code, ok := acpIntFromValue(exitInfo["exitCode"]); ok {
		return code, strings.TrimSpace(asString(exitInfo["signal"])), true
	}
	return 0, "", false
}

func isGenericExecuteToolTitle(title string) bool {
	switch strings.ToLower(strings.TrimSpace(title)) {
	case "", "bash", "sh", "zsh", "cmd", "powershell", "terminal", "execute", "command", "run command", "tool":
		return true
	default:
		return false
	}
}

func acpApplyTerminalToolInput(
	update map[string]any,
	callID string,
	kind string,
	inputBody map[string]any,
) map[string]any {
	if !strings.EqualFold(strings.TrimSpace(kind), "execute") || !acpHasTerminalToolContract(update) {
		return inputBody
	}
	if inputBody == nil {
		inputBody = map[string]any{}
	}
	if acpExtractShellCommand(inputBody["command"]) == "" {
		trimmedTitle := strings.TrimSpace(asString(update["title"]))
		if trimmedTitle != "" &&
			!isOpaqueCallIdentifierString(trimmedTitle, callID) &&
			!isGenericExecuteToolTitle(trimmedTitle) {
			inputBody["command"] = trimmedTitle
		}
	}
	if cwd := acpTerminalInfoCWD(update); cwd != "" && strings.TrimSpace(asString(inputBody["cwd"])) == "" {
		inputBody["cwd"] = cwd
	}
	if len(inputBody) == 0 {
		return nil
	}
	return inputBody
}

func acpApplyTerminalToolOutput(update map[string]any, callBody map[string]any) map[string]any {
	delta := acpTerminalOutputDelta(update)
	exitCode, signal, hasExit := acpTerminalExitMetadata(update)
	if delta == "" && !hasExit {
		return callBody
	}
	if callBody == nil {
		callBody = map[string]any{}
	}
	if delta != "" && strings.TrimSpace(asString(callBody["stdout"])) == "" {
		callBody["stdout"] = delta
		if strings.TrimSpace(asString(callBody["text"])) == "" {
			callBody["text"] = delta
		}
	}
	if hasExit {
		if _, exists := callBody["exitCode"]; !exists {
			callBody["exitCode"] = exitCode
		}
		if signal != "" {
			if _, exists := callBody["signal"]; !exists {
				callBody["signal"] = signal
			}
		}
	}
	return callBody
}

func acpIsStreamingTerminalOutputOnlyUpdate(update map[string]any) bool {
	if acpTerminalOutputDelta(update) == "" {
		return false
	}
	if _, _, hasExit := acpTerminalExitMetadata(update); hasExit {
		return false
	}
	if acpToolCallRawInput(update) != nil || acpToolCallRawOutput(update) != nil {
		return false
	}
	if update["locations"] != nil || update["content"] != nil {
		return false
	}
	return true
}

func applyStreamedTerminalOutputToTerminalEvent(
	event *activityshared.Event,
	priorStreamed string,
	finalDelta string,
) {
	if event == nil || priorStreamed == "" {
		return
	}
	if event.Type != activityshared.EventCallCompleted && event.Type != activityshared.EventCallFailed {
		return
	}
	combined, _ := appendBoundedToolOutputText(priorStreamed, finalDelta)
	if combined == "" {
		return
	}
	metadata := clonePayload(event.Payload.Metadata)
	if metadata == nil {
		metadata = map[string]any{}
	}
	switch event.Type {
	case activityshared.EventCallCompleted:
		output := clonePayload(payloadMap(metadata, "output"))
		if output == nil {
			output = map[string]any{}
		}
		output["stdout"] = combined
		output["text"] = combined
		metadata["output"] = output
		event.Payload.Output = output
	case activityshared.EventCallFailed:
		errBody := clonePayload(payloadMap(metadata, "error"))
		if errBody == nil {
			errBody = map[string]any{}
		}
		errBody["stdout"] = combined
		errBody["text"] = combined
		metadata["error"] = errBody
		event.Payload.Error = errBody
		if mirrored := acpMirrorFailedToolOutput(errBody); len(mirrored) > 0 {
			metadata["output"] = mirrored
			event.Payload.Output = mirrored
		}
	}
	event.Payload.Metadata = metadata
}
