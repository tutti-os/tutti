package agentruntime

import (
	"context"
	"fmt"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func TestCodexAppServerAdapterExecStreamsTurn(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	events, err := adapter.Exec(context.Background(), session, []PromptContentBlock{{
		Type: "text",
		Text: "inspect the repo",
	}}, "", "turn-local-1", nil, nil)
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}

	turnStart := appServerRequestParams(t, transport.conn, appServerMethodTurnStart)
	if asString(turnStart["threadId"]) != "codex-thread-1" {
		t.Fatalf("turn/start threadId = %q", turnStart["threadId"])
	}
	if asString(turnStart["cwd"]) != "/workspace" {
		t.Fatalf("turn/start cwd = %q, want provider workspace root", turnStart["cwd"])
	}
	input, _ := turnStart["input"].([]any)
	if len(input) != 1 || asString(payloadObject(input[0])["text"]) != "inspect the repo" {
		t.Fatalf("turn/start input = %#v", turnStart["input"])
	}
	if _, ok := turnStart["responsesapiClientMetadata"]; ok {
		t.Fatalf("turn/start responsesapiClientMetadata = %#v, want omitted", turnStart["responsesapiClientMetadata"])
	}

	messages := eventsOfType(events, activityshared.EventMessageAppended)
	var assistantText, thinkingText string
	for _, event := range messages {
		switch event.Payload.Role {
		case activityshared.MessageRoleAssistant:
			assistantText = event.Payload.Content
		case activityshared.MessageRole(RoleAssistantThinking):
			thinkingText = event.Payload.Content
		}
	}
	if assistantText != "I'll check the repo." {
		t.Fatalf("assistant content = %q, want streamed message", assistantText)
	}
	if thinkingText != "Need context." {
		t.Fatalf("thinking content = %q", thinkingText)
	}

	callsStarted := eventsOfType(events, activityshared.EventCallStarted)
	callsCompleted := eventsOfType(events, activityshared.EventCallCompleted)
	if len(callsStarted) == 0 || len(callsCompleted) == 0 {
		t.Fatalf("missing call events: started=%d completed=%d", len(callsStarted), len(callsCompleted))
	}
	var bashCall *activityshared.Event
	for index := range callsCompleted {
		if asString(callsCompleted[index].Payload.Metadata["toolName"]) == "Bash" {
			bashCall = &callsCompleted[index]
		}
	}
	if bashCall == nil {
		t.Fatalf("missing completed Bash tool call: %#v", callsCompleted)
		return
	}
	output := payloadMap(bashCall.Payload.Metadata, "output")
	if stdout, _ := output["stdout"].(string); stdout != "README.md\n" {
		t.Fatalf("bash output = %#v", output)
	}

	var todoCall *activityshared.Event
	for index := range callsCompleted {
		if asString(callsCompleted[index].Payload.Metadata["toolName"]) == "TodoWrite" {
			todoCall = &callsCompleted[index]
		}
	}
	if todoCall == nil {
		t.Fatalf("missing TodoWrite plan call")
	}

	completed := eventsOfType(events, activityshared.EventRootProviderTurnCompleted)
	if len(completed) != 1 {
		t.Fatalf("turn completed events = %d, want 1", len(completed))
	}
	if asString(completed[0].Payload.Metadata["stopReason"]) != "end_turn" {
		t.Fatalf("stopReason = %#v", completed[0].Payload.Metadata)
	}

	var titleEvent bool
	for _, event := range events {
		if event.Type == activityshared.EventSessionUpdated && event.Payload.Title == "Inspect repository structure" {
			titleEvent = true
		}
	}
	if !titleEvent {
		t.Fatalf("missing thread name title event")
	}

	state := adapter.SessionState(session)
	usage, _ := state.RuntimeContext["usage"].(map[string]any)
	contextWindow, _ := usage["contextWindow"].(map[string]any)
	if used, _ := int64Value(contextWindow["usedTokens"]); used != 1000 {
		t.Fatalf("usage usedTokens = %#v, want last.inputTokens (1000)", usage)
	}
	if total, _ := int64Value(contextWindow["totalTokens"]); total != 272000 {
		t.Fatalf("usage totalTokens = %#v", usage)
	}
}

