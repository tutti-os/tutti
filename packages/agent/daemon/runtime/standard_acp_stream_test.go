package agentruntime

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func TestStandardACPAdvertisesAndRecordsWriteTextFile(t *testing.T) {
	t.Parallel()

	capabilities := payloadObject(defaultACPInitializeParams(LegacyHostMetadata())["clientCapabilities"])
	filesystem := payloadObject(capabilities["fs"])
	if filesystem["writeTextFile"] != true || filesystem["readTextFile"] != false {
		t.Fatalf("filesystem capabilities = %#v, want write enabled and read disabled", filesystem)
	}

	path := filepath.Join(t.TempDir(), "report.md")
	if err := os.WriteFile(path, []byte("before\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	var response acpMessage
	client := &acpClient{conn: acpClientTestConnection{send: func(data []byte) error {
		return json.Unmarshal(data, &response)
	}}}
	params, err := json.Marshal(acpWriteTextFileParams{
		SessionID: "agent-session-1",
		Path:      path,
		Content:   "after\nmore\n",
	})
	if err != nil {
		t.Fatal(err)
	}

	events, err := (&standardACPAdapter{}).handleACPMessage(
		context.Background(),
		client,
		standardTestSession(ProviderOpenCode),
		"turn-1",
		acpMessage{ID: json.RawMessage(`1`), Method: acpMethodWriteTextFile, Params: params},
		newACPTurnNormalizer(),
		nil,
		nil,
	)
	if err != nil {
		t.Fatalf("write text file: %v", err)
	}
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := string(content); got != "after\nmore\n" {
		t.Fatalf("file content = %q, want replacement content", got)
	}
	if response.Error != nil {
		t.Fatalf("response error = %#v, want success", response.Error)
	}
	if len(events) != 1 || events[0].Type != activityshared.EventTurnUpdated {
		t.Fatalf("events = %#v, want one turn update", events)
	}
	files := payloadArray(payloadMap(events[0].Payload.Metadata, "fileChanges")["files"])
	if len(files) != 1 || files[0]["change"] != "modified" ||
		files[0]["oldString"] != "before\n" || files[0]["newString"] != "after\nmore\n" {
		t.Fatalf("file changes = %#v, want exact before and after content", files)
	}
}

func TestStandardACPWriteSnapshotSurvivesPartialToolCompletion(t *testing.T) {
	t.Parallel()

	path := filepath.Join(t.TempDir(), "report.md")
	before := "alpha\nbravo\ncharlie\ndelta\n"
	after := "first\nsecond\n" + before
	if err := os.WriteFile(path, []byte(before), 0o600); err != nil {
		t.Fatal(err)
	}
	client := &acpClient{conn: acpClientTestConnection{send: func([]byte) error { return nil }}}
	session := standardTestSession(ProviderOpenCode)
	normalizer := newACPTurnNormalizer()
	params, err := json.Marshal(acpWriteTextFileParams{
		SessionID: session.ProviderSessionID,
		Path:      path,
		Content:   after,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := (&standardACPAdapter{}).handleACPMessage(
		context.Background(),
		client,
		session,
		"turn-1",
		acpMessage{ID: json.RawMessage(`1`), Method: acpMethodWriteTextFile, Params: params},
		normalizer,
		nil,
		nil,
	); err != nil {
		t.Fatalf("write text file: %v", err)
	}

	completed := standardACPUpdateEvents(
		standardACPConfig{provider: ProviderOpenCode},
		session,
		"turn-1",
		json.RawMessage(fmt.Sprintf(`{
			"update": {
				"sessionUpdate": "tool_call_update",
				"toolCallId": "edit-1",
				"title": "Edit report.md",
				"status": "completed",
				"kind": "edit",
				"content": [{
					"type": "diff",
					"path": %q,
					"oldText": %q,
					"newText": %q
				}]
			}
		}`, path, before, "first\nsecond\nalpha\nbravo\n")),
		normalizer,
	)
	if len(completed) != 2 || completed[1].Type != activityshared.EventTurnUpdated {
		t.Fatalf("completed events = %#v, want call.completed followed by turn.updated", completed)
	}
	files := payloadArray(payloadMap(completed[1].Payload.Metadata, "fileChanges")["files"])
	if len(files) != 1 || files[0]["oldString"] != before || files[0]["newString"] != after {
		t.Fatalf("file changes = %#v, want host-observed complete before and after snapshots", files)
	}
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != after {
		t.Fatalf("file content = %q, want %q", content, after)
	}
}

func TestStandardACPWriteTextFileRejectsRelativePath(t *testing.T) {
	t.Parallel()

	var response acpMessage
	client := &acpClient{conn: acpClientTestConnection{send: func(data []byte) error {
		return json.Unmarshal(data, &response)
	}}}
	params, err := json.Marshal(acpWriteTextFileParams{
		SessionID: "agent-session-1",
		Path:      "report.md",
		Content:   "unexpected",
	})
	if err != nil {
		t.Fatal(err)
	}
	events, err := (&standardACPAdapter{}).handleACPMessage(
		context.Background(),
		client,
		standardTestSession(ProviderOpenCode),
		"turn-1",
		acpMessage{ID: json.RawMessage(`1`), Method: acpMethodWriteTextFile, Params: params},
		newACPTurnNormalizer(),
		nil,
		nil,
	)
	if err != nil {
		t.Fatalf("reject relative path: %v", err)
	}
	if len(events) != 0 {
		t.Fatalf("events = %#v, want none", events)
	}
	if response.Error == nil || response.Error.Code != -32602 {
		t.Fatalf("response error = %#v, want invalid params", response.Error)
	}
}

func TestStandardACPConfigOptionUpdateSignalsSessionStateReload(t *testing.T) {
	t.Parallel()

	session := standardTestSession(ProviderOpenCode)
	session.ProviderSessionID = "opencode-session-1"

	events := standardACPUpdateEvents(standardACPConfig{provider: ProviderOpenCode}, session, "turn-1", json.RawMessage(`{
		"update": {
			"sessionUpdate": "config_option_update",
			"key": "model",
			"value": "opus"
		}
	}`), newACPTurnNormalizer())

	if len(events) != 1 {
		t.Fatalf("events = %#v, want one session update signal", events)
	}
	if events[0].Type != activityshared.EventSessionUpdated {
		t.Fatalf("event type = %q, want session updated", events[0].Type)
	}
	if got := events[0].Payload.Metadata["sessionUpdateKind"]; got != "config_option_update" {
		t.Fatalf("metadata sessionUpdateKind = %#v, want config_option_update", got)
	}
	if got := events[0].Payload.Metadata["configOptionKey"]; got != "model" {
		t.Fatalf("metadata configOptionKey = %#v, want model", got)
	}
}

func TestStandardACPIgnoresForeignProviderSessionUpdateDuringTurn(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("OpenCode", "opencode-session-current")
	adapter := newOpenCodeTestAdapter(transport)
	session := standardTestSession(ProviderOpenCode)
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	session.ProviderSessionID = "opencode-session-current"

	var commandSnapshots []AgentSessionCommandSnapshot
	var emittedEvents [][]activityshared.Event
	var configUpdates []AgentSessionConfigOptionsUpdate
	adapter.SetCommandSnapshotSink(func(snapshot AgentSessionCommandSnapshot) {
		commandSnapshots = append(commandSnapshots, snapshot)
	})
	adapter.SetSessionEventSink(func(_ string, events []activityshared.Event) {
		emittedEvents = append(emittedEvents, events)
	})
	adapter.SetConfigOptionsUpdateSink(func(update AgentSessionConfigOptionsUpdate) {
		configUpdates = append(configUpdates, update)
	})

	events, err := adapter.handleACPMessage(context.Background(), nil, session, "turn-foreign", acpMessage{
		Method: acpMethodUpdate,
		Params: json.RawMessage(`{
			"sessionId": "opencode-session-foreign",
			"update": {
				"sessionUpdate": "session_info_update",
				"title": "Foreign title"
			}
		}`),
	}, newACPTurnNormalizer(), nil, nil)
	if err != nil {
		t.Fatalf("handle foreign title update: %v", err)
	}
	if len(events) != 0 || len(emittedEvents) != 0 {
		t.Fatalf("foreign title events = %#v emitted=%#v, want none", events, emittedEvents)
	}

	if _, err := adapter.handleACPMessage(context.Background(), nil, session, "turn-foreign", acpMessage{
		Method: acpMethodUpdate,
		Params: json.RawMessage(`{
			"sessionId": "opencode-session-foreign",
			"update": {
				"sessionUpdate": "available_commands_update",
				"availableCommands": [{
					"name": "foreign-web",
					"description": "Foreign command"
				}]
			}
		}`),
	}, newACPTurnNormalizer(), nil, nil); err != nil {
		t.Fatalf("handle foreign command update: %v", err)
	}
	if _, err := adapter.handleACPMessage(context.Background(), nil, session, "turn-foreign", acpMessage{
		Method: acpMethodUpdate,
		Params: json.RawMessage(`{
			"sessionId": "opencode-session-foreign",
			"update": {
				"sessionUpdate": "config_option_update",
				"key": "model",
				"value": "foreign-model"
			}
		}`),
	}, newACPTurnNormalizer(), nil, nil); err != nil {
		t.Fatalf("handle foreign config update: %v", err)
	}
	if len(commandSnapshots) != 0 {
		t.Fatalf("foreign command snapshots = %#v, want none", commandSnapshots)
	}
	if len(configUpdates) != 0 {
		t.Fatalf("foreign config updates = %#v, want none", configUpdates)
	}

	snapshot, ok := adapter.SessionCommandSnapshot(session)
	if ok {
		if names := agentSessionCommandNames(snapshot.Commands); containsString(names, "foreign-web") {
			t.Fatalf("command names = %#v, want foreign command filtered", names)
		}
	}
	state := adapter.SessionState(session)
	config := payloadObject(state.RuntimeContext["config"])
	if got := asString(config["model"]); got == "foreign-model" {
		t.Fatalf("runtime config model = %q, want foreign config filtered", got)
	}
}

func TestStandardACPAcceptsMatchingProviderSessionUpdate(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("OpenCode", "opencode-session-current")
	adapter := newOpenCodeTestAdapter(transport)
	session := standardTestSession(ProviderOpenCode)
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	session.ProviderSessionID = "opencode-session-current"

	events, err := adapter.handleACPMessage(context.Background(), nil, session, "turn-current", acpMessage{
		Method: acpMethodUpdate,
		Params: json.RawMessage(`{
			"sessionId": "opencode-session-current",
			"update": {
				"sessionUpdate": "session_info_update",
				"title": "Current title"
			}
		}`),
	}, newACPTurnNormalizer(), nil, nil)
	if err != nil {
		t.Fatalf("handle matching update: %v", err)
	}
	if len(events) != 1 || events[0].Type != activityshared.EventSessionUpdated {
		t.Fatalf("events = %#v, want matching session update projected", events)
	}
	if got := events[0].Payload.Title; got != "Current title" {
		t.Fatalf("title = %q, want Current title", got)
	}
}
