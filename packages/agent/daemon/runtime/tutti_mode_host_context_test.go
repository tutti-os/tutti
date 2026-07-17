package agentruntime

import (
	"context"
	"strings"
	"testing"
	"time"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func testActiveTuttiModeSnapshot() *TuttiModeTurnSnapshot {
	return &TuttiModeTurnSnapshot{
		ActivationID:           "activation-1",
		RevisionID:             "revision-7",
		Revision:               7,
		State:                  TuttiModeStateActive,
		Source:                 "slash_command",
		OrchestrationIntensity: 80,
	}
}

func TestRenderTuttiModeHostContextCarriesOrchestrationIntensity(t *testing.T) {
	t.Parallel()
	contextText := renderTuttiModeHostContextForCLI(testActiveTuttiModeSnapshot(), "tutti")
	for _, expected := range []string{
		`"orchestrationIntensity":80`,
		"drives both decomposition and model choice",
		"`tutti plan propose` shell command",
		"Scale both the task count and the model tier with the intensity",
	} {
		if !strings.Contains(contextText, expected) {
			t.Fatalf("host context = %q, want %q", contextText, expected)
		}
	}
}

func TestRenderTuttiModeHostContextCarriesWorkedWorkflowExamples(t *testing.T) {
	t.Parallel()
	contextText := renderTuttiModeHostContextForCLI(testActiveTuttiModeSnapshot(), "tutti")
	for _, expected := range []string{
		"every plan command below is a shell command, not a built-in tool",
		"update_plan, TodoWrite, plan mode",
		"tutti agent list --json",
		"tutti agent composer-options --agent-id <agent-id> --json",
		"tutti plan propose --file /abs/path/plan.md --request-id plan-faq-v1",
		"complete launch configuration: agentTargetId, model, and permissionModeId",
		"never invent these ids",
		"semantic is \"full-access\" (codex: full-access, claude-code: bypassPermissions)",
		"the user approves once at plan review",
		"Always set execution.reasoningIntensity explicitly",
		"schema: tutti-mode-plan/v1",
		"topicId: default",
		"reasoningIntensity: 60",
		"dependsOn: [task-1]",
		"permissionModeId: bypassPermissions",
		"parallelizable: true",
		"set `parallelizable: true` on a task that can safely run alongside",
		"end the turn as soon as propose returns a workflowId",
		"`tutti plan revise --workflow-id <workflowId> --file <absolute path> --request-id <new id>`",
		"`tutti issue topic list --json`",
		"a plan that was only shown in chat was never submitted",
	} {
		if !strings.Contains(contextText, expected) {
			t.Fatalf("host context = %q, want %q", contextText, expected)
		}
	}
	for _, forbidden := range []string{"plan wait", "plan-wait"} {
		if strings.Contains(contextText, forbidden) {
			t.Fatalf("host context = %q, must not instruct a wait command (%q)", contextText, forbidden)
		}
	}
}

func TestRenderTuttiModeHostContextUsesResolvedCLICommandName(t *testing.T) {
	t.Parallel()
	contextText := renderTuttiModeHostContextForCLI(testActiveTuttiModeSnapshot(), "tutti-dev")
	for _, expected := range []string{
		"`tutti-dev plan propose` shell command",
		"tutti-dev plan propose --file /abs/path/plan.md",
		"`tutti-dev plan revise --workflow-id",
	} {
		if !strings.Contains(contextText, expected) {
			t.Fatalf("host context = %q, want %q", contextText, expected)
		}
	}
	if strings.Contains(contextText, "`tutti plan propose`") {
		t.Fatalf("host context = %q, must not fall back to the production CLI name", contextText)
	}
}

func TestTuttiCLICommandNameFollowsEnvironment(t *testing.T) {
	t.Setenv("TUTTI_ENV", "")
	if got := tuttiCLICommandName(); got != "tutti" {
		t.Fatalf("cli command name = %q, want tutti", got)
	}
	t.Setenv("TUTTI_ENV", "dev")
	if got := tuttiCLICommandName(); got != "tutti-dev" {
		t.Fatalf("cli command name = %q, want tutti-dev", got)
	}
}

func TestRenderTuttiModeHostContextRejectsOutOfRangeOrchestrationIntensity(t *testing.T) {
	t.Parallel()
	snapshot := testActiveTuttiModeSnapshot()
	snapshot.OrchestrationIntensity = 101
	if got := renderTuttiModeHostContext(snapshot); got != "" {
		t.Fatalf("host context = %q, want empty for out-of-range intensity", got)
	}
}

func TestRenderTuttiModeHostContextCarriesTypedActiveState(t *testing.T) {
	t.Parallel()
	contextText := renderTuttiModeHostContextForCLI(testActiveTuttiModeSnapshot(), "tutti")
	for _, expected := range []string{
		"<tutti-host-context",
		`"activationId":"activation-1"`,
		`"revisionId":"revision-7"`,
		`"revision":7`,
		`"state":"active"`,
		"Do not execute the user's request directly in this turn.",
		"ask the user focused clarifying questions",
		"`tutti plan propose` shell command",
		"end the turn immediately",
		"review decision always arrives as a new user message",
		"Read-only investigation",
		"do not substitute a provider-native planning mode",
		"independent of the provider collaboration mode",
		"Tutti CLI capabilities remain available",
	} {
		if !strings.Contains(contextText, expected) {
			t.Fatalf("host context = %q, want %q", contextText, expected)
		}
	}
	for _, forbidden := range []string{
		"expresses a user preference",
		"not a permission or capability gate",
	} {
		if strings.Contains(contextText, forbidden) {
			t.Fatalf("host context = %q, must not contain retired advisory wording %q", contextText, forbidden)
		}
	}
}

func TestRenderTuttiModeHostContextRejectsUnknownState(t *testing.T) {
	t.Parallel()
	snapshot := testActiveTuttiModeSnapshot()
	snapshot.State = "maybe"
	if got := renderTuttiModeHostContext(snapshot); got != "" {
		t.Fatalf("host context = %q, want empty for unknown state", got)
	}
}

func TestRenderTuttiModeHostContextCarriesExplicitInactiveState(t *testing.T) {
	t.Parallel()
	snapshot := testActiveTuttiModeSnapshot()
	snapshot.State = TuttiModeStateInactive
	snapshot.RevisionID = "revision-8"
	snapshot.Revision = 8
	contextText := renderTuttiModeHostContext(snapshot)
	for _, expected := range []string{
		`"revisionId":"revision-8"`,
		`"revision":8`,
		`"state":"inactive"`,
		"Tutti mode is inactive for this turn.",
		"Tutti CLI capabilities remain available",
	} {
		if !strings.Contains(contextText, expected) {
			t.Fatalf("inactive host context = %q, want %q", contextText, expected)
		}
	}
	for _, forbidden := range []string{
		"Do not execute the user's request directly",
		"plan propose",
		"clarifying questions",
		"Workflow examples",
		"update_plan",
	} {
		if strings.Contains(contextText, forbidden) {
			t.Fatalf("inactive host context = %q, must not contain active-only directive %q", contextText, forbidden)
		}
	}
}

func TestAppServerTurnStartKeepsTuttiContextOutOfUserInput(t *testing.T) {
	t.Parallel()
	hostContext := renderTuttiModeHostContext(testActiveTuttiModeSnapshot())
	params := appServerTurnStartParams(
		Session{Settings: &SessionSettings{Model: "gpt-test"}},
		"thread-1",
		[]PromptContentBlock{{Type: "text", Text: "what mode is active?"}},
		"what mode is active?",
		nil,
		map[string]any{
			"mode":                   "default",
			"model":                  "gpt-test",
			"developer_instructions": "provider default instructions",
		},
		"gpt-test",
		hostContext,
	)
	input := payloadArray(params["input"])
	if len(input) != 1 || asString(payloadObject(input[0])["text"]) != "what mode is active?" {
		t.Fatalf("turn input = %#v", params["input"])
	}
	metadata, _ := params["responsesapiClientMetadata"].(map[string]string)
	if metadata["user_prompt_preview"] != "what mode is active?" {
		t.Fatalf("prompt preview = %#v", metadata)
	}
	collaboration := payloadObject(params["collaborationMode"])
	settings := payloadObject(collaboration["settings"])
	developerInstructions := asString(settings["developer_instructions"])
	if !strings.Contains(developerInstructions, "provider default instructions") ||
		!strings.Contains(developerInstructions, hostContext) {
		t.Fatalf("developer instructions = %q", developerInstructions)
	}
}

func TestAppServerTurnStartUsesProviderOnlyTuttiFallbackWithoutCollaborationMasks(t *testing.T) {
	t.Parallel()
	hostContext := renderTuttiModeHostContext(testActiveTuttiModeSnapshot())
	params := appServerTurnStartParams(
		Session{Settings: &SessionSettings{Model: "gpt-test"}},
		"thread-1",
		[]PromptContentBlock{{Type: "text", Text: "what mode is active?"}},
		"what mode is active?",
		nil,
		nil,
		"gpt-test",
		hostContext,
	)
	input := payloadArray(params["input"])
	if len(input) != 2 || asString(payloadObject(input[0])["text"]) != "what mode is active?" {
		t.Fatalf("turn input = %#v", params["input"])
	}
	if fallback := asString(payloadObject(input[1])["text"]); fallback != hostContext {
		t.Fatalf("provider fallback = %q, want host context", fallback)
	}
	if params["collaborationMode"] != nil {
		t.Fatalf("collaboration mode = %#v, want omitted without negotiated masks", params["collaborationMode"])
	}
	metadata, _ := params["responsesapiClientMetadata"].(map[string]string)
	if metadata["user_prompt_preview"] != "what mode is active?" {
		t.Fatalf("prompt preview = %#v", metadata)
	}
}

func TestClaudeSDKExecPayloadKeepsTuttiContextSeparateFromUserInput(t *testing.T) {
	t.Parallel()
	ctx := withTuttiModeTurnSnapshot(context.Background(), testActiveTuttiModeSnapshot())
	content := []PromptContentBlock{{Type: "text", Text: "what mode is active?"}}
	payload := claudeSDKExecPayload(
		ctx,
		Session{AgentSessionID: "session-1"},
		"turn-1",
		content,
		"what mode is active?",
	)
	if got := asString(payload["prompt"]); got != "what mode is active?" {
		t.Fatalf("prompt = %q, want original user text", got)
	}
	if got := asString(payload["hostContext"]); !strings.Contains(got, `<tutti-host-context`) {
		t.Fatalf("host context = %q", got)
	}
	if strings.Contains(asString(payload["prompt"]), `<tutti-host-context`) {
		t.Fatalf("host context leaked into user prompt: %#v", payload)
	}
}

func TestACPPromptKeepsOriginalBlocksAndAppendsProviderOnlyTuttiContext(t *testing.T) {
	t.Parallel()
	original := []map[string]any{{"type": "text", "text": "what mode is active?"}}
	got := appendTuttiModeHostContextPrompt(original, testActiveTuttiModeSnapshot())
	if len(got) != 2 || asString(got[0]["text"]) != "what mode is active?" {
		t.Fatalf("ACP prompt = %#v", got)
	}
	if host := asString(got[1]["text"]); !strings.Contains(host, `<tutti-host-context`) {
		t.Fatalf("ACP host block = %q", host)
	}
	if len(original) != 1 || asString(original[0]["text"]) != "what mode is active?" {
		t.Fatalf("original ACP content was mutated: %#v", original)
	}
}

type tuttiModeGuidanceCaptureAdapter struct {
	*blockingExecAdapter
	guidanceContexts chan context.Context
}

func (a *tuttiModeGuidanceCaptureAdapter) GuideActiveTurn(
	ctx context.Context,
	session Session,
	content []PromptContentBlock,
	_ string,
	turnID string,
	emit EventSink,
	_ CommandSnapshotSink,
) ([]activityshared.Event, error) {
	a.guidanceContexts <- ctx
	events := []activityshared.Event{
		newTurnActivityEvent(session, EventMessage, turnID, "", RoleUser, promptDisplayText(content), userPromptActivityPayload(content, "", nil)),
	}
	if emit != nil {
		emit(events)
	}
	return events, nil
}

func TestControllerGuidanceReusesFrozenTuttiModeSnapshot(t *testing.T) {
	adapter := &tuttiModeGuidanceCaptureAdapter{
		blockingExecAdapter: newBlockingExecAdapter(),
		guidanceContexts:    make(chan context.Context, 1),
	}
	controller := NewController([]Adapter{adapter}, nil)
	started, err := controller.Start(context.Background(), StartInput{
		RoomID: "room-1", AgentSessionID: "session-1", Provider: ProviderCodex,
	})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}

	active := testActiveTuttiModeSnapshot()
	if _, err := controller.Exec(context.Background(), ExecInput{
		RoomID: started.Session.RoomID, AgentSessionID: started.Session.AgentSessionID,
		Content:           textPrompt("start work"),
		TuttiModeSnapshot: active,
	}); err != nil {
		t.Fatalf("Exec() error = %v", err)
	}
	var initialContext context.Context
	select {
	case initialContext = <-adapter.contexts:
	case <-time.After(2 * time.Second):
		t.Fatal("initial provider context was not observed")
	}
	if got := tuttiModeTurnSnapshotFromContext(initialContext); got == nil || got.State != TuttiModeStateActive {
		t.Fatalf("initial tutti mode snapshot = %#v", got)
	}

	// Mutating the caller-owned object and supplying the current inactive state
	// must not rewrite the snapshot already bound to the running turn.
	active.State = TuttiModeStateInactive
	if _, err := controller.Exec(context.Background(), ExecInput{
		RoomID: started.Session.RoomID, AgentSessionID: started.Session.AgentSessionID,
		Content:           textPrompt("guide running work"),
		Guidance:          true,
		TuttiModeSnapshot: active,
	}); err != nil {
		t.Fatalf("guidance Exec() error = %v", err)
	}
	var guidanceContext context.Context
	select {
	case guidanceContext = <-adapter.guidanceContexts:
	case <-time.After(2 * time.Second):
		t.Fatal("guidance provider context was not observed")
	}
	if got := tuttiModeTurnSnapshotFromContext(guidanceContext); got == nil || got.State != TuttiModeStateActive || got.RevisionID != "revision-7" {
		t.Fatalf("guidance tutti mode snapshot = %#v, want frozen active revision", got)
	}
	adapter.releases <- struct{}{}
}