func TestCodexAppServerTurnStartKeepsLargePromptInInputOnly(t *testing.T) {
	t.Parallel()

	longPrompt := strings.Repeat("a", 33*1024)
	params := appServerTurnStartParams(
		Session{},
		"codex-thread-1",
		[]PromptContentBlock{{Type: "text", Text: longPrompt}},
		nil,
		nil,
		"",
		"",
		false,
	)
	if _, ok := params["responsesapiClientMetadata"]; ok {
		t.Fatalf("responsesapiClientMetadata = %#v, want omitted", params["responsesapiClientMetadata"])
	}
	input, ok := params["input"].([]map[string]any)
	if !ok || len(input) != 1 || asString(input[0]["text"]) != longPrompt {
		t.Fatalf("turn/start input did not preserve the full prompt")
	}
}

func TestCodexAppServerTurnStartProjectsProviderWorkspaceCWD(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		roomID string
		cwd    string
		want   string
	}{
		{name: "room mount root", roomID: "room-1", cwd: "/workspace/room-1", want: "/workspace"},
		{name: "room mount child", roomID: "room-1", cwd: "/workspace/room-1/src", want: "/workspace/src"},
		{name: "logical workspace child", roomID: "room-1", cwd: "/workspace/src", want: "/workspace/src"},
		{name: "native Windows path", roomID: "room-1", cwd: `C:\Users\alice\repo`, want: `C:\Users\alice\repo`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			params := appServerTurnStartParams(
				Session{RoomID: test.roomID, CWD: test.cwd},
				"codex-thread-1",
				nil,
				nil,
				nil,
				"",
				"",
				false,
			)
			if got := asString(params["cwd"]); got != test.want {
				t.Fatalf("turn/start cwd = %q, want %q", got, test.want)
			}
		})
	}
}

func TestCodexAppServerAdapterExecRoutesAgentTargetMention(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	prompt := "让 [@Codex](mention://agent-target/local:codex?workspaceId=workspace-1) 来 review"

	events, err := adapter.Exec(context.Background(), session, textPrompt(prompt), "", "turn-agent-target", nil, nil)
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}

	turnStart := appServerRequestParams(t, transport.conn, appServerMethodTurnStart)
	input, _ := turnStart["input"].([]any)
	if len(input) != 2 {
		t.Fatalf("turn/start input = %#v, want user prompt plus internal routing prompt", turnStart["input"])
	}
	first, _ := input[0].(map[string]any)
	if asString(first["text"]) != prompt {
		t.Fatalf("turn/start user text = %q, want %q", asString(first["text"]), prompt)
	}
	last, _ := input[len(input)-1].(map[string]any)
	if asString(last["text"]) != tuttiAgentMentionRoutingReminder {
		t.Fatalf("turn/start routing text = %q, want %q", asString(last["text"]), tuttiAgentMentionRoutingReminder)
	}

	userContent := firstUserMessageContent(t, events)
	if userContent != prompt || strings.Contains(userContent, "system-reminder") {
		t.Fatalf("user activity content = %q, want original prompt only", userContent)
	}
}

func TestCodexAppServerAdapterDoesNotProjectInternalMentionRoutingTitle(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	transport.server.mu.Lock()
	transport.server.threadName = tuttiMentionRoutingReminder
	transport.server.mu.Unlock()

	events, err := adapter.Exec(context.Background(), session, textPrompt("inspect repo"), "", "turn-internal-title", nil, nil)
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}

	for _, event := range events {
		if event.Type == activityshared.EventSessionUpdated && event.Payload.Title == tuttiMentionRoutingReminder {
			t.Fatalf("events = %#v, want internal mention routing title excluded from title updates", events)
		}
	}
}

func TestCodexAppServerAdapterExecIgnoresForeignThreadNotifications(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	transport.server.foreignThreadNoise = true
	events, err := adapter.Exec(context.Background(), session, []PromptContentBlock{{
		Type: "text",
		Text: "spawn subagents",
	}}, "", "turn-local-1", nil, nil)
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}

	var assistantText string
	for _, event := range eventsOfType(events, activityshared.EventMessageAppended) {
		if event.Payload.Role == activityshared.MessageRoleAssistant {
			assistantText = event.Payload.Content
		}
	}
	if assistantText != "I'll check the repo." {
		t.Fatalf("assistant content = %q, want parent thread message", assistantText)
	}
	if strings.Contains(fmt.Sprintf("%#v", events), `{"n":7}`) {
		t.Fatalf("foreign thread payload leaked into parent events: %#v", events)
	}
}

