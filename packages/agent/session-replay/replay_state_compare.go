package sessionreplay

import (
	"encoding/json"
	"fmt"
	"reflect"
	"sort"
	"strings"

	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
)

// normalizeReplayStateForComparison preserves relationships while replacing
// runtime-generated identifiers with stable structural names. Historical
// restore still receives the original identifiers; only final-state
// verification treats alpha-equivalent graphs as the same semantic state.
func normalizeReplayStateForComparison(state TuttiReplayState) TuttiReplayState {
	raw, _ := json.Marshal(state)
	var value map[string]any
	_ = json.Unmarshal(raw, &value)

	replacements := map[string]string{}
	registerReplayIDs(replacements, value)
	replaceReplayIDs(value, replacements)
	stripVolatileGoalTimingFields(value)
	canonicalizeTurnFileChanges(value)

	normalized, _ := json.Marshal(value)
	var result TuttiReplayState
	_ = json.Unmarshal(normalized, &result)
	return result
}

// canonicalizeTurnFileChanges folds recorded and live turn.fileChanges into the
// shared tool fileChanges contract so older cassettes that still store raw
// created-file bodies under diff/unifiedDiff compare equal to live newString.
// Trailing EOLs on text bodies are stripped: apply_patch rematerialization often
// adds a final newline that older expected-state tokens omitted.
func canonicalizeTurnFileChanges(value map[string]any) {
	agent, _ := value["agent"].(map[string]any)
	sessions, _ := agent["sessions"].([]any)
	for _, item := range sessions {
		session, _ := item.(map[string]any)
		turns, _ := session["turns"].([]any)
		for _, turnItem := range turns {
			turn, _ := turnItem.(map[string]any)
			if turn == nil {
				continue
			}
			normalized := canonical.NormalizeToolFileChanges(turn["fileChanges"])
			if normalized == nil {
				delete(turn, "fileChanges")
				continue
			}
			normalizeFileChangeTextFields(normalized)
			turn["fileChanges"] = normalized
		}
	}
}

func normalizeFileChangeTextFields(fileChanges map[string]any) {
	files, _ := fileChanges["files"].([]any)
	for _, item := range files {
		file, _ := item.(map[string]any)
		if file == nil {
			continue
		}
		for _, key := range []string{
			"content",
			"diff",
			"newString",
			"oldString",
			"unifiedDiff",
		} {
			text, ok := file[key].(string)
			if !ok {
				continue
			}
			file[key] = strings.TrimRight(text, "\r\n")
		}
	}
}

// stripVolatileGoalTimingFields drops Goal wall-clock / duration fields that
// rematerialize differently across record→replay while leaving semantic Goal
// fields (objective, status, reason, …) in the comparison contract.
func stripVolatileGoalTimingFields(value map[string]any) {
	agent, _ := value["agent"].(map[string]any)
	sessions, _ := agent["sessions"].([]any)
	for _, item := range sessions {
		session, _ := item.(map[string]any)
		goal, _ := session["goal"].(map[string]any)
		if goal == nil {
			continue
		}
		for _, side := range []string{"desired", "observed"} {
			payload, ok := goal[side].(map[string]any)
			if !ok || payload == nil {
				continue
			}
			delete(payload, "startedAtUnixMs")
			delete(payload, "durationMs")
		}
	}
}

func registerReplayIDs(replacements map[string]string, value map[string]any) {
	agent, _ := value["agent"].(map[string]any)
	sessions, _ := agent["sessions"].([]any)
	for sessionIndex, item := range sessions {
		session, _ := item.(map[string]any)
		registerReplayID(replacements, session["id"], fmt.Sprintf("session:%d", sessionIndex))
		turns, _ := session["turns"].([]any)
		for turnIndex, turnItem := range turns {
			turn, _ := turnItem.(map[string]any)
			registerReplayID(replacements, turn["id"], fmt.Sprintf("session:%d/turn:%d", sessionIndex, turnIndex))
			// Claude goal clear/fork paths can remint rootProviderTurnId across
			// record→replay even when the Tutti turn shape is equivalent. Treat
			// it like other runtime IDs for final-state compare. If it already
			// equals the Tutti turn id, keep the turn mapping (first wins).
			registerReplayID(
				replacements,
				turn["rootProviderTurnId"],
				fmt.Sprintf("session:%d/turn:%d/rootProviderTurn", sessionIndex, turnIndex),
			)
		}
		messages, _ := session["messages"].([]any)
		for messageIndex, messageItem := range messages {
			message, _ := messageItem.(map[string]any)
			registerReplayID(replacements, message["id"], fmt.Sprintf("session:%d/message:%d", sessionIndex, messageIndex))
			if payload, ok := message["payload"].(map[string]any); ok {
				delete(payload, "seq")
				registerReplayID(replacements, payload["operationId"], fmt.Sprintf("session:%d/message:%d/operation", sessionIndex, messageIndex))
				// tool_call / approval callId remints across record→replay while
				// the structural message slot stays the same.
				registerReplayID(replacements, payload["callId"], fmt.Sprintf("session:%d/message:%d/call", sessionIndex, messageIndex))
				content, _ := payload["content"].([]any)
				for contentIndex, contentItem := range content {
					block, _ := contentItem.(map[string]any)
					registerReplayID(replacements, block["attachmentId"], fmt.Sprintf("session:%d/message:%d/attachment:%d", sessionIndex, messageIndex, contentIndex))
				}
			}
		}
		interactions, _ := session["interactions"].([]any)
		for interactionIndex, interactionItem := range interactions {
			interaction, _ := interactionItem.(map[string]any)
			registerReplayID(replacements, interaction["requestId"], fmt.Sprintf("session:%d/interaction:%d", sessionIndex, interactionIndex))
		}
	}
	tuttiMode, _ := value["tuttiMode"].(map[string]any)
	registerReplayArrayIDs(replacements, tuttiMode["activations"], "activation")
	registerReplayArrayIDs(replacements, value["workflows"], "workflow")
	registerReplayArrayIDs(replacements, value["issues"], "issue")
	if issues, ok := value["issues"].([]any); ok {
		for issueIndex, item := range issues {
			issue, _ := item.(map[string]any)
			tasks, _ := issue["tasks"].([]any)
			for taskIndex, taskItem := range tasks {
				task, _ := taskItem.(map[string]any)
				registerReplayID(replacements, task["id"], fmt.Sprintf("issue:%d/task:%d", issueIndex, taskIndex))
			}
		}
	}
}

