package agentruntime

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

type sideRoutingObserver struct {
	mu     sync.Mutex
	events map[string][]StreamEvent
}

func (o *sideRoutingObserver) ObserveRuntimeStreamEvents(
	_ context.Context,
	_ string,
	sessionID string,
	events []StreamEvent,
) error {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.events == nil {
		o.events = make(map[string][]StreamEvent)
	}
	o.events[sessionID] = append(o.events[sessionID], events...)
	return nil
}

func (*sideRoutingObserver) ForgetSideConversation(string, string) {}

func (o *sideRoutingObserver) containsText(
	sessionID string,
	text string,
) bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	for _, event := range o.events[sessionID] {
		raw, _ := json.Marshal(event)
		if strings.Contains(string(raw), text) {
			return true
		}
	}
	return false
}

func TestCodexAppServerSideUsesEphemeralForkAndInjectedBoundary(t *testing.T) {
	transport := &multiProcAppServerTransport{}
	spawned := 0
	transport.setConfigure(func(server *fakeCodexAppServer) {
		spawned++
		server.userAgent = "codex/0.144.1"
		if spawned == 1 {
			server.holdTurn = true
			server.forkNotificationBeforeResponse = true
		}
	})
	adapter := NewCodexAppServerAdapter(transport)
	controller := NewController([]Adapter{adapter}, nil)
	canonicalObserver := &sideRoutingObserver{}
	sideObserver := &sideRoutingObserver{}
	controller.SetStreamEventObserver(canonicalObserver)
	controller.SetSideStreamEventObserver(sideObserver)
	started, err := controller.Start(t.Context(), StartInput{
		RoomID: "workspace-side-codex", AgentSessionID: "parent",
		Provider: ProviderCodex, CWD: "/workspace",
	})
	if err != nil {
		t.Fatal(err)
	}
	if started.Session.ProviderSessionID != "codex-thread-1" {
		t.Fatalf("source provider session = %q", started.Session.ProviderSessionID)
	}
	if _, err := controller.Exec(t.Context(), ExecInput{
		RoomID: "workspace-side-codex", AgentSessionID: "parent",
		TurnID:            "parent-turn",
		Content:           []PromptContentBlock{{Type: "text", Text: "continue parent"}},
		TuttiModeSnapshot: testActiveTuttiModeSnapshot(),
	}); err != nil {
		t.Fatal(err)
	}
	activeDeadline := time.Now().Add(5 * time.Second)
	for adapter.sessionActiveTurnID("parent") != "turn-1" &&
		time.Now().Before(activeDeadline) {
		time.Sleep(time.Millisecond)
	}
	if got := adapter.sessionActiveTurnID("parent"); got != "turn-1" {
		t.Fatalf("parent provider active turn = %q, want turn-1", got)
	}

	opened, err := controller.OpenSide(t.Context(), SideConversationOpenInput{
		RoomID: "workspace-side-codex", SourceAgentSessionID: "parent",
		SideAgentSessionID: "side-1", RequestID: "side-request-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if opened.Session.ProviderSessionID != "codex-thread-fork" ||
		!opened.Capabilities.ActiveSourceTurn ||
		!opened.Capabilities.Ephemeral ||
		!opened.Capabilities.HideInheritedTurns ||
		!opened.Capabilities.ModelBoundaryInjected {
		t.Fatalf("opened side = %#v", opened)
	}
	if !controller.HasActiveTurn("workspace-side-codex", "parent") {
		t.Fatal("Codex parent stopped while Side was opened")
	}
	if !sideObserver.containsText("side-1", "Early Side title") {
		t.Fatal("pre-fork-response child notification was not replayed to Side")
	}
	if canonicalObserver.containsText("parent", "Early Side title") {
		t.Fatal("pre-fork-response child notification leaked to parent")
	}
	if count, live := transport.snapshot(); count != 1 || len(live) != 1 {
		t.Fatalf("processes = spawned %d/live %d, want source-owned 1/1", count, len(live))
	}
	sideConn := transport.conn(0)
	fork := appServerRequestParams(t, sideConn, appServerMethodThreadFork)
	if asString(fork["threadId"]) != "codex-thread-1" ||
		asString(fork["lastTurnId"]) != "" ||
		fork["ephemeral"] != true ||
		fork["excludeTurns"] != true ||
		!strings.Contains(
			asString(fork["developerInstructions"]),
			"Only user instructions submitted after the Side boundary",
		) ||
		!strings.Contains(
			asString(fork["developerInstructions"]),
			"Do not create or delegate to sub-agents",
		) ||
		!strings.Contains(
			asString(fork["developerInstructions"]),
			"<tutti-host-context",
		) {
		t.Fatalf("thread/fork params = %#v", fork)
	}
	inject := appServerRequestParams(
		t, sideConn, appServerMethodThreadInjectItems,
	)
	if asString(inject["threadId"]) != "codex-thread-fork" {
		t.Fatalf("thread/inject_items params = %#v", inject)
	}
	items, _ := inject["items"].([]any)
	if len(items) != 1 ||
		!strings.Contains(
			asString(
				payloadObject(
					payloadArray(payloadObject(items[0])["content"])[0],
				)["text"],
			),
			"side_conversation_boundary",
		) ||
		!strings.Contains(
			asString(
				payloadObject(
					payloadArray(payloadObject(items[0])["content"])[0],
				)["text"],
			),
			"Only messages after this marker",
		) {
		t.Fatalf("thread/inject_items items = %#v", inject["items"])
	}

	sideConn.mu.Lock()
	sideConn.server.holdTurn = false
	sideConn.mu.Unlock()
	if _, err := controller.Exec(t.Context(), ExecInput{
		RoomID: "workspace-side-codex", AgentSessionID: "side-1",
		TurnID: "side-turn", Content: []PromptContentBlock{
			{Type: "text", Text: "continue only in side"},
		},
	}); err != nil {
		t.Fatal(err)
	}
	sideTurnDeadline := time.Now().Add(5 * time.Second)
	var turnStarts []map[string]any
	for time.Now().Before(sideTurnDeadline) {
		turnStarts = appServerRequestParamsList(
			t, sideConn, appServerMethodTurnStart,
		)
		if len(turnStarts) >= 2 &&
			adapter.sessionActiveTurn("side-1") == nil {
			break
		}
		time.Sleep(time.Millisecond)
	}
	if active := adapter.sessionActiveTurn("side-1"); active != nil {
		t.Fatal("Side provider turn did not settle")
	}
	if len(turnStarts) < 2 ||
		asString(turnStarts[len(turnStarts)-1]["threadId"]) !=
			"codex-thread-fork" {
		t.Fatalf("Side turn/start requests = %#v", turnStarts)
	}
	sideCollaboration := payloadObject(
		turnStarts[len(turnStarts)-1]["collaborationMode"],
	)
	sideSettings := payloadObject(sideCollaboration["settings"])
	sideDeveloperInstructions := asString(
		sideSettings["developer_instructions"],
	)
	if !strings.Contains(sideDeveloperInstructions, "<tutti-host-context") ||
		!strings.Contains(
			sideDeveloperInstructions,
			"You are operating in a Side conversation",
		) {
		t.Fatalf(
			"Side turn developer instructions lost inherited context: %q",
			sideDeveloperInstructions,
		)
	}
	if !controller.HasActiveTurn("workspace-side-codex", "parent") {
		t.Fatal("Side turn completion disturbed the active parent")
	}

	if _, err := controller.Close(t.Context(), CloseInput{
		RoomID: "workspace-side-codex", AgentSessionID: "side-1",
	}); err != nil {
		t.Fatal(err)
	}
	if count, live := transport.snapshot(); count != 1 || len(live) != 1 {
		t.Fatalf("after side close = spawned %d/live %d, want shared parent 1/1", count, len(live))
	}
	unsubscribes := appServerRequestParamsList(
		t, sideConn, appServerMethodThreadUnsubscribe,
	)
	if len(unsubscribes) != 1 ||
		asString(unsubscribes[0]["threadId"]) != "codex-thread-fork" {
		t.Fatalf("thread/unsubscribe requests = %#v", unsubscribes)
	}
	if deletes := appServerRequestParamsList(t, sideConn, "thread/delete"); len(deletes) != 0 {
		t.Fatalf("ephemeral Side issued thread/delete = %#v", deletes)
	}

	transport.conn(0).server.completePendingTurn()
	if _, err := controller.Close(t.Context(), CloseInput{
		RoomID: "workspace-side-codex", AgentSessionID: "parent",
	}); err != nil {
		t.Fatal(err)
	}
}

func TestCodexSideLateForkResponseUnsubscribesOrphan(t *testing.T) {
	adapter, transport, session := startedAppServerAdapter(t)
	appSession := adapter.getSession(session.AgentSessionID)
	transport.conn.mu.Lock()
	transport.server.forkResponseDelay = 40 * time.Millisecond
	transport.conn.mu.Unlock()
	lateCleaned := make(chan struct{}, 1)

	_, err := appSession.client.ThreadForkSide(
		context.Background(),
		5*time.Millisecond,
		map[string]any{
			"threadId":     appSession.threadID,
			"ephemeral":    true,
			"excludeTurns": true,
		},
		nil,
		func(raw json.RawMessage) {
			var response struct {
				Thread *struct {
					ID string `json:"id"`
				} `json:"thread"`
			}
			if json.Unmarshal(raw, &response) != nil || response.Thread == nil {
				return
			}
			_ = appSession.client.ThreadUnsubscribeNoHandler(
				context.Background(),
				time.Second,
				response.Thread.ID,
			)
			lateCleaned <- struct{}{}
		},
	)
	if err == nil {
		t.Fatal("ThreadForkSide unexpectedly completed before timeout")
	}
	select {
	case <-lateCleaned:
	case <-time.After(time.Second):
		t.Fatal("late fork result was not reconciled")
	}
	unsubscribe := appServerRequestParams(
		t,
		transport.conn,
		appServerMethodThreadUnsubscribe,
	)
	if asString(unsubscribe["threadId"]) != "codex-thread-fork" {
		t.Fatalf("late cleanup unsubscribe = %#v", unsubscribe)
	}
}

func TestAppServerMessageThreadIDSupportsLegacyConversationID(t *testing.T) {
	if got := appServerMessageThreadID(map[string]any{
		"conversationId": "legacy-side-thread",
	}); got != "legacy-side-thread" {
		t.Fatalf("legacy thread id = %q", got)
	}
	if got := appServerMessageThreadID(map[string]any{
		"threadId": "modern-thread", "conversationId": "legacy-thread",
	}); got != "modern-thread" {
		t.Fatalf("modern thread id precedence = %q", got)
	}
}

func TestSharedAppServerRouterPrefersExactSideThreadOverParentChildIndex(
	t *testing.T,
) {
	adapter := NewCodexAppServerAdapter(nil)
	client := &codexAppServerClient{}
	parent := Session{
		RoomID: "workspace-router", AgentSessionID: "parent",
		Provider: ProviderCodex, ProviderSessionID: "parent-thread",
	}
	side := Session{
		RoomID: "workspace-router", AgentSessionID: "side",
		Provider: ProviderCodex, ProviderSessionID: "shared-thread",
		Scope: RuntimeSessionScopeSide, SourceAgentSessionID: "parent",
	}
	adapter.sessions["parent"] = &codexAppServerSession{
		client: client, threadID: "parent-thread", runtimeSession: parent,
		childThreads: map[string]*codexAppServerThreadContext{
			"shared-thread": {agentSessionID: "canonical-child"},
		},
	}
	adapter.sessions["side"] = &codexAppServerSession{
		client: client, threadID: "shared-thread", runtimeSession: side,
	}
	var routedSessionIDs []string
	adapter.SetSessionEventSink(
		func(agentSessionID string, _ []activityshared.Event) {
			routedSessionIDs = append(routedSessionIDs, agentSessionID)
		},
	)

	if err := adapter.routeSharedAppServerMessage(
		t.Context(),
		client,
		parent,
		acpMessage{
			Method: appServerNotifyThreadNameUpdated,
			Params: json.RawMessage(
				`{"threadId":"shared-thread","threadName":"Side title"}`,
			),
		},
	); err != nil {
		t.Fatal(err)
	}
	if len(routedSessionIDs) != 1 || routedSessionIDs[0] != "side" {
		t.Fatalf("routed session ids = %#v, want exact Side", routedSessionIDs)
	}
}

func TestCodexAppServerSideMalformedLineageUnsubscribesEphemeralChild(t *testing.T) {
	transport := &multiProcAppServerTransport{}
	transport.setConfigure(func(server *fakeCodexAppServer) {
		server.userAgent = "codex/0.144.1"
		server.forkedFromThreadID = "wrong-parent"
	})
	adapter := NewCodexAppServerAdapter(transport)
	controller := NewController([]Adapter{adapter}, nil)
	if _, err := controller.Start(t.Context(), StartInput{
		RoomID: "workspace-side-lineage", AgentSessionID: "parent",
		Provider: ProviderCodex, CWD: "/workspace",
	}); err != nil {
		t.Fatal(err)
	}
	_, err := controller.OpenSide(t.Context(), SideConversationOpenInput{
		RoomID: "workspace-side-lineage", SourceAgentSessionID: "parent",
		SideAgentSessionID: "side-invalid-lineage", RequestID: "open-invalid-lineage",
	})
	if err == nil || !strings.Contains(err.Error(), "invalid lineage") {
		t.Fatalf("OpenSide error = %v, want invalid lineage", err)
	}
	conn := transport.conn(0)
	unsubscribes := appServerRequestParamsList(
		t, conn, appServerMethodThreadUnsubscribe,
	)
	if len(unsubscribes) != 1 ||
		asString(unsubscribes[0]["threadId"]) != "codex-thread-fork" {
		t.Fatalf("thread/unsubscribe requests = %#v", unsubscribes)
	}
	parent, found := controller.Session("workspace-side-lineage", "parent")
	if !found || !adapter.HasLiveSession(parent) {
		t.Fatal("malformed Side lineage disturbed the parent")
	}
}

func TestCodexSideInstructionsPreserveEffectiveCollaborationPolicy(t *testing.T) {
	tests := []struct {
		name             string
		planMode         bool
		planModeMask     map[string]any
		defaultModeMask  map[string]any
		wantBasePolicy   string
		unwantedBaseMode string
	}{
		{
			name: "default mode",
			defaultModeMask: map[string]any{
				"developer_instructions": "Existing default policy.",
			},
			planModeMask: map[string]any{
				"developer_instructions": "Existing plan policy.",
			},
			wantBasePolicy:   "Existing default policy.",
			unwantedBaseMode: "Existing plan policy.",
		},
		{
			name:     "plan mode nested settings",
			planMode: true,
			defaultModeMask: map[string]any{
				"developer_instructions": "Existing default policy.",
			},
			planModeMask: map[string]any{
				"settings": map[string]any{
					"developer_instructions": "Existing plan policy.",
				},
			},
			wantBasePolicy:   "Existing plan policy.",
			unwantedBaseMode: "Existing default policy.",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got := codexSideInstructions(
				Session{Settings: &SessionSettings{PlanMode: test.planMode}},
				test.planModeMask,
				test.defaultModeMask,
				"parent workspace context marker",
			)
			if !strings.HasPrefix(got, test.wantBasePolicy+"\n\n") ||
				!strings.Contains(got, "parent workspace context marker") ||
				!strings.Contains(got, codexSideDeveloperInstructions) ||
				strings.Contains(got, test.unwantedBaseMode) {
				t.Fatalf("Side instructions = %q", got)
			}
		})
	}
}