func TestCodexAppServerAdapterExecSendsTurnOverrides(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	session.PermissionModeID = "full-access"
	session.Settings = &SessionSettings{
		Model:            "gpt-5.6-sol",
		ReasoningEffort:  "ultra",
		PermissionModeID: "full-access",
	}
	if _, err := adapter.Exec(context.Background(), session, []PromptContentBlock{{
		Type: "text", Text: "go",
	}}, "", "turn-local-1", nil, nil); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	turnStart := appServerRequestParams(t, transport.conn, appServerMethodTurnStart)
	if asString(turnStart["model"]) != "gpt-5.6-sol" {
		t.Fatalf("turn/start model = %q", turnStart["model"])
	}
	if asString(turnStart["effort"]) != "ultra" {
		t.Fatalf("turn/start effort = %q", turnStart["effort"])
	}
	if asString(turnStart["approvalPolicy"]) != "never" {
		t.Fatalf("turn/start approvalPolicy = %q, want never", turnStart["approvalPolicy"])
	}
	sandboxPolicy, _ := turnStart["sandboxPolicy"].(map[string]any)
	if asString(sandboxPolicy["type"]) != "dangerFullAccess" {
		t.Fatalf("turn/start sandboxPolicy = %#v", turnStart["sandboxPolicy"])
	}
	if _, ok := turnStart["approvalsReviewer"]; ok {
		t.Fatalf("turn/start approvalsReviewer = %#v, want omitted for full-access", turnStart["approvalsReviewer"])
	}
}

func TestCodexAppServerAdapterExecReadOnlyPermissionUsesUserReviewer(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	session.PermissionModeID = "read-only"
	session.Settings = &SessionSettings{
		PermissionModeID: "read-only",
	}
	if _, err := adapter.Exec(context.Background(), session, []PromptContentBlock{{
		Type: "text", Text: "go",
	}}, "", "turn-local-1", nil, nil); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	turnStart := appServerRequestParams(t, transport.conn, appServerMethodTurnStart)
	if asString(turnStart["approvalPolicy"]) != "on-request" {
		t.Fatalf("turn/start approvalPolicy = %q, want on-request", turnStart["approvalPolicy"])
	}
	sandboxPolicy, _ := turnStart["sandboxPolicy"].(map[string]any)
	if asString(sandboxPolicy["type"]) != "readOnly" {
		t.Fatalf("turn/start sandboxPolicy = %#v", turnStart["sandboxPolicy"])
	}
	if asString(turnStart["approvalsReviewer"]) != "user" {
		t.Fatalf("turn/start approvalsReviewer = %q, want user", turnStart["approvalsReviewer"])
	}
}

func TestCodexAppServerAdapterExecAutoPermissionUsesAutoReviewer(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	session.PermissionModeID = "auto"
	session.Settings = &SessionSettings{
		PermissionModeID: "auto",
	}
	if _, err := adapter.Exec(context.Background(), session, []PromptContentBlock{{
		Type: "text", Text: "go",
	}}, "", "turn-local-1", nil, nil); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	turnStart := appServerRequestParams(t, transport.conn, appServerMethodTurnStart)
	if asString(turnStart["approvalPolicy"]) != "on-request" {
		t.Fatalf("turn/start approvalPolicy = %q, want on-request", turnStart["approvalPolicy"])
	}
	sandboxPolicy, _ := turnStart["sandboxPolicy"].(map[string]any)
	if asString(sandboxPolicy["type"]) != "workspaceWrite" {
		t.Fatalf("turn/start sandboxPolicy = %#v", turnStart["sandboxPolicy"])
	}
	if runtime.GOOS == "windows" {
		if _, ok := sandboxPolicy["writableRoots"]; ok {
			t.Fatalf("turn/start sandboxPolicy writableRoots = %#v, want omitted on Windows", sandboxPolicy["writableRoots"])
		}
	} else {
		writableRoots, ok := sandboxPolicy["writableRoots"].([]any)
		if !ok || len(writableRoots) != 1 || asString(writableRoots[0]) != "/sandbox-tmp" {
			t.Fatalf("turn/start sandboxPolicy writableRoots = %#v, want [/sandbox-tmp]", sandboxPolicy["writableRoots"])
		}
	}
	if asString(turnStart["approvalsReviewer"]) != "auto_review" {
		t.Fatalf("turn/start approvalsReviewer = %q, want auto_review", turnStart["approvalsReviewer"])
	}
}