func registerReplayArrayIDs(replacements map[string]string, value any, prefix string) {
	items, _ := value.([]any)
	for index, item := range items {
		object, _ := item.(map[string]any)
		registerReplayID(replacements, object["id"], fmt.Sprintf("%s:%d", prefix, index))
	}
}

func registerReplayID(replacements map[string]string, value any, replacement string) {
	id, ok := value.(string)
	if !ok || id == "" {
		return
	}
	if _, exists := replacements[id]; exists {
		return
	}
	replacements[id] = replacement
}

func replaceReplayIDs(value any, replacements map[string]string) {
	switch value := value.(type) {
	case map[string]any:
		for key, child := range value {
			if text, ok := child.(string); ok {
				if replacement, exists := replacements[text]; exists {
					value[key] = replacement
				}
				continue
			}
			replaceReplayIDs(child, replacements)
		}
	case []any:
		for _, child := range value {
			replaceReplayIDs(child, replacements)
		}
	}
}

func firstReplayStateMismatch(path string, expected, actual any) string {
	return firstReplayStateMismatchComparable(
		path,
		replayComparableValue(expected),
		replayComparableValue(actual),
	)
}

func firstReplayStateMismatchComparable(
	path string,
	expectedValue, actualValue any,
) string {
	if isComposerSettingsPath(path) {
		expectedSettings, expectedOK := expectedValue.(map[string]any)
		actualSettings, actualOK := actualValue.(map[string]any)
		if !expectedOK {
			expectedSettings = nil
		}
		if !actualOK {
			actualSettings = nil
		}
		if composerSettingsEqual(actualSettings, expectedSettings) {
			return ""
		}
		return firstComposerSettingsMismatch(path, expectedSettings, actualSettings)
	}
	if expectedValue == nil || actualValue == nil {
		if expectedValue == nil && actualValue == nil {
			return ""
		}
		return path
	}
	if reflect.TypeOf(expectedValue) != reflect.TypeOf(actualValue) {
		return path
	}
	switch expectedValue := expectedValue.(type) {
	case map[string]any:
		actualValue := actualValue.(map[string]any)
		keys := make([]string, 0, len(expectedValue)+len(actualValue))
		seen := map[string]struct{}{}
		for key := range expectedValue {
			keys = append(keys, key)
			seen[key] = struct{}{}
		}
		for key := range actualValue {
			if _, ok := seen[key]; !ok {
				keys = append(keys, key)
			}
		}
		sort.Strings(keys)
		for _, key := range keys {
			expectedChild, expectedOK := expectedValue[key]
			actualChild, actualOK := actualValue[key]
			if !expectedOK || !actualOK {
				return path + "." + key
			}
			if mismatch := firstReplayStateMismatchComparable(
				path+"."+key,
				expectedChild,
				actualChild,
			); mismatch != "" {
				return mismatch
			}
		}
	case []any:
		actualValue := actualValue.([]any)
		if len(expectedValue) != len(actualValue) {
			return path
		}
		for index := range expectedValue {
			if mismatch := firstReplayStateMismatchComparable(
				fmt.Sprintf("%s[%d]", path, index),
				expectedValue[index],
				actualValue[index],
			); mismatch != "" {
				return mismatch
			}
		}
	default:
		if !reflect.DeepEqual(expectedValue, actualValue) {
			return path
		}
	}
	return ""
}

// isComposerSettingsPath detects Session.settings objects so final-state
// compare can share settings.equal semantics instead of strict key equality.
func isComposerSettingsPath(path string) bool {
	return strings.HasSuffix(path, ".settings") &&
		strings.Contains(path, ".sessions[")
}

// firstComposerSettingsMismatch reports the first recorded composer setting
// that fails the shared empty-default / live-extra contract.
func firstComposerSettingsMismatch(
	path string,
	expected, actual map[string]any,
) string {
	keys := make([]string, 0, len(expected))
	for key := range expected {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		expectedValue := expected[key]
		actualValue, ok := actual[key]
		if !ok {
			if composerSettingsValueEmpty(expectedValue) {
				continue
			}
			return path + "." + key
		}
		if !composerSettingsValueEqual(actualValue, expectedValue) {
			return path + "." + key
		}
	}
	return path
}

func replayComparableValue(value any) any {
	raw, err := json.Marshal(value)
	if err != nil {
		return value
	}
	var decoded any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return value
	}
	return decoded
}
