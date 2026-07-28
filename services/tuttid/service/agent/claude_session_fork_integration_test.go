package agent

import (
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"path/filepath"
	"sync"
	"testing"

	hostadapter "github.com/tutti-os/tutti/packages/agent/daemon/hostadapter"
	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	_ "modernc.org/sqlite"
)

func TestClaudeSessionForkTraversesProductionWiringAcrossRestart(t *testing.T) {
	ctx := t.Context()
	db, err := sql.Open(
		"sqlite",
		filepath.Join(t.TempDir(), "claude-session-fork-integration.db"),
	)
	if err != nil {
		t.Fatalf("open SQLite: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	db.SetMaxOpenConns(1)
	canonical := storesqlite.New(db, storesqlite.Options{})
	if err := canonical.Migrate(ctx); err != nil {
		t.Fatalf("migrate SQLite: %v", err)
	}
	seedClaudeForkIntegrationSource(t, canonical)

	store := &agenthost.SQLiteWorkspaceStore{
		StoreForWorkspace: func(workspaceID string) *storesqlite.Store {
			if workspaceID == "workspace-claude-fork" {
				return canonical
			}
			return nil
		},
	}
	transport := &claudeForkIntegrationTransport{}
	_, bridge, applicationHost := newClaudeForkIntegrationRuntime(
		transport,
		store,
	)

	capabilities, err := applicationHost.GetSessionForkCapabilities(
		ctx,
		agenthost.SessionForkCapabilityInput{
			WorkspaceID:          "workspace-claude-fork",
			SourceAgentSessionID: "session-source",
		},
	)
	if err != nil {
		t.Fatalf("GetSessionForkCapabilities: %v", err)
	}
	if !capabilities.ThroughTurn ||
		!capabilities.ThroughTurnIDsKnown ||
		len(capabilities.ThroughTurnIDs) != 1 ||
		capabilities.ThroughTurnIDs[0] != "turn-source" {
		t.Fatalf("source capabilities=%#v", capabilities)
	}

	forked, err := applicationHost.ForkSession(
		ctx,
		agenthost.ForkSessionInput{
			WorkspaceID:          "workspace-claude-fork",
			SourceAgentSessionID: "session-source",
			TargetAgentSessionID: "session-child",
			RequestID:            "request-source-child",
			Point: agenthost.SessionForkPoint{
				Kind:   agenthost.SessionForkPointThroughTurn,
				TurnID: "turn-source",
			},
		},
	)
	if err != nil {
		t.Fatalf("ForkSession source -> child: %v", err)
	}
	childProviderSessionID := forked.Operation.OperationID
	if forked.Operation.Status != storesqlite.SessionForkStatusCommitted ||
		forked.Session.ProviderSessionID != childProviderSessionID ||
		forked.Lineage == nil {
		t.Fatalf("source fork result=%#v", forked)
	}
	childTurn, found, err := canonical.GetTurn(
		ctx,
		"workspace-claude-fork",
		"session-child",
		forked.Lineage.TargetTurnID,
	)
	if err != nil || !found {
		t.Fatalf("get child turn found=%v error=%v", found, err)
	}
	if childTurn.RootProviderTurnID != "child-prompt-1" {
		t.Fatalf(
			"child provider turn id=%q, want remapped UUID",
			childTurn.RootProviderTurnID,
		)
	}
	if bridge.RuntimeSessionLive("workspace-claude-fork", "session-source") {
		t.Fatal("historical source capability probe created a live runtime")
	}

	// Rebuild both daemon Controller and Host around the same production Store.
	// The committed child still contains the frozen source resume cursor, so
	// the Claude adapter must discard it and resume the canonical child ID.
	_, restartedBridge, restartedHost := newClaudeForkIntegrationRuntime(
		transport,
		store,
	)
	child, found, err := canonical.GetSession(
		ctx,
		"workspace-claude-fork",
		"session-child",
	)
	if err != nil || !found {
		t.Fatalf("get committed child found=%v error=%v", found, err)
	}
	resumed, err := restartedBridge.Resume(
		ctx,
		agenthost.RuntimeResumeInput{
			WorkspaceID:            child.WorkspaceID,
			AgentSessionID:         child.ID,
			AgentTargetID:          child.AgentTargetID,
			Provider:               child.Provider,
			ProviderSessionID:      child.ProviderSessionID,
			Resumable:              true,
			Cwd:                    child.Cwd,
			Title:                  child.Title,
			Status:                 "ready",
			RuntimeContext:         child.InternalRuntimeContext,
			InternalRuntimeContext: child.InternalRuntimeContext,
			CreatedAtUnixMS:        child.CreatedAtUnixMS,
			UpdatedAtUnixMS:        child.UpdatedAtUnixMS,
		},
	)
	if err != nil {
		t.Fatalf("resume committed child after restart: %v", err)
	}
	if resumed.ProviderSessionID != childProviderSessionID ||
		!restartedBridge.RuntimeSessionLive(
			"workspace-claude-fork",
			"session-child",
		) {
		t.Fatalf("resumed child=%#v", resumed)
	}
	startPayload, found := transport.lastStartPayload("session-child")
	if !found {
		t.Fatal("child resume did not start Claude sidecar")
	}
	if cursor, exists := startPayload["resumeCursor"]; exists && cursor != nil {
		t.Fatalf("child resume reused source cursor: %#v", cursor)
	}
	if startPayload["providerSessionId"] != childProviderSessionID {
		t.Fatalf("child start payload=%#v", startPayload)
	}

	nested, err := restartedHost.ForkSession(
		ctx,
		agenthost.ForkSessionInput{
			WorkspaceID:          "workspace-claude-fork",
			SourceAgentSessionID: "session-child",
			TargetAgentSessionID: "session-grandchild",
			RequestID:            "request-child-grandchild",
			Point: agenthost.SessionForkPoint{
				Kind:   agenthost.SessionForkPointThroughTurn,
				TurnID: forked.Lineage.TargetTurnID,
			},
		},
	)
	if err != nil {
		t.Fatalf("ForkSession child -> grandchild: %v", err)
	}
	if nested.Operation.Status != storesqlite.SessionForkStatusCommitted ||
		nested.Session.ProviderSessionID != nested.Operation.OperationID ||
		nested.Lineage == nil {
		t.Fatalf("nested fork result=%#v", nested)
	}
	grandchildTurn, found, err := canonical.GetTurn(
		ctx,
		"workspace-claude-fork",
		"session-grandchild",
		nested.Lineage.TargetTurnID,
	)
	if err != nil || !found {
		t.Fatalf("get grandchild turn found=%v error=%v", found, err)
	}
	if grandchildTurn.RootProviderTurnID != "grandchild-prompt-1" {
		t.Fatalf(
			"grandchild provider turn id=%q, want nested remapped UUID",
			grandchildTurn.RootProviderTurnID,
		)
	}

	execResult, err := restartedBridge.Exec(
		ctx,
		agenthost.RuntimeExecInput{
			WorkspaceID:    "workspace-claude-fork",
			AgentSessionID: "session-child",
			TurnID:         "turn-child-continue",
			Content: []agenthost.PromptContentBlock{{
				Type: "text",
				Text: "continue from the fork",
			}},
			DisplayPrompt: "continue from the fork",
		},
	)
	if err != nil {
		t.Fatalf("continue forked child: %v", err)
	}
	if !execResult.Accepted || execResult.TurnID != "turn-child-continue" {
		t.Fatalf("child continuation result=%#v", execResult)
	}
	if err := restartedBridge.Close(
		ctx,
		agenthost.RuntimeCloseInput{
			WorkspaceID:    "workspace-claude-fork",
			AgentSessionID: "session-child",
		},
	); err != nil {
		t.Fatalf("close resumed child: %v", err)
	}
}

func newClaudeForkIntegrationRuntime(
	transport agentruntime.ProcessTransport,
	store *agenthost.SQLiteWorkspaceStore,
) (
	*agentruntime.Controller,
	*hostadapter.RuntimeController,
	*agenthost.Host,
) {
	adapter := agentruntime.NewClaudeCodeSDKAdapter(transport)
	controller := agentruntime.NewController(
		[]agentruntime.Adapter{adapter},
		nil,
	)
	bridge := &hostadapter.RuntimeController{Backend: controller}
	applicationHost := agenthost.New(agenthost.Config{
		SessionForks:       store,
		SessionForkRuntime: bridge,
		Runtime:            bridge,
	})
	return controller, bridge, applicationHost
}

func seedClaudeForkIntegrationSource(
	t *testing.T,
	store *storesqlite.Store,
) {
	t.Helper()
	ctx := t.Context()
	session := storesqlite.SessionStateReport{
		WorkspaceID:       "workspace-claude-fork",
		AgentSessionID:    "session-source",
		Kind:              storesqlite.SessionKindRoot,
		Origin:            "runtime",
		Provider:          agentruntime.ProviderClaudeCode,
		ProviderSessionID: "claude-source",
		RuntimeContext: map[string]any{
			"resumeCursor": map[string]any{
				"kind":            "claude-agent-sdk",
				"version":         float64(1),
				"resume":          "claude-source",
				"resumeSessionAt": "source-answer-1",
				"turnCount":       float64(1),
			},
		},
		Cwd:              "/workspace",
		Status:           "ready",
		CurrentPhase:     "idle",
		OccurredAtUnixMS: 1,
	}
	if _, err := store.ReportSessionState(ctx, session); err != nil {
		t.Fatalf("seed Claude source session: %v", err)
	}
	session.Status = "active"
	session.CurrentPhase = "working"
	session.OccurredAtUnixMS = 10
	if result, err := store.ReportActivityState(
		ctx,
		storesqlite.ActivityStateReport{
			Session: session,
			Turn: &storesqlite.TurnTransition{
				WorkspaceID:      session.WorkspaceID,
				AgentSessionID:   session.AgentSessionID,
				TurnID:           "turn-source",
				Phase:            storesqlite.TurnPhaseRunning,
				OccurredAtUnixMS: 10,
			},
			RootProviderTurn: &storesqlite.RootProviderTurnTransition{
				WorkspaceID:        session.WorkspaceID,
				RootAgentSessionID: session.AgentSessionID,
				RootTurnID:         "turn-source",
				ProviderTurnID:     "source-prompt-1",
				Phase:              storesqlite.RootProviderTurnPhaseRunning,
				OccurredAtUnixMS:   10,
			},
		},
	); err != nil || !result.TurnAccepted || !result.RootTurnAccepted {
		t.Fatalf("seed Claude source turn result=%#v error=%v", result, err)
	}
	if _, err := store.ReportSessionMessages(
		ctx,
		storesqlite.SessionMessageReport{
			WorkspaceID:    session.WorkspaceID,
			AgentSessionID: session.AgentSessionID,
			Origin:         "runtime",
			Messages: []storesqlite.MessageUpdate{{
				MessageID:        "message-source-answer",
				TurnID:           "turn-source",
				Role:             "assistant",
				Kind:             "text",
				Status:           "completed",
				Payload:          map[string]any{"text": "source answer"},
				OccurredAtUnixMS: 11,
			}},
		},
	); err != nil {
		t.Fatalf("seed Claude source message: %v", err)
	}
	session.OccurredAtUnixMS = 12
	if result, err := store.ReportActivityState(
		ctx,
		storesqlite.ActivityStateReport{
			Session: session,
			RootProviderTurn: &storesqlite.RootProviderTurnTransition{
				WorkspaceID:        session.WorkspaceID,
				RootAgentSessionID: session.AgentSessionID,
				RootTurnID:         "turn-source",
				ProviderTurnID:     "source-prompt-1",
				Phase:              storesqlite.RootProviderTurnPhaseCompleted,
				Outcome:            storesqlite.TurnOutcomeCompleted,
				OccurredAtUnixMS:   12,
			},
		},
	); err != nil || !result.RootTurnAccepted {
		t.Fatalf("settle Claude source turn result=%#v error=%v", result, err)
	}
}

type claudeForkIntegrationTransport struct {
	mu              sync.Mutex
	requestTypes    []string
	startPayloads   map[string]map[string]any
	providerTurnIDs map[string]string
}

func (t *claudeForkIntegrationTransport) Start(
	_ context.Context,
	spec agentruntime.ProcessSpec,
) (agentruntime.ProcessConnection, error) {
	return &claudeForkIntegrationConnection{
		transport:      t,
		agentSessionID: spec.AgentSessionID,
		frames:         make(chan agentruntime.ProcessFrame, 8),
		closed:         make(chan struct{}),
	}, nil
}

func (t *claudeForkIntegrationTransport) record(
	agentSessionID string,
	request claudeForkIntegrationRequest,
) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.requestTypes = append(t.requestTypes, request.Type)
	if request.Type == "start" {
		if t.startPayloads == nil {
			t.startPayloads = make(map[string]map[string]any)
		}
		t.startPayloads[agentSessionID] = cloneClaudeForkIntegrationMap(
			request.Payload,
		)
	}
}

func (t *claudeForkIntegrationTransport) lastStartPayload(
	agentSessionID string,
) (map[string]any, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	payload, found := t.startPayloads[agentSessionID]
	return cloneClaudeForkIntegrationMap(payload), found
}

func (t *claudeForkIntegrationTransport) providerTurnIDsForSession(
	providerSessionID string,
) []string {
	t.mu.Lock()
	defer t.mu.Unlock()
	if providerSessionID == "claude-source" {
		return []string{"source-prompt-1"}
	}
	if turnID := t.providerTurnIDs[providerSessionID]; turnID != "" {
		return []string{turnID}
	}
	return []string{}
}

func (t *claudeForkIntegrationTransport) forkTarget(
	sourceID, targetID string,
) (string, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if targetID == "" {
		return "", false
	}
	targetTurnID := ""
	switch {
	case sourceID == "claude-source":
		targetTurnID = "child-prompt-1"
	case t.providerTurnIDs[sourceID] != "":
		targetTurnID = "grandchild-prompt-1"
	default:
		return "", false
	}
	if t.providerTurnIDs == nil {
		t.providerTurnIDs = make(map[string]string)
	}
	t.providerTurnIDs[targetID] = targetTurnID
	return targetTurnID, true
}

type claudeForkIntegrationConnection struct {
	transport      *claudeForkIntegrationTransport
	agentSessionID string
	frames         chan agentruntime.ProcessFrame
	closed         chan struct{}
	closeOnce      sync.Once
}

type claudeForkIntegrationRequest struct {
	Version int            `json:"version"`
	ID      string         `json:"id"`
	Type    string         `json:"type"`
	Payload map[string]any `json:"payload"`
}

func (c *claudeForkIntegrationConnection) Send(data []byte) error {
	var request claudeForkIntegrationRequest
	if err := json.Unmarshal(data, &request); err != nil {
		return err
	}
	c.transport.record(c.agentSessionID, request)
	switch request.Type {
	case "inspect_fork_checkpoints":
		return c.emit(
			request.ID,
			"ok",
			map[string]any{
				"providerTurnIds": c.transport.providerTurnIDsForSession(
					claudeForkIntegrationString(
						request.Payload["providerSessionId"],
					),
				),
			},
		)
	case "fork_session":
		sourceID := claudeForkIntegrationString(
			request.Payload["providerSessionId"],
		)
		targetID := claudeForkIntegrationString(
			request.Payload["targetProviderSessionId"],
		)
		targetTurnID, ok := c.transport.forkTarget(sourceID, targetID)
		if !ok {
			return c.emit(
				request.ID,
				"error",
				map[string]any{
					"error":               "unknown fixture source",
					"deliveryDisposition": "not_started",
				},
			)
		}
		return c.emit(
			request.ID,
			"ok",
			map[string]any{
				"providerSessionId":     targetID,
				"targetProviderTurnIds": []string{targetTurnID},
				"stateBindingMode":      "provider_owned",
				"stateBindingReceipt":   "claude-sdk-fork-v1:" + targetID,
				"deliveryDisposition":   "accepted",
			},
		)
	case "start":
		return c.emit(
			request.ID,
			"session_started",
			map[string]any{
				"providerSessionId": claudeForkIntegrationString(
					request.Payload["providerSessionId"],
				),
			},
		)
	case "exec":
		turnID := claudeForkIntegrationString(request.Payload["turnId"])
		providerTurnID := claudeForkIntegrationString(
			request.Payload["providerTurnId"],
		)
		if err := c.emit(
			"",
			"assistant_completed",
			map[string]any{
				"turnId":         turnID,
				"providerTurnId": providerTurnID,
				"content":        "continued child",
			},
		); err != nil {
			return err
		}
		return c.emit(
			"",
			"turn_completed",
			map[string]any{
				"turnId":         turnID,
				"providerTurnId": providerTurnID,
				"stopReason":     "end_turn",
			},
		)
	case "close":
		return c.emit(request.ID, "ok", nil)
	default:
		return c.emit(request.ID, "ok", nil)
	}
}

func (c *claudeForkIntegrationConnection) emit(
	id string,
	eventType string,
	payload map[string]any,
) error {
	data, err := json.Marshal(map[string]any{
		"version": 3,
		"id":      id,
		"type":    eventType,
		"payload": payload,
	})
	if err != nil {
		return err
	}
	select {
	case c.frames <- agentruntime.ProcessFrame{
		Stdout: append(data, '\n'),
	}:
		return nil
	case <-c.closed:
		return io.EOF
	}
}

func (c *claudeForkIntegrationConnection) Recv() (
	agentruntime.ProcessFrame,
	error,
) {
	select {
	case frame := <-c.frames:
		return frame, nil
	case <-c.closed:
		return agentruntime.ProcessFrame{}, io.EOF
	}
}

func (c *claudeForkIntegrationConnection) Close() error {
	c.closeOnce.Do(func() {
		close(c.closed)
	})
	return nil
}

func cloneClaudeForkIntegrationMap(source map[string]any) map[string]any {
	if source == nil {
		return nil
	}
	data, err := json.Marshal(source)
	if err != nil {
		panic(err)
	}
	var result map[string]any
	if err := json.Unmarshal(data, &result); err != nil {
		panic(err)
	}
	return result
}

func claudeForkIntegrationString(value any) string {
	result, _ := value.(string)
	return result
}

var _ agentruntime.ProcessTransport = (*claudeForkIntegrationTransport)(nil)
var _ agentruntime.ProcessConnection = (*claudeForkIntegrationConnection)(nil)