func TestCodexAppServerSandboxPolicyKeepsHostPathSemantics(t *testing.T) {
	t.Parallel()

	windowsPolicy := codexAppServerSandboxPolicyForPlatform("auto", false, "windows")
	if _, ok := windowsPolicy["writableRoots"]; ok {
		t.Fatalf("Windows writableRoots = %#v, want omitted", windowsPolicy["writableRoots"])
	}

	posixPolicy := codexAppServerSandboxPolicyForPlatform("auto", false, "darwin")
	writableRoots, ok := posixPolicy["writableRoots"].([]string)
	if !ok || len(writableRoots) != 1 || writableRoots[0] != "/sandbox-tmp" {
		t.Fatalf("POSIX writableRoots = %#v, want [/sandbox-tmp]", posixPolicy["writableRoots"])
	}
}

func TestCodexAppServerAdapterExecImagePrompt(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	if err := adapter.ValidatePromptContent(session, []PromptContentBlock{{
		Type: "image", MimeType: "image/png", Path: "/managed/agent-prompt-assets/screen.png",
	}}); err != nil {
		t.Fatalf("ValidatePromptContent path-backed image: %v", err)
	}
	if err := adapter.ValidatePromptContent(session, []PromptContentBlock{{Type: "image", MimeType: "image/png", Data: "aGk="}}); err != nil {
		t.Fatalf("ValidatePromptContent: %v", err)
	}
	if _, err := adapter.Exec(context.Background(), session, []PromptContentBlock{
		{Type: "text", Text: "look at this"},
		{Type: "image", MimeType: "image/png", Data: "aGk="},
	}, "", "turn-local-1", nil, nil); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	turnStart := appServerRequestParams(t, transport.conn, appServerMethodTurnStart)
	input, _ := turnStart["input"].([]any)
	if len(input) != 2 {
		t.Fatalf("turn/start input = %#v, want text+image", turnStart["input"])
	}
	image := payloadObject(input[1])
	if asString(image["type"]) != "image" || asString(image["url"]) != "data:image/png;base64,aGk=" {
		t.Fatalf("image input = %#v", image)
	}
}

func TestCodexAppServerAdapterExecMaterializesRemoteImageAtProviderBoundary(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	imageURL, materializer := testRemotePromptImageMaterializer(t)
	adapter.promptImageMaterializer = materializer

	if _, err := adapter.Exec(context.Background(), session, []PromptContentBlock{
		{Type: "text", Text: "look at this"},
		{Type: "image", MimeType: "image/png", URL: imageURL},
	}, "", "turn-remote-image", nil, nil); err != nil {
		t.Fatalf("Exec: %v", err)
	}

	turnStart := appServerRequestParams(t, transport.conn, appServerMethodTurnStart)
	input, _ := turnStart["input"].([]any)
	if len(input) != 2 {
		t.Fatalf("turn/start input = %#v, want text+image", turnStart["input"])
	}
	image := payloadObject(input[1])
	if got := asString(image["url"]); got != "data:image/png;base64,aGk=" {
		t.Fatalf("turn/start image URL = %q, want inline data URL", got)
	}
}

func TestCodexAppServerAdapterExecTurnFailed(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	transport.server.turnStatus = "failed"
	transport.server.turnError = map[string]any{"message": "model is overloaded"}

	events, err := adapter.Exec(context.Background(), session, []PromptContentBlock{{
		Type: "text", Text: "go",
	}}, "", "turn-local-1", nil, nil)
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	failed := eventsOfType(events, activityshared.EventRootProviderTurnCompleted)
	if len(failed) != 1 || failed[0].Payload.TurnOutcome != string(activityshared.TurnOutcomeFailed) {
		t.Fatalf("root provider failed events = %#v, want one failed outcome", failed)
	}
	if asString(failed[0].Payload.Metadata["error"]) != "model is overloaded" {
		t.Fatalf("failed metadata = %#v", failed[0].Payload.Metadata)
	}
}

