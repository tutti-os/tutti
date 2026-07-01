package agentruntime

import (
	"bufio"
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

func appServerCollabAgentRawOutput(item map[string]any, tool string) map[string]any {
	output := map[string]any{}
	if message := firstNonEmpty(
		appServerOutputText(item["error"]),
		appServerOutputText(item["message"]),
	); message != "" {
		output["message"] = message
	}
	status := asString(item["status"])
	if status != "" {
		output["status"] = status
	}
	if text := firstNonEmpty(
		appServerOutputText(item["output"]),
		appServerOutputText(item["stdout"]),
	); text != "" {
		output["output"] = text
	}
	if stderr := appServerOutputText(item["stderr"]); stderr != "" {
		output["stderr"] = stderr
	}
	if result := item["result"]; result != nil {
		output["result"] = clonePayloadValue(result)
	}
	targets := appServerStringList(item["receiverThreadIds"], item["receiver_thread_ids"], item["targets"])
	agentsStates := appServerAgentStates(item["agentsStates"], item["agents_states"])
	if len(agentsStates) > 0 {
		output["agentsStates"] = clonePayloadValue(agentsStates)
	}
	switch normalizeAgentToolToken(tool) {
	case "spawnagent", "spawn":
		if len(targets) > 0 {
			output["agent_id"] = targets[0]
			output["agentId"] = targets[0]
		}
	case "waitagent", "wait":
		if len(agentsStates) > 0 {
			statuses := make(map[string]any, len(agentsStates))
			for agentID, state := range agentsStates {
				statuses[agentID] = appServerCollabAgentStatusObject(state)
			}
			output["status"] = statuses
			output["timed_out"] = normalizeAgentToolToken(status) == "timedout"
		}
	case "closeagent", "close":
		if len(targets) > 0 {
			output["agent_id"] = targets[0]
		}
		if previous := appServerFirstAgentState(targets, agentsStates); previous != nil {
			output["previous_status"] = appServerCollabAgentStatusObject(previous)
		}
	}
	if _, ok := output["output"]; !ok {
		if summary := appServerCollabAgentOutputSummary(output); summary != "" {
			output["output"] = summary
		}
	}
	return output
}

func (a *CodexAppServerAdapter) completeAppServerCollabAgentToolOutput(
	session Session,
	item map[string]any,
	update map[string]any,
) {
	output, _ := update["rawOutput"].(map[string]any)
	if appServerCollabAgentHasMeaningfulOutput(output) {
		return
	}
	callID := firstNonEmpty(asString(item["id"]), asString(update["toolCallId"]))
	rolloutOutput := a.appServerCollabAgentRolloutOutput(
		session.AgentSessionID,
		session.ProviderSessionID,
		callID,
	)
	if appServerCollabAgentHasMeaningfulOutput(rolloutOutput) {
		update["rawOutput"] = rolloutOutput
		return
	}
	if asString(update["status"]) == messageStreamStateFailed {
		slog.Debug(
			"agent session app-server collab agent failed without output",
			"agent_session_id", session.AgentSessionID,
			"provider_session_id", session.ProviderSessionID,
			"itemId", callID,
			"tool", asString(item["tool"]),
			"rawItem", appServerItemJSON(item),
		)
	}
}

func appServerCollabAgentHasMeaningfulOutput(output map[string]any) bool {
	if len(output) == 0 {
		return false
	}
	for _, key := range []string{
		"output",
		"message",
		"stderr",
		"result",
		"agent_id",
		"agentId",
		"agentsStates",
		"previous_status",
	} {
		if value, ok := output[key]; ok && value != nil {
			if strings.TrimSpace(asStringRaw(value)) != "" || len(payloadObject(value)) > 0 {
				return true
			}
		}
	}
	statuses := payloadObject(output["status"])
	return len(statuses) > 0
}

func (a *CodexAppServerAdapter) appServerCollabAgentRolloutOutput(
	agentSessionID string,
	providerThreadID string,
	callID string,
) map[string]any {
	codexHome := a.appServerCodexHome(agentSessionID)
	if strings.TrimSpace(codexHome) == "" || strings.TrimSpace(providerThreadID) == "" || strings.TrimSpace(callID) == "" {
		return nil
	}
	output, err := appServerReadRolloutFunctionCallOutput(codexHome, providerThreadID, callID)
	if err != nil {
		slog.Debug(
			"agent session app-server collab agent rollout output lookup failed",
			"agent_session_id", agentSessionID,
			"provider_session_id", providerThreadID,
			"call_id", callID,
			"error", err.Error(),
		)
		return nil
	}
	return output
}

func (a *CodexAppServerAdapter) appServerCodexHome(agentSessionID string) string {
	if a == nil {
		return ""
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	appSession := a.sessions[strings.TrimSpace(agentSessionID)]
	if appSession == nil {
		return ""
	}
	return strings.TrimSpace(asString(appSession.serverInfo["codexHome"]))
}

func appServerReadRolloutFunctionCallOutput(codexHome string, providerThreadID string, callID string) (map[string]any, error) {
	path, err := appServerRolloutPath(codexHome, providerThreadID)
	if err != nil || path == "" {
		return nil, err
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for scanner.Scan() {
		var entry struct {
			Type    string         `json:"type"`
			Payload map[string]any `json:"payload"`
		}
		if err := json.Unmarshal(scanner.Bytes(), &entry); err != nil {
			continue
		}
		if entry.Type != "response_item" ||
			asString(entry.Payload["type"]) != "function_call_output" ||
			asString(entry.Payload["call_id"]) != callID {
			continue
		}
		return appServerRolloutFunctionCallOutputBody(entry.Payload["output"]), nil
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return nil, nil
}

func appServerRolloutPath(codexHome string, providerThreadID string) (string, error) {
	root := filepath.Join(codexHome, "sessions")
	if _, err := os.Stat(root); err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", err
	}
	var newestPath string
	var newestModTime int64
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil || entry == nil || entry.IsDir() {
			return nil
		}
		if filepath.Ext(path) != ".jsonl" || !strings.Contains(filepath.Base(path), providerThreadID) {
			return nil
		}
		info, statErr := entry.Info()
		if statErr != nil {
			return nil
		}
		modTime := info.ModTime().UnixNano()
		if newestPath == "" || modTime > newestModTime {
			newestPath = path
			newestModTime = modTime
		}
		return nil
	})
	return newestPath, err
}

func appServerRolloutFunctionCallOutputBody(value any) map[string]any {
	if object := payloadObject(value); len(object) > 0 {
		out := clonePayloadDeep(object)
		if _, ok := out["output"]; !ok {
			if summary := appServerCollabAgentOutputSummary(out); summary != "" {
				out["output"] = summary
			}
		}
		return out
	}
	text := strings.TrimSpace(asStringRaw(value))
	if text == "" {
		return nil
	}
	var object map[string]any
	if err := json.Unmarshal([]byte(text), &object); err == nil && len(object) > 0 {
		out := clonePayloadDeep(object)
		if _, ok := out["output"]; !ok {
			if summary := appServerCollabAgentOutputSummary(out); summary != "" {
				out["output"] = summary
			}
		}
		return out
	}
	return map[string]any{
		"message": text,
		"output":  text,
	}
}

func appServerStringList(values ...any) []string {
	for _, value := range values {
		switch typed := value.(type) {
		case []string:
			out := make([]string, 0, len(typed))
			for _, item := range typed {
				if text := strings.TrimSpace(item); text != "" {
					out = append(out, text)
				}
			}
			if len(out) > 0 {
				return out
			}
		case []any:
			out := make([]string, 0, len(typed))
			for _, item := range typed {
				if text := asString(item); text != "" {
					out = append(out, text)
				}
			}
			if len(out) > 0 {
				return out
			}
		}
	}
	return nil
}

func appServerAgentStates(values ...any) map[string]any {
	for _, value := range values {
		if states := payloadObject(value); len(states) > 0 {
			return states
		}
	}
	return nil
}

func appServerFirstAgentState(targets []string, states map[string]any) any {
	for _, target := range targets {
		if state, ok := states[target]; ok {
			return state
		}
	}
	for _, state := range states {
		return state
	}
	return nil
}

func appServerCollabAgentStatusObject(value any) any {
	record := payloadObject(value)
	if len(record) == 0 {
		return clonePayloadValue(value)
	}
	message := firstNonEmpty(
		appServerOutputText(record["message"]),
		appServerOutputText(record["output"]),
		appServerOutputText(record["result"]),
		appServerOutputText(record["finalMessage"]),
		appServerOutputText(record["final_message"]),
	)
	status := firstNonEmpty(asString(record["status"]), asString(record["state"]))
	normalized := normalizeAgentToolToken(status)
	switch {
	case normalized == "completed" || normalized == "complete" || normalized == "done" || record["completed"] == true || record["done"] == true:
		if message != "" {
			return map[string]any{"completed": message}
		}
		out, _ := clonePayloadValue(record).(map[string]any)
		if out == nil {
			out = map[string]any{}
		}
		out["status"] = "completed"
		return out
	case normalized == "failed" || normalized == "error":
		if message != "" {
			return map[string]any{"failed": message}
		}
	case normalized == "canceled" || normalized == "cancelled":
		if message != "" {
			return map[string]any{"canceled": message}
		}
	}
	return clonePayloadValue(record)
}

func appServerCollabAgentOutputSummary(output map[string]any) string {
	if text := firstNonEmpty(
		appServerOutputText(output["message"]),
		appServerOutputText(output["result"]),
	); text != "" {
		return text
	}
	if previous := payloadObject(output["previous_status"]); len(previous) > 0 {
		return firstNonEmpty(
			appServerOutputText(previous["completed"]),
			appServerOutputText(previous["failed"]),
			appServerOutputText(previous["canceled"]),
			appServerOutputText(previous["message"]),
			appServerOutputText(previous["result"]),
		)
	}
	statuses := payloadObject(output["status"])
	if len(statuses) == 0 {
		if agentID := asString(output["agent_id"]); agentID != "" {
			return agentID
		}
		return ""
	}
	lines := make([]string, 0, len(statuses))
	agentIDs := make([]string, 0, len(statuses))
	for agentID := range statuses {
		agentIDs = append(agentIDs, agentID)
	}
	sort.Strings(agentIDs)
	for _, agentID := range agentIDs {
		value := statuses[agentID]
		state := payloadObject(value)
		text := firstNonEmpty(
			appServerOutputText(state["completed"]),
			appServerOutputText(state["failed"]),
			appServerOutputText(state["canceled"]),
			appServerOutputText(state["message"]),
			appServerOutputText(state["result"]),
		)
		if text == "" {
			continue
		}
		if len(statuses) == 1 {
			return text
		}
		lines = append(lines, agentID+": "+text)
	}
	return strings.Join(lines, "\n")
}