func TestCodexAppServerAdapterExecTurnInterrupted(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	transport.server.turnStatus = "interrupted"

	events, err := adapter.Exec(context.Background(), session, []PromptContentBlock{{
		Type: "text", Text: "go",
	}}, "", "turn-local-1", nil, nil)
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	if completed := eventsOfType(events, activityshared.EventRootProviderTurnCompleted); len(completed) != 1 {
		t.Fatalf("turn completed events = %d, want 1 (interrupted outcome)", len(completed))
	} else if completed[0].Payload.TurnOutcome != string(activityshared.TurnOutcomeCanceled) {
		t.Fatalf("turn outcome = %q, want canceled", completed[0].Payload.TurnOutcome)
	}
}

func TestCodexAppServerAdapterFetchesChildThreadNickname(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	transport.server.mu.Lock()
	transport.server.childNicknames = map[string]string{"child-thread-1": "Euclid"}
	transport.server.mu.Unlock()
	var mu sync.Mutex
	var markers []activityshared.Event
	adapter.SetSessionEventSink(func(_ string, events []activityshared.Event) {
		mu.Lock()
		defer mu.Unlock()
		markers = append(markers, events...)
	})
	appTurn := &codexAppServerActiveTurn{}
	if !adapter.beginActiveTurn(session.AgentSessionID, appTurn) {
		t.Fatal("beginActiveTurn failed")
	}
	defer adapter.endActiveTurn(session.AgentSessionID, appTurn)
	adapter.setSessionActiveTurnID(session.AgentSessionID, appTurn, "turn-1")

	// Registering a child (parent collab item/started) must trigger an async
	// thread/read: codex assigns spawned agents an agentNickname on the Thread
	// object but never pushes it (no thread/name/updated for children).
	reducer := newCodexAppServerReducer(adapter)
	reducer.ReduceNotification(nil, session, "turn-1", acpMessage{
		Method: appServerNotifyItemStarted,
		Params: mustJSONRawMessage(t, map[string]any{
			"threadId": session.ProviderSessionID,
			"turnId":   "turn-1",
			"item": map[string]any{
				"type":              "collabAgentToolCall",
				"id":                "spawn-child-1",
				"tool":              "spawnAgent",
				"status":            "inProgress",
				"receiverThreadIds": []any{"child-thread-1"},
			},
		}),
	}, newACPTurnNormalizer(), nil)

	waitForCondition(t, func() bool {
		mu.Lock()
		defer mu.Unlock()
		for _, event := range markers {
			if event.Type == activityshared.EventSessionUpdated &&
				event.Payload.Title == "Euclid" &&
				event.SessionKind == "child" &&
				event.ParentToolCallID == "spawn-child-1" &&
				event.ProviderSessionID == "child-thread-1" {
				return true
			}
		}
		return false
	})
}

// Pins the terminal contract the settle-path inversion must preserve: a
// normal turn emits exactly one turn-outcome event, delivered through the
// emit sink before Exec returns.
func TestCodexAppServerAdapterEmitsExactlyOneTurnOutcome(t *testing.T) {
	t.Parallel()

	adapter, _, session := startedAppServerAdapter(t)
	var mu sync.Mutex
	var streamed []activityshared.Event
	events, err := adapter.Exec(context.Background(), session, []PromptContentBlock{{
		Type: "text",
		Text: "inspect the repo",
	}}, "", "turn-local-1", func(next []activityshared.Event) {
		mu.Lock()
		defer mu.Unlock()
		streamed = append(streamed, next...)
	}, nil)
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	countOutcomes := func(list []activityshared.Event) int {
		count := 0
		for _, event := range list {
			if event.Type == activityshared.EventRootProviderTurnCompleted {
				count++
			}
		}
		return count
	}
	if got := countOutcomes(events); got != 1 {
		t.Fatalf("returned turn outcome events = %d, want exactly 1", got)
	}
	mu.Lock()
	defer mu.Unlock()
	if got := countOutcomes(streamed); got != 1 {
		t.Fatalf("streamed turn outcome events = %d, want exactly 1", got)
	}
}

// Pins the client-death terminal transition: when the app-server connection
// dies mid-turn, the turn settles as failed instead of hanging.
func TestCodexAppServerAdapterExecSteeredTurnSettlesOnRunningTurnCompletion(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	transport.server.steeredTurnStart = true

	execDone := make(chan []activityshared.Event, 1)
	go func() {
		events, _ := adapter.Exec(context.Background(), session, []PromptContentBlock{{
			Type: "text", Text: "stop refactoring, just report",
		}}, "", "turn-local-2", nil, nil)
		execDone <- events
	}()
	// The steered turn/start result binds the session to the steer stub id.
	waitForCondition(t, func() bool {
		return adapter.sessionActiveTurnID(session.AgentSessionID) == "turn-steer-stub"
	})

	// The running turn ("turn-1") absorbed the steered input and completes;
	// no other terminal notification will ever arrive for the stub turn.
	transport.server.completePendingTurn()

	select {
	case events := <-execDone:
		completed := eventsOfType(events, activityshared.EventRootProviderTurnCompleted)
		if len(completed) != 1 {
			t.Fatalf("root provider terminal outcomes = %d, want exactly one", len(completed))
		}
		if completed[0].Payload.TurnOutcome != string(activityshared.TurnOutcomeCompleted) {
			t.Fatalf("steered provider turn settled as %#v, want completed outcome", completed[0])
		}
	case <-time.After(5 * time.Second):
		t.Fatalf("Exec never settled: turn/completed for the running turn was dropped by the provider-turn-id guard")
	}
}

func TestCodexAppServerAdapterQueuedSteerKeepsApprovalAlive(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	transport.server.steeredTurnStart = true
	transport.server.commandApproval = true

	execDone := make(chan []activityshared.Event, 1)
	go func() {
		events, _ := adapter.Exec(
			context.Background(),
			session,
			textPrompt("change direction"),
			"",
			"turn-local-2",
			func([]activityshared.Event) {},
			nil,
		)
		execDone <- events
	}()

	waitForCondition(t, func() bool {
		return adapter.getPendingRequest(session.AgentSessionID, "turn-local-2", "approval-1") != nil
	})
	result, err := adapter.SubmitInteractive(context.Background(), session, SubmitInteractiveInput{
		TurnID:    "turn-local-2",
		RequestID: "approval-1",
		OptionID:  "approve",
	})
	if err != nil {
		t.Fatalf("SubmitInteractive: %v", err)
	}
	if !result.Accepted || result.Disposition != InteractiveDispositionAnswered {
		t.Fatalf("submit result = %#v, want answered approval", result)
	}

	select {
	case events := <-execDone:
		completed := eventsOfType(events, activityshared.EventRootProviderTurnCompleted)
		if len(completed) != 1 ||
			completed[0].Payload.TurnOutcome != string(activityshared.TurnOutcomeCompleted) {
			t.Fatalf("queued steer terminal events = %#v, want one completed outcome", events)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("queued steer did not settle after its approval response")
	}
}

func TestCodexAppServerAdapterDropsEmptyTerminalIDForBoundActiveTurn(t *testing.T) {
	t.Parallel()

	adapter, _, session := startedAppServerAdapter(t)
	appTurn := &codexAppServerActiveTurn{
		turnID:     "turn-local-1",
		session:    session,
		normalizer: newACPTurnNormalizer(),
		phase:      codexAppServerTurnPhaseRunning,
		terminal:   make(chan codexAppServerTurnTerminal, 1),
		terminated: make(chan struct{}),
	}
	if !adapter.beginActiveTurn(session.AgentSessionID, appTurn) {
		t.Fatal("beginActiveTurn failed")
	}
	adapter.setSessionActiveTurnID(session.AgentSessionID, appTurn, "turn-real")
	adapter.confirmSessionActiveTurnStarted(session.AgentSessionID, "turn-real")

	adapter.completeActiveTurn(session.AgentSessionID, map[string]any{"status": "completed"})

	if got := adapter.sessionActiveTurnID(session.AgentSessionID); got != "turn-real" {
		t.Fatalf("active turn id = %q, want turn-real after empty terminal id", got)
	}
	if active := adapter.sessionActiveTurn(session.AgentSessionID); active != appTurn {
		t.Fatalf("active turn = %#v, want original appTurn", active)
	}
	select {
	case terminal := <-appTurn.terminal:
		t.Fatalf("empty terminal id delivered terminal %#v, want drop", terminal)
	default:
	}
}

func TestCodexAppServerAdapterDropsEmptyTerminalIDForUnconfirmedActiveTurn(t *testing.T) {
	t.Parallel()

	adapter, _, session := startedAppServerAdapter(t)
	appTurn := &codexAppServerActiveTurn{
		turnID:     "turn-local-1",
		session:    session,
		normalizer: newACPTurnNormalizer(),
		phase:      codexAppServerTurnPhaseRunning,
		terminal:   make(chan codexAppServerTurnTerminal, 1),
		terminated: make(chan struct{}),
	}
	if !adapter.beginActiveTurn(session.AgentSessionID, appTurn) {
		t.Fatal("beginActiveTurn failed")
	}
	adapter.setSessionActiveTurnID(session.AgentSessionID, appTurn, "turn-steer-stub")

	adapter.completeActiveTurn(session.AgentSessionID, map[string]any{"status": "completed"})

	if got := adapter.sessionActiveTurnID(session.AgentSessionID); got != "turn-steer-stub" {
		t.Fatalf("active turn id = %q, want turn-steer-stub after empty terminal id", got)
	}
	if active := adapter.sessionActiveTurn(session.AgentSessionID); active != appTurn {
		t.Fatalf("active turn = %#v, want original appTurn", active)
	}
	select {
	case terminal := <-appTurn.terminal:
		t.Fatalf("empty terminal id delivered terminal %#v, want drop", terminal)
	default:
	}
}

func TestCodexAppServerAdapterConfirmActiveTurnStartedScopedToBoundID(t *testing.T) {
	t.Parallel()

	adapter, _, session := startedAppServerAdapter(t)
	appTurn := &codexAppServerActiveTurn{}
	if !adapter.beginActiveTurn(session.AgentSessionID, appTurn) {
		t.Fatal("beginActiveTurn failed")
	}
	defer adapter.endActiveTurn(session.AgentSessionID, appTurn)
	adapter.setSessionActiveTurnID(session.AgentSessionID, appTurn, "turn-bound")

	// A turn/started for a different turn (e.g. racing with a steered
	// turn/start rebinding the id in between) must not confirm the current
	// binding — a stub confirmed by mistake would re-wedge the settle path.
	adapter.confirmSessionActiveTurnStarted(session.AgentSessionID, "turn-other")
	if adapter.sessionActiveTurnStartConfirmed(session.AgentSessionID) {
		t.Fatalf("confirmation with a stale provider turn id must not confirm the bound id")
	}

	adapter.confirmSessionActiveTurnStarted(session.AgentSessionID, "turn-bound")
	if !adapter.sessionActiveTurnStartConfirmed(session.AgentSessionID) {
		t.Fatalf("confirmation with the bound provider turn id should confirm")
	}
}

func TestCodexAppServerAdapterClientDeathSettlesTurn(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	transport.server.holdTurn = true

	execDone := make(chan []activityshared.Event, 1)
	go func() {
		events, _ := adapter.Exec(context.Background(), session, []PromptContentBlock{{
			Type: "text", Text: "long task",
		}}, "", "turn-local-1", nil, nil)
		execDone <- events
	}()
	waitForCondition(t, func() bool {
		return adapter.sessionActiveTurnID(session.AgentSessionID) == "turn-1"
	})

	_ = transport.conn.Close()

	select {
	case events := <-execDone:
		outcomes := 0
		for _, event := range events {
			if event.Type == activityshared.EventRootProviderTurnCompleted &&
				event.Payload.TurnOutcome == string(activityshared.TurnOutcomeFailed) {
				outcomes++
			}
		}
		if outcomes != 1 {
			t.Fatalf("turn outcome after client death = %#v, want one failed root provider outcome", events)
		}
	case <-time.After(5 * time.Second):
		t.Fatalf("Exec did not settle after client death")
	}
}
