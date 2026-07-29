package storesqlite

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
)

func TestSessionForkThroughTurnClonesInclusivePrefixAndReplays(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	seedForkSession(t, store)
	if _, updated, err := store.UpdateSessionTitle(
		ctx,
		"ws-1",
		"source",
		"123",
	); err != nil || !updated {
		t.Fatalf("UpdateSessionTitle() updated=%v error=%v", updated, err)
	}
	if _, err := store.db.ExecContext(ctx, `
UPDATE workspace_agent_sessions
SET session_metadata_json = '{
  "visible": true,
  "imported": true,
  "capabilities": [],
  "usage": {
    "contextWindow": {"usedTokens": 1, "totalTokens": 10},
    "quotas": []
  },
  "goal": {"objective": "ship", "status": "active"}
}'
WHERE workspace_id = 'ws-1' AND agent_session_id = 'source'
`); err != nil {
		t.Fatal(err)
	}

	prepare := SessionForkPrepare{
		OperationID: "fork-op", WorkspaceID: "ws-1", RequestID: "request-1",
		RequestHash: "hash-1", SourceAgentSessionID: "source",
		TargetAgentSessionID: "target", SourceTurnID: "turn-1",
		DriverKind: "codex-app-server", DriverVersion: "1", OccurredAtUnixMS: 100,
		TargetCwd: "/target/project",
		TargetRuntimeContext: map[string]any{"sessionRuntimeSnapshot": map[string]any{
			"version": float64(1),
		}},
		TargetSettings: map[string]any{
			"model": "prepared-model", "permissionModeId": "prepared-mode",
		},
	}
	operation, changed, err := prepareSessionForkForTest(t, store, ctx, prepare)
	if err != nil || !changed || operation.Status != SessionForkStatusPrepared ||
		operation.PointKind != SessionForkPointThroughTurn {
		t.Fatalf("PrepareSessionFork() operation=%#v changed=%v error=%v", operation, changed, err)
	}
	replayed, changed, err := prepareSessionForkForTest(t, store, ctx, prepare)
	if err != nil || changed || replayed.OperationID != operation.OperationID {
		t.Fatalf("PrepareSessionFork(replay) operation=%#v changed=%v error=%v", replayed, changed, err)
	}
	conflict := prepare
	conflict.RequestHash = "different"
	if _, _, err := prepareSessionForkForTest(t, store, ctx, conflict); !errors.Is(err, ErrSessionForkRequestConflict) {
		t.Fatalf("PrepareSessionFork(conflict) error=%v", err)
	}

	operation, changed, err = store.MarkSessionForkDispatching(ctx, "ws-1", "fork-op", 101)
	if err != nil || !changed || operation.Status != SessionForkStatusDispatching {
		t.Fatalf("MarkSessionForkDispatching() operation=%#v changed=%v error=%v", operation, changed, err)
	}
	operation, changed, err = store.RecordSessionForkProviderResult(ctx, SessionForkProviderResult{
		WorkspaceID: "ws-1", OperationID: "fork-op",
		Status: SessionForkStatusProviderAccepted, TargetProviderSessionID: "provider-target",
		OccurredAtUnixMS: 102,
	})
	if err != nil || !changed || operation.Status != SessionForkStatusProviderAccepted {
		t.Fatalf("RecordSessionForkProviderResult() operation=%#v changed=%v error=%v", operation, changed, err)
	}
	committed, err := store.CommitSessionFork(ctx, "ws-1", "fork-op", 103)
	if err != nil || !committed.Changed || committed.Operation.Status != SessionForkStatusCommitted {
		t.Fatalf("CommitSessionFork() result=%#v error=%v", committed, err)
	}
	retried, err := store.CommitSessionFork(ctx, "ws-1", "fork-op", 104)
	if err != nil || retried.Changed || retried.Operation.Status != SessionForkStatusCommitted {
		t.Fatalf("CommitSessionFork(retry) result=%#v error=%v", retried, err)
	}

	child, found, err := store.GetSession(ctx, "ws-1", "target")
	if err != nil || !found || child.Kind != SessionKindRoot ||
		child.ProviderSessionID != "provider-target" || child.ActiveTurnID != "" ||
		child.Title != "123 (2)" ||
		child.Cwd != "/target/project" ||
		child.Model != "prepared-model" ||
		child.Settings["permissionModeId"] != "prepared-mode" ||
		child.InternalRuntimeContext["sessionRuntimeSnapshot"] == nil ||
		child.Metadata.Imported || child.Metadata.Usage != nil ||
		child.Metadata.Goal != nil ||
		child.StartedAtUnixMS != 103 || child.LastEventUnixMS != 103 ||
		child.EndedAtUnixMS != 0 {
		t.Fatalf("forked session=%#v found=%v error=%v", child, found, err)
	}
	if retried.Session.StartedAtUnixMS != child.StartedAtUnixMS ||
		retried.Session.LastEventUnixMS != child.LastEventUnixMS ||
		retried.Session.Title != child.Title ||
		retried.Session.Metadata.Imported != child.Metadata.Imported ||
		retried.Session.Metadata.Usage != child.Metadata.Usage ||
		retried.Session.Metadata.Goal != child.Metadata.Goal {
		t.Fatalf(
			"first/replayed committed sessions diverged: first=%#v replay=%#v",
			child,
			retried.Session,
		)
	}
	expectedTurnID := deterministicSessionForkCanonicalID(operation, "turn", "turn-1")
	expectedMessageID := deterministicSessionForkCanonicalID(operation, "message", "message-1")
	if committed.Operation.TargetTurnID != expectedTurnID ||
		committed.Lineage.TargetTurnID != expectedTurnID ||
		retried.Operation.TargetTurnID != expectedTurnID ||
		retried.Lineage.TargetTurnID != expectedTurnID {
		t.Fatalf(
			"fork boundary target identity first=%#v replay=%#v want=%q",
			committed,
			retried,
			expectedTurnID,
		)
	}
	turns, err := store.ListSessionTurns(ctx, "ws-1", "target")
	if err != nil || len(turns) != 1 || turns[0].TurnID != expectedTurnID {
		t.Fatalf("forked turns=%#v error=%v", turns, err)
	}
	page, found, err := store.ListSessionMessages(ctx, ListSessionMessagesInput{
		WorkspaceID: "ws-1", AgentSessionID: "target", Limit: 10,
	})
	if err != nil || !found || len(page.Messages) != 1 {
		t.Fatalf("forked messages=%#v found=%v error=%v", page.Messages, found, err)
	}
	if page.Messages[0].MessageID != expectedMessageID ||
		page.Messages[0].TurnID != expectedTurnID ||
		page.Messages[0].Version != 1 ||
		page.Messages[0].Payload["sourceSessionId"] != "source" {
		t.Fatalf("forked message=%#v", page.Messages[0])
	}
	lineage, found, err := store.GetSessionForkLineage(ctx, "ws-1", "target")
	if err != nil || !found || lineage.SourceAgentSessionID != "source" ||
		lineage.SourceTurnID != "turn-1" ||
		lineage.TargetTurnID != expectedTurnID {
		t.Fatalf("lineage=%#v found=%v error=%v", lineage, found, err)
	}
	recovered, created, err := prepareSessionForkForTest(t, store, ctx, SessionForkPrepare{
		OperationID: "fork-op-lost-response", WorkspaceID: "ws-1",
		RequestID: "request-lost-response", RequestHash: "hash-lost-response",
		SourceAgentSessionID: "source", TargetAgentSessionID: "target-lost-response",
		SourceTurnID: "turn-1", DriverKind: "codex-app-server",
		DriverVersion: "1", OccurredAtUnixMS: 105,
	})
	if err != nil || created || recovered.OperationID != "fork-op" ||
		recovered.TargetAgentSessionID != "target" ||
		recovered.ClientObservedAtUnixMS != 0 {
		t.Fatalf(
			"unobserved committed barrier operation=%#v created=%v error=%v",
			recovered,
			created,
			err,
		)
	}
	if _, found, changed, err := store.AcknowledgeSessionForkOperation(
		ctx,
		"ws-1",
		"fork-op",
		106,
	); err != nil || !found || !changed {
		t.Fatalf("first acknowledgement found=%v changed=%v error=%v", found, changed, err)
	}
	if acknowledged, found, changed, err := store.AcknowledgeSessionForkOperation(
		ctx,
		"ws-1",
		"fork-op",
		107,
	); err != nil || !found || changed ||
		acknowledged.ClientObservedAtUnixMS != 106 {
		t.Fatalf(
			"replayed acknowledgement operation=%#v found=%v changed=%v error=%v",
			acknowledged,
			found,
			changed,
			err,
		)
	}
	next, created, err := prepareSessionForkForTest(t, store, ctx, SessionForkPrepare{
		OperationID: "fork-op-next", WorkspaceID: "ws-1",
		RequestID: "request-next", RequestHash: "hash-next",
		SourceAgentSessionID: "source", TargetAgentSessionID: "target-next",
		SourceTurnID: "turn-1", DriverKind: "codex-app-server",
		DriverVersion: "1", OccurredAtUnixMS: 108,
	})
	if err != nil || !created || next.OperationID != "fork-op-next" {
		t.Fatalf("post-ack prepare operation=%#v created=%v error=%v", next, created, err)
	}
	if _, changed, err := store.FailPreparedSessionFork(
		ctx,
		"ws-1",
		"fork-op-next",
		"test cleanup",
		109,
	); err != nil || !changed {
		t.Fatalf("cleanup post-ack fork changed=%v error=%v", changed, err)
	}
	if _, err := store.db.ExecContext(ctx, `
UPDATE workspace_agent_sessions
SET deleted_at_unix_ms = 200
WHERE workspace_id = 'ws-1' AND agent_session_id = 'target'
`); err != nil {
		t.Fatal(err)
	}
	purged, err := store.PurgeDeletedSessions(ctx, PurgeDeletedSessionsInput{
		CutoffUnixMS: 201,
	})
	if err != nil || len(purged.Sessions) != 1 ||
		purged.Sessions[0].AgentSessionID != "target" {
		t.Fatalf("PurgeDeletedSessions() result=%#v error=%v", purged, err)
	}
	if _, found, err := store.GetSessionForkLineage(
		ctx,
		"ws-1",
		"target",
	); err != nil || found {
		t.Fatalf("lineage after hard purge found=%v error=%v", found, err)
	}
	afterDelete, err := store.CommitSessionFork(ctx, "ws-1", "fork-op", 201)
	if err != nil ||
		afterDelete.Session.ID != "target" ||
		afterDelete.Session.Title != "123 (2)" ||
		afterDelete.Session.RailSectionKey == "" ||
		afterDelete.Lineage.SourceAgentSessionID != "source" ||
		afterDelete.Operation.TargetTurnID != expectedTurnID ||
		afterDelete.Lineage.TargetTurnID != expectedTurnID ||
		afterDelete.Lineage.ForkedAtUnixMS != 103 {
		t.Fatalf(
			"CommitSessionFork(after child delete) result=%#v error=%v",
			afterDelete,
			err,
		)
	}
}

func TestSessionForkProviderOwnedResultRewritesChildProviderTurnIdentity(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	seedForkSession(t, store)
	if _, updated, err := store.UpdateSessionTitle(
		ctx, "ws-1", "source", "Claude session",
	); err != nil || !updated {
		t.Fatalf("UpdateSessionTitle() updated=%v error=%v", updated, err)
	}
	input := SessionForkPrepare{
		OperationID: "fork-provider-owned", WorkspaceID: "ws-1",
		RequestID: "request-provider-owned", RequestHash: "hash-provider-owned",
		SourceAgentSessionID: "source", TargetAgentSessionID: "target-provider-owned",
		SourceTurnID: "turn-1", DriverKind: "claude-agent-sdk-session-fork",
		DriverVersion: "0.3.201/sidecar-v3", OccurredAtUnixMS: 500,
	}
	operation, _, err := prepareSessionForkForTest(t, store, ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	if operation.TargetTitle == "" {
		t.Fatal("prepared operation omitted the frozen target title")
	}
	if _, _, err := store.MarkSessionForkDispatching(
		ctx, input.WorkspaceID, input.OperationID, 501,
	); err != nil {
		t.Fatal(err)
	}
	operation, _, err = store.RecordSessionForkProviderResult(
		ctx,
		SessionForkProviderResult{
			WorkspaceID: input.WorkspaceID, OperationID: input.OperationID,
			Status:                  SessionForkStatusProviderAccepted,
			TargetProviderSessionID: "claude-child",
			TargetProviderTurnIDs:   []string{"claude-child-turn-1"},
			StateBindingMode:        "provider_owned",
			StateBindingReceipt:     "claude-sdk-fork-v1:receipt",
			OccurredAtUnixMS:        502,
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if operation.StateBindingMode != "provider_owned" ||
		operation.StateBindingReceipt == "" ||
		!reflect.DeepEqual(
			operation.TargetProviderTurnIDs,
			[]string{"claude-child-turn-1"},
		) {
		t.Fatalf("provider acceptance evidence=%#v", operation)
	}
	result, err := store.CommitSessionFork(ctx, input.WorkspaceID, input.OperationID, 503)
	if err != nil {
		t.Fatal(err)
	}
	turn, found, err := store.GetTurn(
		ctx,
		input.WorkspaceID,
		input.TargetAgentSessionID,
		result.Lineage.TargetTurnID,
	)
	if err != nil || !found {
		t.Fatalf("GetTurn() found=%v error=%v", found, err)
	}
	if turn.RootProviderTurnID != "claude-child-turn-1" {
		t.Fatalf(
			"child root provider turn id=%q, want remapped Claude UUID",
			turn.RootProviderTurnID,
		)
	}
}

func TestSessionForkTitlesIncrementPerSourceSession(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	seedForkSession(t, store)
	if _, updated, err := store.UpdateSessionTitle(
		ctx,
		"ws-1",
		"source",
		"123",
	); err != nil || !updated {
		t.Fatalf("UpdateSessionTitle() updated=%v error=%v", updated, err)
	}
	first := commitFork(t, store, SessionForkPrepare{
		OperationID: "fork-title-1", WorkspaceID: "ws-1",
		RequestID: "request-title-1", RequestHash: "hash-title-1",
		SourceAgentSessionID: "source", TargetAgentSessionID: "target-title-1",
		SourceTurnID: "turn-1", DriverKind: "codex", DriverVersion: "1",
		OccurredAtUnixMS: 100,
	})
	if first.Session.Title != "123 (2)" {
		t.Fatalf("first Fork title=%q, want %q", first.Session.Title, "123 (2)")
	}
	if _, found, changed, err := store.AcknowledgeSessionForkOperation(
		ctx,
		"ws-1",
		"fork-title-1",
		104,
	); err != nil || !found || !changed {
		t.Fatalf(
			"AcknowledgeSessionForkOperation() found=%v changed=%v error=%v",
			found,
			changed,
			err,
		)
	}
	second := commitFork(t, store, SessionForkPrepare{
		OperationID: "fork-title-2", WorkspaceID: "ws-1",
		RequestID: "request-title-2", RequestHash: "hash-title-2",
		SourceAgentSessionID: "source", TargetAgentSessionID: "target-title-2",
		SourceTurnID: "turn-2", DriverKind: "codex", DriverVersion: "1",
		OccurredAtUnixMS: 200,
	})
	if second.Session.Title != "123 (3)" {
		t.Fatalf("second Fork title=%q, want %q", second.Session.Title, "123 (3)")
	}
}

func TestSessionForkV1SnapshotMaterializesSourceRuntimeContext(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := t.Context()
	seedForkSession(t, store)
	if _, err := store.db.ExecContext(ctx, `
UPDATE workspace_agent_sessions
SET cwd = '/legacy/project',
    settings_json = '{"model":"legacy-model","permissionModeId":"legacy-mode"}',
    internal_runtime_context_json = '{"legacyRuntime":true}'
WHERE workspace_id = 'ws-1' AND agent_session_id = 'source'
`); err != nil {
		t.Fatal(err)
	}
	operation, _, err := prepareSessionForkForTest(t, store, ctx, SessionForkPrepare{
		OperationID: "legacy-fork", WorkspaceID: "ws-1", RequestID: "legacy-request",
		RequestHash: "legacy-hash", SourceAgentSessionID: "source",
		TargetAgentSessionID: "legacy-target", SourceTurnID: "turn-1",
		DriverKind: "codex-app-server", DriverVersion: "1", OccurredAtUnixMS: 300,
	})
	if err != nil {
		t.Fatal(err)
	}
	var snapshotJSON string
	if err := store.db.QueryRowContext(ctx, `
SELECT snapshot_json
FROM workspace_agent_session_fork_operations
WHERE operation_id = 'legacy-fork'
`).Scan(&snapshotJSON); err != nil {
		t.Fatal(err)
	}
	var snapshot sessionForkSnapshot
	if err := json.Unmarshal([]byte(snapshotJSON), &snapshot); err != nil {
		t.Fatal(err)
	}
	type legacySessionForkSnapshot struct {
		Version           int                       `json:"version"`
		BoundaryMessageID int64                     `json:"boundaryMessageId"`
		Session           Session                   `json:"session"`
		Turns             []sessionForkTurnSnapshot `json:"turns"`
		Messages          []Message                 `json:"messages"`
		Interactions      []Interaction             `json:"interactions"`
	}
	legacySnapshot := legacySessionForkSnapshot{
		Version:           1,
		BoundaryMessageID: snapshot.BoundaryMessageID,
		Session:           snapshot.Session,
		Turns:             snapshot.Turns,
		Messages:          snapshot.Messages,
		Interactions:      snapshot.Interactions,
	}
	legacyJSON, err := json.Marshal(legacySnapshot)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.ExecContext(ctx, `
UPDATE workspace_agent_session_fork_operations
SET snapshot_json = ?, snapshot_hash = ?
WHERE operation_id = 'legacy-fork'
`, string(legacyJSON), hashSessionForkBytes(legacyJSON)); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.MarkSessionForkDispatching(
		ctx, "ws-1", operation.OperationID, 301,
	); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.RecordSessionForkProviderResult(
		ctx,
		SessionForkProviderResult{
			WorkspaceID: "ws-1", OperationID: operation.OperationID,
			Status: SessionForkStatusProviderAccepted, TargetProviderSessionID: "legacy-child",
			OccurredAtUnixMS: 302,
		},
	); err != nil {
		t.Fatal(err)
	}
	committed, err := store.CommitSessionFork(ctx, "ws-1", operation.OperationID, 303)
	if err != nil {
		t.Fatal(err)
	}
	if committed.Session.Cwd != "/legacy/project" ||
		committed.Session.Settings["permissionModeId"] != "legacy-mode" ||
		committed.Session.InternalRuntimeContext["legacyRuntime"] != true {
		t.Fatalf("materialized legacy child=%#v", committed.Session)
	}
}

func TestSessionForkCanonicalIdentityRemapIsDeterministicAndReferenceSafe(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	seedForkSession(t, store)
	if _, err := store.ReportSessionMessages(ctx, SessionMessageReport{
		WorkspaceID: "ws-1", AgentSessionID: "source", Origin: "runtime",
		Messages: []MessageUpdate{{
			MessageID: "message-1", TurnID: "turn-1",
			Role: "assistant", Kind: "text", Status: "completed",
			Payload: map[string]any{
				"kind":            "agent_system_notice",
				"noticeKind":      "plan_implementation_completed",
				"planTurnId":      "turn-1",
				"confirmedTurnId": "turn-1",
				"sourceSessionId": "source",
				"providerTurnId":  "provider-turn-1",
				"content":         "source turn-1 message-1 request-1",
				"structuredOutput": map[string]any{
					"agentSessionId": "source",
					"turnId":         "turn-1",
					"messageId":      "message-1",
					"requestId":      "request-1",
				},
			},
			OccurredAtUnixMS: 13,
		}},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.ExecContext(ctx, `
UPDATE workspace_agent_turns
SET completed_command_json = ?
WHERE workspace_id = 'ws-1' AND agent_session_id = 'source' AND turn_id = 'turn-1'
`, encodeCompletedCommandJSON("", "", finalAssistantWatermark{
		MessageID: "message-1",
		Resolved:  true,
	})); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.ExecContext(ctx, `
INSERT INTO workspace_agent_interactions (
  workspace_id, agent_session_id, request_id, turn_id, kind, status,
  tool_name, input_json, output_json, metadata_json,
  created_at_unix_ms, updated_at_unix_ms
) VALUES ('ws-1', 'source', 'request-1', 'turn-1', 'approval', 'answered', '',
          '{"requestId":"request-1","toolCall":{"input":{"turnId":"turn-1","requestId":"request-1","messageId":"message-1"}},"content":"turn-1 request-1"}',
          '{"requestId":"request-1","payload":{"turnId":"turn-1","requestId":"request-1","messageId":"message-1"}}',
          '{"providerTurnId":"provider-turn-1","structured":{"agentSessionId":"source","turnId":"turn-1","requestId":"request-1"}}',
          12, 13)
`); err != nil {
		t.Fatal(err)
	}

	input := SessionForkPrepare{
		OperationID: "fork-remap", WorkspaceID: "ws-1", RequestID: "request-remap",
		RequestHash: "hash-remap", SourceAgentSessionID: "source",
		TargetAgentSessionID: "target-remap", SourceTurnID: "turn-1",
		DriverKind: "codex", DriverVersion: "1", OccurredAtUnixMS: 100,
	}
	result := commitFork(t, store, input)
	expectedTurnID := deterministicSessionForkCanonicalID(result.Operation, "turn", "turn-1")
	expectedMessageID := deterministicSessionForkCanonicalID(result.Operation, "message", "message-1")
	expectedRequestID := deterministicSessionForkCanonicalID(
		result.Operation,
		"interaction",
		"turn-1\x00request-1",
	)
	if expectedTurnID == "turn-1" || expectedMessageID == "message-1" ||
		expectedRequestID == "request-1" {
		t.Fatal("fork canonical identities were not isolated from the source")
	}

	turns, err := store.ListSessionTurns(ctx, "ws-1", "target-remap")
	if err != nil || len(turns) != 1 ||
		turns[0].TurnID != expectedTurnID ||
		turns[0].FinalAssistantMessageID != expectedMessageID {
		t.Fatalf("forked turns=%#v error=%v", turns, err)
	}
	page, found, err := store.ListSessionMessages(ctx, ListSessionMessagesInput{
		WorkspaceID: "ws-1", AgentSessionID: "target-remap", Limit: 10,
	})
	if err != nil || !found || len(page.Messages) != 1 {
		t.Fatalf("forked messages=%#v found=%v error=%v", page.Messages, found, err)
	}
	message := page.Messages[0]
	if message.MessageID != expectedMessageID || message.TurnID != expectedTurnID {
		t.Fatalf("forked message identity=%#v", message)
	}
	if message.Payload["planTurnId"] != expectedTurnID ||
		message.Payload["confirmedTurnId"] != expectedTurnID ||
		message.Payload["kind"] != "agent_system_notice" {
		t.Fatalf("forked message canonical refs=%#v", message.Payload)
	}
	structuredOutput, ok := message.Payload["structuredOutput"].(map[string]any)
	if !ok ||
		structuredOutput["agentSessionId"] != "source" ||
		structuredOutput["turnId"] != "turn-1" ||
		structuredOutput["messageId"] != "message-1" ||
		structuredOutput["requestId"] != "request-1" {
		t.Fatalf("structured output was rewritten=%#v", message.Payload["structuredOutput"])
	}
	if message.Payload["sourceSessionId"] != "source" ||
		message.Payload["providerTurnId"] != "provider-turn-1" ||
		message.Payload["content"] != "source turn-1 message-1 request-1" {
		t.Fatalf("non-canonical payload text was rewritten: %#v", message.Payload)
	}

	interactions, err := store.ListSessionInteractions(ctx, ListSessionInteractionsInput{
		WorkspaceID: "ws-1", AgentSessionID: "target-remap",
	})
	if err != nil || len(interactions) != 1 {
		t.Fatalf("forked interactions=%#v error=%v", interactions, err)
	}
	interaction := interactions[0]
	if interaction.TurnID != expectedTurnID ||
		interaction.RequestID != expectedRequestID ||
		interaction.Input["requestId"] != expectedRequestID ||
		interaction.Input["content"] != "turn-1 request-1" ||
		interaction.Output["requestId"] != expectedRequestID ||
		interaction.Metadata["providerTurnId"] != "provider-turn-1" {
		t.Fatalf("forked interaction=%#v", interaction)
	}
	toolCall := interaction.Input["toolCall"].(map[string]any)
	toolInput := toolCall["input"].(map[string]any)
	answerPayload := interaction.Output["payload"].(map[string]any)
	metadataStructured := interaction.Metadata["structured"].(map[string]any)
	if toolInput["turnId"] != "turn-1" ||
		toolInput["requestId"] != "request-1" ||
		toolInput["messageId"] != "message-1" ||
		answerPayload["turnId"] != "turn-1" ||
		answerPayload["requestId"] != "request-1" ||
		answerPayload["messageId"] != "message-1" ||
		metadataStructured["agentSessionId"] != "source" ||
		metadataStructured["turnId"] != "turn-1" ||
		metadataStructured["requestId"] != "request-1" {
		t.Fatalf("interaction structured payload was rewritten=%#v", interaction)
	}
	sourceTurns, err := store.ListSessionTurns(ctx, "ws-1", "source")
	if err != nil || len(sourceTurns) != 2 ||
		sourceTurns[0].TurnID != "turn-1" ||
		sourceTurns[0].FinalAssistantMessageID != "message-1" {
		t.Fatalf("source turns changed=%#v error=%v", sourceTurns, err)
	}
	sourceInteractions, err := store.ListSessionInteractions(ctx, ListSessionInteractionsInput{
		WorkspaceID: "ws-1", AgentSessionID: "source",
	})
	if err != nil || len(sourceInteractions) != 1 ||
		sourceInteractions[0].TurnID != "turn-1" ||
		sourceInteractions[0].RequestID != "request-1" {
		t.Fatalf("source interactions changed=%#v error=%v", sourceInteractions, err)
	}

	replayed, err := store.CommitSessionFork(ctx, "ws-1", "fork-remap", 104)
	if err != nil || replayed.Changed {
		t.Fatalf("CommitSessionFork(replay) result=%#v error=%v", replayed, err)
	}
	replayedTurns, err := store.ListSessionTurns(ctx, "ws-1", "target-remap")
	if err != nil || len(replayedTurns) != 1 || replayedTurns[0].TurnID != expectedTurnID {
		t.Fatalf("replayed fork identities changed=%#v error=%v", replayedTurns, err)
	}
}

func TestSessionForkCanonicalIdentityMapFailsClosed(t *testing.T) {
	t.Parallel()
	operation := SessionForkOperation{
		OperationID: "fork-map", WorkspaceID: "ws-1",
		SourceAgentSessionID: "source", TargetAgentSessionID: "target",
	}
	duplicateTurns := sessionForkSnapshot{
		Turns: []sessionForkTurnSnapshot{
			{Turn: Turn{TurnID: "turn-1"}},
			{Turn: Turn{TurnID: "turn-1"}},
		},
	}
	if _, err := buildSessionForkCanonicalIdentityMap(operation, duplicateTurns); err == nil {
		t.Fatal("duplicate source turn identities unexpectedly produced a mapping")
	}
	danglingMessageTurn := sessionForkSnapshot{
		Turns: []sessionForkTurnSnapshot{{Turn: Turn{TurnID: "turn-1"}}},
		Messages: []Message{{
			MessageID: "message-1",
			TurnID:    "turn-outside-prefix",
		}},
	}
	if _, err := buildSessionForkCanonicalIdentityMap(operation, danglingMessageTurn); err == nil {
		t.Fatal("message with an unmapped canonical turn unexpectedly produced a mapping")
	}
	first := deterministicSessionForkCanonicalID(operation, "turn", "turn-1")
	if again := deterministicSessionForkCanonicalID(operation, "turn", "turn-1"); again != first {
		t.Fatalf("canonical identity is not deterministic: first=%q again=%q", first, again)
	}
	otherTarget := operation
	otherTarget.TargetAgentSessionID = "other-target"
	if deterministicSessionForkCanonicalID(otherTarget, "turn", "turn-1") == first {
		t.Fatal("canonical identity was not isolated by target session")
	}
	otherSource := operation
	otherSource.SourceAgentSessionID = "other-source"
	if deterministicSessionForkCanonicalID(otherSource, "turn", "turn-1") == first {
		t.Fatal("canonical identity was not isolated by source session")
	}
}

func TestSessionForkTypedRemapLeavesStructuredToolOutputUnchanged(t *testing.T) {
	t.Parallel()
	operation := SessionForkOperation{
		OperationID: "fork-typed-output", WorkspaceID: "ws-1",
		SourceAgentSessionID: "source", TargetAgentSessionID: "target",
	}
	message := Message{
		MessageID: "message-1",
		TurnID:    "turn-1",
		Kind:      "tool_call",
		Payload: map[string]any{
			"callType":  "interactive",
			"requestId": "request-1",
			"input": map[string]any{
				"turnId":    "turn-1",
				"messageId": "message-1",
				"requestId": "request-1",
			},
			"output": map[string]any{
				"requestId": "request-1",
				"payload": map[string]any{
					"turnId":         "turn-1",
					"messageId":      "message-1",
					"requestId":      "request-1",
					"agentSessionId": "source",
				},
			},
		},
	}
	snapshot := sessionForkSnapshot{
		Turns:    []sessionForkTurnSnapshot{{Turn: Turn{TurnID: "turn-1"}}},
		Messages: []Message{message},
		Interactions: []Interaction{{
			TurnID: "turn-1", RequestID: "request-1", Kind: InteractionKindQuestion,
		}},
	}
	identityMap, err := buildSessionForkCanonicalIdentityMap(operation, snapshot)
	if err != nil {
		t.Fatal(err)
	}
	remapped, err := remapSessionForkMessage(message, identityMap)
	if err != nil {
		t.Fatal(err)
	}
	expectedRequestID := identityMap.InteractionIDs[sessionForkInteractionRef{
		TurnID: "turn-1", RequestID: "request-1",
	}]
	if remapped.Payload["requestId"] != expectedRequestID {
		t.Fatalf("root requestId=%#v want=%q", remapped.Payload["requestId"], expectedRequestID)
	}
	output := remapped.Payload["output"].(map[string]any)
	if output["requestId"] != expectedRequestID {
		t.Fatalf("output requestId=%#v want=%q", output["requestId"], expectedRequestID)
	}
	input := remapped.Payload["input"].(map[string]any)
	structured := output["payload"].(map[string]any)
	if input["turnId"] != "turn-1" ||
		input["messageId"] != "message-1" ||
		input["requestId"] != "request-1" ||
		structured["turnId"] != "turn-1" ||
		structured["messageId"] != "message-1" ||
		structured["requestId"] != "request-1" ||
		structured["agentSessionId"] != "source" {
		t.Fatalf("structured tool data was rewritten: input=%#v output=%#v", input, structured)
	}
}

func TestSessionForkTypedRemapRejectsDanglingCanonicalReference(t *testing.T) {
	t.Parallel()
	operation := SessionForkOperation{
		OperationID: "fork-dangling-ref", WorkspaceID: "ws-1",
		SourceAgentSessionID: "source", TargetAgentSessionID: "target",
	}
	message := Message{
		MessageID: "message-1",
		TurnID:    "turn-1",
		Kind:      "text",
		Payload: map[string]any{
			"kind":            "agent_system_notice",
			"noticeKind":      "plan_implementation_completed",
			"confirmedTurnId": "turn-outside-prefix",
		},
	}
	snapshot := sessionForkSnapshot{
		Turns:    []sessionForkTurnSnapshot{{Turn: Turn{TurnID: "turn-1"}}},
		Messages: []Message{message},
	}
	identityMap, err := buildSessionForkCanonicalIdentityMap(operation, snapshot)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := remapSessionForkMessage(message, identityMap); err == nil ||
		!strings.Contains(err.Error(), `"confirmedTurnId"="turn-outside-prefix"`) {
		t.Fatalf("dangling typed canonical reference error=%v", err)
	}
}

func TestCheckSessionForkThroughTurnReturnsOrderedProviderTurnPrefix(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	seedForkSession(t, store)
	boundary, supported, err := store.CheckSessionForkThroughTurn(
		ctx,
		"ws-1",
		"source",
		"turn-2",
	)
	if err != nil || !supported {
		t.Fatalf("CheckSessionForkThroughTurn() supported=%v error=%v", supported, err)
	}
	want := []string{"provider-turn-1", "provider-turn-2"}
	if len(boundary.RootProviderTurnIDs) != len(want) {
		t.Fatalf("provider turn prefix=%v want=%v", boundary.RootProviderTurnIDs, want)
	}
	for index := range want {
		if boundary.RootProviderTurnIDs[index] != want[index] {
			t.Fatalf("provider turn prefix=%v want=%v", boundary.RootProviderTurnIDs, want)
		}
	}
	if _, err := store.db.ExecContext(ctx, `
UPDATE workspace_agent_turns
SET root_provider_turn_id = 'provider-turn-1'
WHERE workspace_id = 'ws-1' AND agent_session_id = 'source' AND turn_id = 'turn-2'
`); err != nil {
		t.Fatal(err)
	}
	if boundary, supported, err := store.CheckSessionForkThroughTurn(
		ctx,
		"ws-1",
		"source",
		"turn-2",
	); err != nil || supported || len(boundary.RootProviderTurnIDs) != 0 ||
		boundary.RejectionReason != SessionForkBoundaryReasonProviderTurnDuplicate {
		t.Fatalf(
			"duplicate provider turn prefix boundary=%#v supported=%v error=%v",
			boundary,
			supported,
			err,
		)
	}
}

func TestListSessionForkTurnIdentitiesReturnsCanonicalSequence(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	seedForkSession(t, store)

	identities, err := store.ListSessionForkTurnIdentities(ctx, "ws-1", "source")
	if err != nil {
		t.Fatalf("ListSessionForkTurnIdentities() error=%v", err)
	}
	want := []SessionForkTurnIdentity{
		{
			TurnID:         "turn-1",
			ProviderTurnID: "provider-turn-1",
			Phase:          TurnPhaseSettled,
		},
		{
			TurnID:         "turn-2",
			ProviderTurnID: "provider-turn-2",
			Phase:          TurnPhaseSettled,
		},
	}
	if len(identities) != len(want) {
		t.Fatalf("ListSessionForkTurnIdentities()=%#v want=%#v", identities, want)
	}
	for index := range want {
		if identities[index] != want[index] {
			t.Fatalf(
				"ListSessionForkTurnIdentities()[%d]=%#v want=%#v",
				index,
				identities[index],
				want[index],
			)
		}
	}
}

func TestSessionForkThroughTurnFailsClosedForUnverifiedBoundary(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	seedForkSession(t, store)
	ctx := context.Background()
	if _, err := store.db.ExecContext(ctx, `
UPDATE workspace_agent_turn_sequences
SET provenance = 'legacy_unverified'
WHERE workspace_id = 'ws-1' AND agent_session_id = 'source' AND turn_id = 'turn-1'
`); err != nil {
		t.Fatal(err)
	}
	if boundary, supported, err := store.CheckSessionForkThroughTurn(
		ctx, "ws-1", "source", "turn-1",
	); err != nil || supported ||
		boundary.RejectionReason != SessionForkBoundaryReasonTurnSequenceUnverified {
		t.Fatalf(
			"CheckSessionForkThroughTurn() boundary=%#v supported=%v error=%v",
			boundary,
			supported,
			err,
		)
	}
	if _, _, err := prepareSessionForkForTest(t, store, ctx, SessionForkPrepare{
		OperationID: "fork-op", WorkspaceID: "ws-1", RequestID: "request-1",
		RequestHash: "hash-1", SourceAgentSessionID: "source",
		TargetAgentSessionID: "target", SourceTurnID: "turn-1",
		DriverKind: "codex", DriverVersion: "1", OccurredAtUnixMS: 100,
	}); !errors.Is(err, ErrSessionForkTurnState) ||
		sessionForkBoundaryReasonForTest(err) != SessionForkBoundaryReasonTurnSequenceUnverified ||
		!strings.Contains(err.Error(), `provenance is "legacy_unverified"`) {
		t.Fatalf("PrepareSessionFork() error=%v", err)
	}
}

func TestSessionForkThroughTurnFailsClosedForLocalAttachmentReferences(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	seedForkSession(t, store)
	if _, err := store.ReportSessionMessages(ctx, SessionMessageReport{
		WorkspaceID: "ws-1", AgentSessionID: "source", Origin: "runtime",
		Messages: []MessageUpdate{{
			MessageID: "message-1", TurnID: "turn-1", Role: "user",
			Kind: "text", Status: "completed",
			Payload: map[string]any{"content": []any{map[string]any{
				"type": "image", "mimeType": "image/png",
				"attachmentId": "attachment-before-boundary",
			}}},
			OccurredAtUnixMS: 13,
		}},
	}); err != nil {
		t.Fatal(err)
	}
	if boundary, supported, err := store.CheckSessionForkThroughTurn(
		ctx, "ws-1", "source", "turn-1",
	); err != nil || supported ||
		boundary.RejectionReason != SessionForkBoundaryReasonAttachmentUnsupported {
		t.Fatalf(
			"CheckSessionForkThroughTurn() boundary=%#v supported=%v error=%v",
			boundary,
			supported,
			err,
		)
	}
	if _, _, err := prepareSessionForkForTest(t, store, ctx, SessionForkPrepare{
		OperationID: "fork-attachment", WorkspaceID: "ws-1",
		RequestID: "request-attachment", RequestHash: "hash-attachment",
		SourceAgentSessionID: "source", TargetAgentSessionID: "target-attachment",
		SourceTurnID: "turn-1", DriverKind: "codex", DriverVersion: "1",
		OccurredAtUnixMS: 100,
	}); !errors.Is(err, ErrSessionForkTurnState) ||
		sessionForkBoundaryReasonForTest(err) != SessionForkBoundaryReasonAttachmentUnsupported {
		t.Fatalf("PrepareSessionFork() error=%v", err)
	}
}

func TestSessionForkThroughTurnIgnoresAttachmentReferencesAfterBoundary(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	seedForkSession(t, store)
	if _, err := store.ReportSessionMessages(ctx, SessionMessageReport{
		WorkspaceID: "ws-1", AgentSessionID: "source", Origin: "runtime",
		Messages: []MessageUpdate{{
			MessageID: "message-2", TurnID: "turn-2", Role: "user",
			Kind: "text", Status: "completed",
			Payload: map[string]any{"content": []any{map[string]any{
				"type": "image", "mimeType": "image/png",
				"attachmentId": "attachment-after-boundary",
			}}},
			OccurredAtUnixMS: 23,
		}},
	}); err != nil {
		t.Fatal(err)
	}
	if _, supported, err := store.CheckSessionForkThroughTurn(
		ctx, "ws-1", "source", "turn-1",
	); err != nil || !supported {
		t.Fatalf("CheckSessionForkThroughTurn() supported=%v error=%v", supported, err)
	}
	if _, _, err := prepareSessionForkForTest(t, store, ctx, SessionForkPrepare{
		OperationID: "fork-before-attachment", WorkspaceID: "ws-1",
		RequestID:            "request-before-attachment",
		RequestHash:          "hash-before-attachment",
		SourceAgentSessionID: "source",
		TargetAgentSessionID: "target-before-attachment",
		SourceTurnID:         "turn-1", DriverKind: "codex", DriverVersion: "1",
		OccurredAtUnixMS: 100,
	}); err != nil {
		t.Fatalf("PrepareSessionFork() error=%v", err)
	}
}

func TestSessionForkPrepareRejectsSourceDriftBeforeFence(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	seedForkSession(t, store)
	source, found, err := store.GetSession(ctx, "ws-1", "source")
	if err != nil || !found {
		t.Fatalf("GetSession() found=%v error=%v", found, err)
	}
	staleHash, err := SessionForkSourceHash(source)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.UpdateSessionTitle(
		ctx, "ws-1", "source", "changed before prepare",
	); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.PrepareSessionFork(ctx, SessionForkPrepare{
		OperationID: "fork-stale-source", WorkspaceID: "ws-1",
		RequestID: "request-stale-source", RequestHash: "hash-stale-source",
		SourceAgentSessionID: "source",
		TargetAgentSessionID: "target-stale-source",
		SourceTurnID:         "turn-1", DriverKind: "codex", DriverVersion: "1",
		ExpectedSourceHash: staleHash, OccurredAtUnixMS: 100,
	}); !errors.Is(err, ErrSessionForkSourceState) {
		t.Fatalf("PrepareSessionFork() error=%v", err)
	}
}

func TestSessionForkSnapshotUsesPresentationOrderAndIncludesSessionAudit(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	seedForkSession(t, store)
	if _, err := store.ReportSessionMessages(ctx, SessionMessageReport{
		WorkspaceID: "ws-1", AgentSessionID: "source", Origin: "runtime",
		Messages: []MessageUpdate{{
			MessageID: "audit-1", Role: "system", Kind: "session_audit",
			Status: "completed", OccurredAtUnixMS: 31,
		}},
	}); err != nil {
		t.Fatal(err)
	}
	appendSettledForkTurn(t, store, "turn-3", 40)
	if _, err := store.db.ExecContext(ctx, `
UPDATE workspace_agent_messages
SET version = CASE message_id
  WHEN 'message-1' THEN 99
  WHEN 'message-2' THEN 1
  ELSE version
END
WHERE workspace_id = 'ws-1' AND agent_session_id = 'source'
`); err != nil {
		t.Fatal(err)
	}
	commitFork(t, store, SessionForkPrepare{
		OperationID: "fork-order", WorkspaceID: "ws-1", RequestID: "request-order",
		RequestHash: "hash-order", SourceAgentSessionID: "source",
		TargetAgentSessionID: "target-order", SourceTurnID: "turn-3",
		DriverKind: "codex", DriverVersion: "1", OccurredAtUnixMS: 100,
	})
	page, found, err := store.ListSessionMessages(ctx, ListSessionMessagesInput{
		WorkspaceID: "ws-1", AgentSessionID: "target-order", Limit: 10,
	})
	if err != nil || !found {
		t.Fatalf("ListSessionMessages() found=%v error=%v", found, err)
	}
	got := make([]string, 0, len(page.Messages))
	for _, message := range page.Messages {
		got = append(got, message.MessageID)
	}
	operation := SessionForkOperation{
		OperationID: "fork-order", WorkspaceID: "ws-1",
		SourceAgentSessionID: "source", TargetAgentSessionID: "target-order",
	}
	wantSources := []string{"message-1", "message-2", "audit-1", "message-3"}
	want := make([]string, len(wantSources))
	for index, sourceMessageID := range wantSources {
		want[index] = deterministicSessionForkCanonicalID(
			operation,
			"message",
			sourceMessageID,
		)
	}
	if len(got) != len(want) {
		t.Fatalf("forked message order=%v want=%v", got, want)
	}
	for index := range want {
		if got[index] != want[index] || page.Messages[index].Version != uint64(index+1) {
			t.Fatalf("forked message order=%v want=%v", got, want)
		}
	}
}

func TestSessionForkSourceFenceBlocksWritesAndLifecycleUntilTerminal(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	seedForkSession(t, store)
	prepare := SessionForkPrepare{
		OperationID: "fork-fence", WorkspaceID: "ws-1", RequestID: "request-fence",
		RequestHash: "hash-fence", SourceAgentSessionID: "source",
		TargetAgentSessionID: "target-fence", SourceTurnID: "turn-1",
		DriverKind: "codex", DriverVersion: "1", OccurredAtUnixMS: 100,
	}
	if _, changed, err := prepareSessionForkForTest(t, store, ctx, prepare); err != nil || !changed {
		t.Fatalf("PrepareSessionFork() changed=%v error=%v", changed, err)
	}
	if _, err := store.ReportSessionState(ctx, SessionStateReport{
		WorkspaceID: "ws-1", AgentSessionID: "source", Provider: "codex",
		OccurredAtUnixMS: 101,
	}); !errors.Is(err, ErrSessionForkInProgress) {
		t.Fatalf("ReportSessionState() error=%v", err)
	}
	if _, _, err := store.PrepareRuntimeOperation(ctx, RuntimeOperationPrepare{
		OperationID: "runtime-after-fork", WorkspaceID: "ws-1",
		AgentSessionID: "source", TurnID: "turn-2",
		Kind: RuntimeOperationKindCancelTurn,
		Payload: map[string]any{
			"rootAgentSessionId": "source",
			"targets": []any{map[string]any{
				"agentSessionId": "source", "turnId": "turn-2",
			}},
		},
		OccurredAtMS: 101,
	}); !errors.Is(err, ErrSessionForkInProgress) {
		t.Fatalf("PrepareRuntimeOperation() error=%v", err)
	}
	if _, err := store.PutGoalReconcileInbox(ctx, GoalReconcileInboxItem{
		RequestID: "inbox-after-fork", WorkspaceID: "ws-1",
		AgentSessionID:  "source",
		Payload:         map[string]any{"phase": goalReconcilePhasePending},
		CreatedAtUnixMS: 101,
	}); !errors.Is(err, ErrSessionForkInProgress) {
		t.Fatalf("PutGoalReconcileInbox() error=%v", err)
	}
	if _, _, err := store.UpdateSessionSettings(
		ctx,
		"ws-1",
		"source",
		"gpt-5",
		map[string]any{"reasoningEffort": "high"},
	); !errors.Is(err, ErrSessionForkInProgress) {
		t.Fatalf("UpdateSessionSettings() error=%v", err)
	}
	if _, updated, err := store.UpdateSessionTitle(
		ctx,
		"ws-1",
		"source",
		"title may change while fork is live",
	); err != nil || !updated {
		t.Fatalf("UpdateSessionTitle() updated=%v error=%v", updated, err)
	}
	if _, updated, err := store.UpdateSessionPinned(
		ctx,
		"ws-1",
		"source",
		true,
	); err != nil || !updated {
		t.Fatalf("UpdateSessionPinned() updated=%v error=%v", updated, err)
	}
	if _, _, _, err := store.PrepareGoalControlOperation(ctx, GoalControlOperationPrepare{
		OperationID: "goal-after-fork", WorkspaceID: "ws-1",
		AgentSessionID: "source", Action: "set", Objective: "ship",
		OccurredAtUnixMS: 101,
	}); !errors.Is(err, ErrSessionForkInProgress) {
		t.Fatalf("PrepareGoalControlOperation() error=%v", err)
	}
	if _, _, err := store.PrepareSubmitClaim(ctx, SubmitClaimPrepare{
		WorkspaceID: "ws-1", AgentSessionID: "source",
		ClientSubmitID: "submit-after-fork", CanonicalTurnID: "turn-after-fork",
		NowUnixMS: 101,
	}); !errors.Is(err, ErrSessionForkInProgress) {
		t.Fatalf("PrepareSubmitClaim() error=%v", err)
	}
	blocking, created, err := prepareSessionForkForTest(t, store, ctx, SessionForkPrepare{
		OperationID: "fork-other", WorkspaceID: "ws-1", RequestID: "request-other",
		RequestHash: "hash-other", SourceAgentSessionID: "source",
		TargetAgentSessionID: "target-other", SourceTurnID: "turn-1",
		DriverKind: "codex", DriverVersion: "1", OccurredAtUnixMS: 101,
	})
	if err != nil || created || blocking.OperationID != "fork-fence" {
		t.Fatalf(
			"second PrepareSessionFork() operation=%#v created=%v error=%v",
			blocking,
			created,
			err,
		)
	}
	if _, err := store.PlanDeleteSessions(ctx, DeleteSessionsBatchInput{
		WorkspaceID: "ws-1", SessionIDs: []string{"source"},
	}); !errors.Is(err, ErrSessionForkInProgress) {
		t.Fatalf("PlanDeleteSessions(source) error=%v", err)
	}
	if _, err := store.PlanDeleteSessions(ctx, DeleteSessionsBatchInput{
		WorkspaceID: "ws-1", SessionIDs: []string{"target-fence"},
	}); !errors.Is(err, ErrSessionForkTargetReserved) {
		t.Fatalf("PlanDeleteSessions(target) error=%v", err)
	}
	if _, _, err := store.MarkSessionForkDispatching(ctx, "ws-1", "fork-fence", 102); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.RecordSessionForkProviderResult(ctx, SessionForkProviderResult{
		WorkspaceID: "ws-1", OperationID: "fork-fence",
		Status: SessionForkStatusProviderAccepted, TargetProviderSessionID: "provider-target-fence",
		OccurredAtUnixMS: 103,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReportSessionState(ctx, SessionStateReport{
		WorkspaceID: "ws-1", AgentSessionID: "source", Provider: "codex",
		OccurredAtUnixMS: 104,
	}); !errors.Is(err, ErrSessionForkInProgress) {
		t.Fatalf("ReportSessionState(provider accepted) error=%v", err)
	}
	if _, err := store.CommitSessionFork(ctx, "ws-1", "fork-fence", 105); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReportSessionState(ctx, SessionStateReport{
		WorkspaceID: "ws-1", AgentSessionID: "source", Provider: "codex",
		ProviderSessionID: "provider-source", OccurredAtUnixMS: 106,
	}); err != nil {
		t.Fatalf("ReportSessionState(after commit) error=%v", err)
	}
}

func TestSessionForkSourceFenceBlocksRootTurnPatchFromChildReport(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	if _, err := store.ReportSessionState(ctx, SessionStateReport{
		WorkspaceID: "ws-1", AgentSessionID: "source", Kind: SessionKindRoot,
		Origin: "runtime", Provider: "codex", ProviderSessionID: "provider-source",
		Status: "ready", CurrentPhase: "idle", OccurredAtUnixMS: 1,
	}); err != nil {
		t.Fatal(err)
	}
	appendSettledForkTurn(t, store, "turn-1", 10)
	if _, err := store.ReportActivityState(ctx, ActivityStateReport{
		Session: SessionStateReport{
			WorkspaceID: "ws-1", AgentSessionID: "source", Kind: SessionKindRoot,
			Origin: "runtime", Provider: "codex", ProviderSessionID: "provider-source",
			Status: "active", CurrentPhase: "working", OccurredAtUnixMS: 20,
		},
		Turn: &TurnTransition{
			WorkspaceID: "ws-1", AgentSessionID: "source", TurnID: "turn-2",
			Phase: TurnPhaseRunning, OccurredAtUnixMS: 20,
		},
		RootProviderTurn: &RootProviderTurnTransition{
			WorkspaceID: "ws-1", RootAgentSessionID: "source", RootTurnID: "turn-2",
			ProviderTurnID: "provider-turn-2", Phase: RootProviderTurnPhaseRunning,
			OccurredAtUnixMS: 20,
		},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReportSessionState(ctx, SessionStateReport{
		WorkspaceID:          "ws-1",
		AgentSessionID:       "child",
		Kind:                 SessionKindChild,
		RootAgentSessionID:   "source",
		RootTurnID:           "turn-2",
		ParentAgentSessionID: "source",
		ParentTurnID:         "turn-2",
		ParentToolCallID:     "tool-child",
		Origin:               "runtime",
		Provider:             "codex",
		ProviderSessionID:    "provider-child",
		OccurredAtUnixMS:     50,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReportSessionMessages(ctx, SessionMessageReport{
		WorkspaceID: "ws-1", AgentSessionID: "source", Origin: "runtime",
		Messages: []MessageUpdate{{
			MessageID: "message-2", TurnID: "turn-2", Role: "assistant",
			Kind: "text", Status: "completed",
			Payload:          map[string]any{"sourceSessionId": "source"},
			OccurredAtUnixMS: 21,
		}},
	}); err != nil {
		t.Fatal(err)
	}
	reportRootProviderTurn(
		t, store, "source", "turn-2", "provider-turn-2",
		RootProviderTurnPhaseCompleted, 22,
	)
	if _, _, err := prepareSessionForkForTest(t, store, ctx, SessionForkPrepare{
		OperationID: "fork-root-patch", WorkspaceID: "ws-1",
		RequestID: "request-root-patch", RequestHash: "hash-root-patch",
		SourceAgentSessionID: "source", TargetAgentSessionID: "target-root-patch",
		SourceTurnID: "turn-1", DriverKind: "codex", DriverVersion: "1",
		OccurredAtUnixMS: 100,
	}); err != nil {
		t.Fatal(err)
	}
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = tx.Rollback()
	}()
	if _, _, err := store.applyRootProviderTurnTransitionTx(
		ctx,
		tx,
		RootProviderTurnTransition{
			WorkspaceID: "ws-1", RootAgentSessionID: "source",
			RootTurnID: "turn-1", ProviderTurnID: "provider-turn-1",
			Phase: RootProviderTurnPhaseCompleted, Outcome: TurnOutcomeFailed,
			OccurredAtUnixMS: 101,
		},
		101,
	); !errors.Is(err, ErrSessionForkInProgress) {
		t.Fatalf("child root provider patch error=%v", err)
	}
}

func TestSessionForkRejectsDescendantLaneInsideBoundary(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	seedForkSession(t, store)
	if _, err := store.ReportActivityState(ctx, ActivityStateReport{
		Session: SessionStateReport{
			WorkspaceID: "ws-1", AgentSessionID: "source", Kind: SessionKindRoot,
			Origin: "runtime", Provider: "codex", ProviderSessionID: "provider-source",
			Status: "active", CurrentPhase: "working", OccurredAtUnixMS: 40,
		},
		Turn: &TurnTransition{
			WorkspaceID: "ws-1", AgentSessionID: "source", TurnID: "turn-3",
			Phase: TurnPhaseRunning, OccurredAtUnixMS: 40,
		},
		RootProviderTurn: &RootProviderTurnTransition{
			WorkspaceID: "ws-1", RootAgentSessionID: "source", RootTurnID: "turn-3",
			ProviderTurnID: "provider-turn-3", Phase: RootProviderTurnPhaseRunning,
			OccurredAtUnixMS: 40,
		},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReportSessionState(ctx, SessionStateReport{
		WorkspaceID:          "ws-1",
		AgentSessionID:       "child",
		Kind:                 SessionKindChild,
		RootAgentSessionID:   "source",
		RootTurnID:           "turn-3",
		ParentAgentSessionID: "source",
		ParentTurnID:         "turn-3",
		ParentToolCallID:     "tool-child",
		Origin:               "runtime",
		Provider:             "codex",
		ProviderSessionID:    "provider-child",
		OccurredAtUnixMS:     50,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReportSessionMessages(ctx, SessionMessageReport{
		WorkspaceID: "ws-1", AgentSessionID: "source", Origin: "runtime",
		Messages: []MessageUpdate{{
			MessageID: "message-3", TurnID: "turn-3", Role: "assistant",
			Kind: "text", Status: "completed",
			Payload:          map[string]any{"sourceSessionId": "source"},
			OccurredAtUnixMS: 41,
		}},
	}); err != nil {
		t.Fatal(err)
	}
	reportRootProviderTurn(
		t, store, "source", "turn-3", "provider-turn-3",
		RootProviderTurnPhaseCompleted, 42,
	)
	if boundary, supported, err := store.CheckSessionForkThroughTurn(
		ctx, "ws-1", "source", "turn-3",
	); err != nil || supported ||
		boundary.RejectionReason != SessionForkBoundaryReasonDescendantLaneUnsupported {
		t.Fatalf(
			"CheckSessionForkThroughTurn() boundary=%#v supported=%v error=%v",
			boundary,
			supported,
			err,
		)
	}
	if _, _, err := prepareSessionForkForTest(t, store, ctx, SessionForkPrepare{
		OperationID: "fork-descendant", WorkspaceID: "ws-1",
		RequestID: "request-descendant", RequestHash: "hash-descendant",
		SourceAgentSessionID: "source", TargetAgentSessionID: "target-descendant",
		SourceTurnID: "turn-3", DriverKind: "codex", DriverVersion: "1",
		OccurredAtUnixMS: 100,
	}); !errors.Is(err, ErrSessionForkTurnState) ||
		sessionForkBoundaryReasonForTest(err) != SessionForkBoundaryReasonDescendantLaneUnsupported {
		t.Fatalf("PrepareSessionFork() error=%v", err)
	}
}

func TestSessionForkFailedAndUnknownReleaseSourceFence(t *testing.T) {
	t.Parallel()
	for _, terminalStatus := range []string{
		SessionForkStatusFailed,
		SessionForkStatusUnknown,
	} {
		terminalStatus := terminalStatus
		t.Run(terminalStatus, func(t *testing.T) {
			store := openTestStore(t, testOptions(&staticProjectPaths{}))
			ctx := context.Background()
			seedForkSession(t, store)
			input := SessionForkPrepare{
				OperationID: "fork-" + terminalStatus, WorkspaceID: "ws-1",
				RequestID: "request-" + terminalStatus, RequestHash: "hash-" + terminalStatus,
				SourceAgentSessionID: "source", TargetAgentSessionID: "target-" + terminalStatus,
				SourceTurnID: "turn-1", DriverKind: "codex", DriverVersion: "1",
				OccurredAtUnixMS: 100,
			}
			if _, _, err := prepareSessionForkForTest(t, store, ctx, input); err != nil {
				t.Fatal(err)
			}
			if _, _, err := store.MarkSessionForkDispatching(ctx, "ws-1", input.OperationID, 101); err != nil {
				t.Fatal(err)
			}
			if _, _, err := store.RecordSessionForkProviderResult(ctx, SessionForkProviderResult{
				WorkspaceID: "ws-1", OperationID: input.OperationID,
				Status: terminalStatus, LastError: "terminal", OccurredAtUnixMS: 102,
			}); err != nil {
				t.Fatal(err)
			}
			unresolved, found, err := store.GetUnknownSessionForkOperation(
				ctx,
				"ws-1",
				"source",
				SessionForkPointThroughTurn,
				"turn-1",
			)
			if err != nil {
				t.Fatal(err)
			}
			if terminalStatus == SessionForkStatusUnknown {
				if !found || unresolved.OperationID != input.OperationID {
					t.Fatalf("unknown lookup=%#v found=%v", unresolved, found)
				}
			} else if found {
				t.Fatalf("failed operation appeared unresolved: %#v", unresolved)
			}
			if terminalStatus == SessionForkStatusUnknown {
				if _, found, changed, err := store.AcknowledgeSessionForkOperation(
					ctx,
					"ws-1",
					input.OperationID,
					103,
				); !errors.Is(err, ErrSessionForkTransition) || !found || changed {
					t.Fatalf(
						"acknowledge unknown found=%v changed=%v error=%v",
						found,
						changed,
						err,
					)
				}
			}
			if _, err := store.ReportSessionState(ctx, SessionStateReport{
				WorkspaceID: "ws-1", AgentSessionID: "source", Provider: "codex",
				ProviderSessionID: "provider-source", OccurredAtUnixMS: 103,
			}); err != nil {
				t.Fatalf("ReportSessionState(after %s) error=%v", terminalStatus, err)
			}
			next, created, err := prepareSessionForkForTest(t, store, ctx, SessionForkPrepare{
				OperationID: "fork-next-" + terminalStatus, WorkspaceID: "ws-1",
				RequestID: "request-next-" + terminalStatus, RequestHash: "hash-next-" + terminalStatus,
				SourceAgentSessionID: "source", TargetAgentSessionID: "target-next-" + terminalStatus,
				SourceTurnID: "turn-1", DriverKind: "codex", DriverVersion: "1",
				OccurredAtUnixMS: 104,
			})
			if err != nil {
				t.Fatalf("PrepareSessionFork(after %s) error=%v", terminalStatus, err)
			}
			if terminalStatus == SessionForkStatusUnknown {
				if created || next.OperationID != input.OperationID {
					t.Fatalf(
						"unknown barrier operation=%#v created=%v",
						next,
						created,
					)
				}
			} else if !created {
				t.Fatalf("failed operation did not release boundary barrier: %#v", next)
			}
		})
	}
}

func TestRetryUnknownSessionForkReopensDurableDispatchMarker(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	seedForkSession(t, store)
	input := SessionForkPrepare{
		OperationID: "fork-retry", WorkspaceID: "ws-1",
		RequestID: "request-retry", RequestHash: "hash-retry",
		SourceAgentSessionID: "source", TargetAgentSessionID: "target-retry",
		SourceTurnID: "turn-1", DriverKind: "claude",
		DriverVersion: "deterministic-v1", OccurredAtUnixMS: 100,
	}
	if _, _, err := prepareSessionForkForTest(t, store, ctx, input); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.MarkSessionForkDispatching(
		ctx, input.WorkspaceID, input.OperationID, 101,
	); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.RecordSessionForkProviderResult(
		ctx,
		SessionForkProviderResult{
			WorkspaceID: input.WorkspaceID, OperationID: input.OperationID,
			Status: SessionForkStatusUnknown, LastError: "response lost",
			OccurredAtUnixMS: 102,
		},
	); err != nil {
		t.Fatal(err)
	}
	operation, changed, err := store.RetryUnknownSessionFork(
		ctx, input.WorkspaceID, input.OperationID, 103,
	)
	if err != nil || !changed ||
		operation.Status != SessionForkStatusDispatching ||
		operation.LastError != "" ||
		operation.CompletedAtUnixMS != 0 ||
		operation.DispatchedAtUnixMS != 103 {
		t.Fatalf(
			"RetryUnknownSessionFork() operation=%#v changed=%v error=%v",
			operation,
			changed,
			err,
		)
	}
}

func TestSessionForkPrepareRequiresGoalAndRuntimeQuiescence(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name string
		busy func(*testing.T, *Store)
	}{
		{
			name: "goal control",
			busy: func(t *testing.T, store *Store) {
				_, _, _, err := store.PrepareGoalControlOperation(context.Background(), GoalControlOperationPrepare{
					OperationID: "goal-op", WorkspaceID: "ws-1", AgentSessionID: "source",
					Action: "set", Objective: "ship", OccurredAtUnixMS: 50,
				})
				if err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name: "runtime operation",
			busy: func(t *testing.T, store *Store) {
				if _, err := store.db.ExecContext(context.Background(), `
INSERT INTO workspace_agent_runtime_operations (
  operation_id, workspace_id, agent_session_id, kind, status, turn_id,
  payload_json, next_attempt_at_unix_ms, created_at_unix_ms, updated_at_unix_ms
) VALUES ('runtime-op', 'ws-1', 'source', 'cancel_turn', 'prepared', 'turn-2',
          '{}', 50, 50, 50)
`); err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name: "reporter barrier",
			busy: func(t *testing.T, store *Store) {
				if _, err := store.PutGoalReconcileInbox(context.Background(), GoalReconcileInboxItem{
					RequestID: "inbox-1", WorkspaceID: "ws-1", AgentSessionID: "source",
					Payload: map[string]any{"phase": goalReconcilePhasePending}, CreatedAtUnixMS: 50,
				}); err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name: "submit claim",
			busy: func(t *testing.T, store *Store) {
				if _, _, err := store.PrepareSubmitClaim(context.Background(), SubmitClaimPrepare{
					WorkspaceID: "ws-1", AgentSessionID: "source",
					ClientSubmitID: "submit-1", CanonicalTurnID: "turn-2",
					NowUnixMS: 50,
				}); err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name: "legacy submit claim without canonical turn",
			busy: func(t *testing.T, store *Store) {
				if _, err := store.db.ExecContext(context.Background(), `
INSERT INTO workspace_agent_submit_claims (
  workspace_id, agent_session_id, client_submit_id, status, turn_id,
  created_at_unix_ms, updated_at_unix_ms, canonical_turn_id
) VALUES ('ws-1', 'source', 'legacy-submit', 'prepared', NULL, 50, 50, NULL)
`); err != nil {
					t.Fatal(err)
				}
			},
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			store := openTestStore(t, testOptions(&staticProjectPaths{}))
			seedForkSession(t, store)
			test.busy(t, store)
			if _, _, err := prepareSessionForkForTest(t, store, context.Background(), SessionForkPrepare{
				OperationID: "fork-busy", WorkspaceID: "ws-1", RequestID: "request-busy",
				RequestHash: "hash-busy", SourceAgentSessionID: "source",
				TargetAgentSessionID: "target-busy", SourceTurnID: "turn-2",
				DriverKind: "codex", DriverVersion: "1", OccurredAtUnixMS: 100,
			}); !errors.Is(err, ErrSessionForkSourceState) {
				t.Fatalf("PrepareSessionFork() error=%v", err)
			}
		})
	}
}

func TestSessionForkCommitReprovesPrefixAndProviderIdentity(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name    string
		mutate  func(*testing.T, *Store)
		wantErr error
	}{
		{
			name: "prefix",
			mutate: func(t *testing.T, store *Store) {
				if _, err := store.db.ExecContext(context.Background(), `
UPDATE workspace_agent_messages
SET payload_json = '{"changed":true}'
WHERE workspace_id = 'ws-1' AND agent_session_id = 'source' AND message_id = 'message-1'
`); err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name: "provider identity",
			mutate: func(t *testing.T, store *Store) {
				if _, err := store.db.ExecContext(context.Background(), `
UPDATE workspace_agent_sessions
SET provider_session_id = 'provider-source-changed'
WHERE workspace_id = 'ws-1' AND agent_session_id = 'source'
`); err != nil {
					t.Fatal(err)
				}
			},
			wantErr: ErrSessionForkSourceState,
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			store := openTestStore(t, testOptions(&staticProjectPaths{}))
			seedForkSession(t, store)
			prepareAcceptedFork(t, store, SessionForkPrepare{
				OperationID: "fork-proof", WorkspaceID: "ws-1", RequestID: "request-proof",
				RequestHash: "hash-proof", SourceAgentSessionID: "source",
				TargetAgentSessionID: "target-proof", SourceTurnID: "turn-1",
				DriverKind: "codex", DriverVersion: "1", OccurredAtUnixMS: 100,
			})
			test.mutate(t, store)
			_, err := store.CommitSessionFork(context.Background(), "ws-1", "fork-proof", 103)
			if test.wantErr != nil {
				if !errors.Is(err, test.wantErr) {
					t.Fatalf("CommitSessionFork() error=%v", err)
				}
			} else if err == nil {
				t.Fatal("CommitSessionFork() unexpectedly succeeded")
			}
		})
	}
}

func TestSessionForkCommitDeltaIncludesClonedInteraction(t *testing.T) {
	t.Parallel()
	participant := &testTransactionParticipant{}
	store := openParticipantTestStore(t, participant)
	ctx := context.Background()
	seedForkSession(t, store)
	if _, err := store.db.ExecContext(ctx, `
INSERT INTO workspace_agent_interactions (
  workspace_id, agent_session_id, request_id, turn_id, kind, status,
  tool_name, input_json, output_json, metadata_json,
  created_at_unix_ms, updated_at_unix_ms
) VALUES ('ws-1', 'source', 'request-1', 'turn-1', 'question', 'answered',
          '', '{}', '{}', '{}', 12, 13)
`); err != nil {
		t.Fatal(err)
	}
	result := commitFork(t, store, SessionForkPrepare{
		OperationID: "fork-delta", WorkspaceID: "ws-1", RequestID: "request-delta",
		RequestHash: "hash-delta", SourceAgentSessionID: "source",
		TargetAgentSessionID: "target-delta", SourceTurnID: "turn-1",
		DriverKind: "codex", DriverVersion: "1", OccurredAtUnixMS: 100,
	})
	assertParticipantMutationKinds(t, result.CommitDelta,
		MutationEntitySession, MutationEntityTurn, MutationEntityMessage,
		MutationEntityInteraction, MutationEntitySessionForkOperation)
	assertParticipantMutationEntityID(t, result.CommitDelta,
		MutationEntityInteraction,
		deterministicSessionForkCanonicalID(result.Operation, "turn", "turn-1")+
			"\x00"+
			deterministicSessionForkCanonicalID(
				result.Operation,
				"interaction",
				"turn-1\x00request-1",
			),
	)
}

func TestListRecoverableSessionForkOperationsPage(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	seedForkSession(t, store)
	baseFork := commitFork(t, store, SessionForkPrepare{
		OperationID: "fork-base", WorkspaceID: "ws-1", RequestID: "request-base",
		RequestHash: "hash-base", SourceAgentSessionID: "source",
		TargetAgentSessionID: "forked-source", SourceTurnID: "turn-1",
		DriverKind: "codex", DriverVersion: "1", OccurredAtUnixMS: 100,
	})
	if _, found, _, err := store.AcknowledgeSessionForkOperation(
		ctx,
		"ws-1",
		baseFork.Operation.OperationID,
		150,
	); err != nil || !found {
		t.Fatalf("acknowledge base fork found=%v error=%v", found, err)
	}
	forkedSourceTurnID := deterministicSessionForkCanonicalID(
		baseFork.Operation,
		"turn",
		"turn-1",
	)
	for _, input := range []SessionForkPrepare{
		{
			OperationID: "recover-a", WorkspaceID: "ws-1", RequestID: "recover-request-a",
			RequestHash: "recover-hash-a", SourceAgentSessionID: "source",
			TargetAgentSessionID: "recover-target-a", SourceTurnID: "turn-1",
			DriverKind: "codex", DriverVersion: "1", OccurredAtUnixMS: 200,
		},
		{
			OperationID: "recover-b", WorkspaceID: "ws-1", RequestID: "recover-request-b",
			RequestHash: "recover-hash-b", SourceAgentSessionID: "forked-source",
			TargetAgentSessionID: "recover-target-b", SourceTurnID: forkedSourceTurnID,
			DriverKind: "codex", DriverVersion: "1", OccurredAtUnixMS: 200,
		},
	} {
		if _, _, err := prepareSessionForkForTest(t, store, ctx, input); err != nil {
			t.Fatal(err)
		}
	}
	first, err := store.ListRecoverableSessionForkOperationsPage(ctx, SessionForkRecoveryCursor{}, 1)
	if err != nil || len(first) != 1 || first[0].OperationID != "recover-a" {
		t.Fatalf("first recovery page=%#v error=%v", first, err)
	}
	second, err := store.ListRecoverableSessionForkOperationsPage(ctx, SessionForkRecoveryCursor{
		CreatedAtUnixMS: first[0].CreatedAtUnixMS, OperationID: first[0].OperationID,
	}, 1)
	if err != nil || len(second) != 1 || second[0].OperationID != "recover-b" {
		t.Fatalf("second recovery page=%#v error=%v", second, err)
	}
}

func sessionForkBoundaryReasonForTest(err error) SessionForkBoundaryReason {
	var boundaryErr *SessionForkBoundaryError
	if !errors.As(err, &boundaryErr) {
		return ""
	}
	return boundaryErr.Reason
}

func prepareSessionForkForTest(
	t *testing.T,
	store *Store,
	ctx context.Context,
	input SessionForkPrepare,
) (SessionForkOperation, bool, error) {
	t.Helper()
	if input.ExpectedSourceHash == "" {
		source, found, err := store.GetSession(
			ctx,
			input.WorkspaceID,
			input.SourceAgentSessionID,
		)
		if err != nil {
			t.Fatal(err)
		}
		if !found {
			t.Fatalf("source session %q not found", input.SourceAgentSessionID)
		}
		input.ExpectedSourceHash, err = SessionForkSourceHash(source)
		if err != nil {
			t.Fatal(err)
		}
	}
	return store.PrepareSessionFork(ctx, input)
}

func seedForkSession(t *testing.T, store *Store) {
	t.Helper()
	ctx := context.Background()
	if _, err := store.ReportSessionState(ctx, SessionStateReport{
		WorkspaceID: "ws-1", AgentSessionID: "source", Kind: SessionKindRoot,
		Origin: "runtime", Provider: "codex", ProviderSessionID: "provider-source",
		Status: "ready", CurrentPhase: "idle", OccurredAtUnixMS: 1,
	}); err != nil {
		t.Fatal(err)
	}
	for index, turnID := range []string{"turn-1", "turn-2"} {
		started := int64(10 + index*10)
		providerTurnID := "provider-" + turnID
		if _, err := store.ReportActivityState(ctx, ActivityStateReport{
			Session: SessionStateReport{
				WorkspaceID: "ws-1", AgentSessionID: "source", Kind: SessionKindRoot,
				Origin: "runtime", Provider: "codex", ProviderSessionID: "provider-source",
				Status: "active", CurrentPhase: "working", OccurredAtUnixMS: started,
			},
			Turn: &TurnTransition{
				WorkspaceID: "ws-1", AgentSessionID: "source", TurnID: turnID,
				Phase: TurnPhaseRunning, OccurredAtUnixMS: started,
			},
			RootProviderTurn: &RootProviderTurnTransition{
				WorkspaceID: "ws-1", RootAgentSessionID: "source", RootTurnID: turnID,
				ProviderTurnID: providerTurnID, Phase: RootProviderTurnPhaseRunning,
				OccurredAtUnixMS: started,
			},
		}); err != nil {
			t.Fatal(err)
		}
		if _, err := store.ReportSessionMessages(ctx, SessionMessageReport{
			WorkspaceID: "ws-1", AgentSessionID: "source", Origin: "runtime",
			Messages: []MessageUpdate{{
				MessageID: "message-" + string(rune('1'+index)), TurnID: turnID,
				Role: "assistant", Kind: "text", Status: "completed",
				Payload:          map[string]any{"sourceSessionId": "source"},
				OccurredAtUnixMS: started + 1,
			}},
		}); err != nil {
			t.Fatal(err)
		}
		reportRootProviderTurn(t, store, "source", turnID, providerTurnID,
			RootProviderTurnPhaseCompleted, started+2)
	}
}

func appendSettledForkTurn(t *testing.T, store *Store, turnID string, started int64) {
	t.Helper()
	ctx := context.Background()
	providerTurnID := "provider-" + turnID
	if _, err := store.ReportActivityState(ctx, ActivityStateReport{
		Session: SessionStateReport{
			WorkspaceID: "ws-1", AgentSessionID: "source", Kind: SessionKindRoot,
			Origin: "runtime", Provider: "codex", ProviderSessionID: "provider-source",
			Status: "active", CurrentPhase: "working", OccurredAtUnixMS: started,
		},
		Turn: &TurnTransition{
			WorkspaceID: "ws-1", AgentSessionID: "source", TurnID: turnID,
			Phase: TurnPhaseRunning, OccurredAtUnixMS: started,
		},
		RootProviderTurn: &RootProviderTurnTransition{
			WorkspaceID: "ws-1", RootAgentSessionID: "source", RootTurnID: turnID,
			ProviderTurnID: providerTurnID, Phase: RootProviderTurnPhaseRunning,
			OccurredAtUnixMS: started,
		},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReportSessionMessages(ctx, SessionMessageReport{
		WorkspaceID: "ws-1", AgentSessionID: "source", Origin: "runtime",
		Messages: []MessageUpdate{{
			MessageID: "message-" + turnID[len(turnID)-1:], TurnID: turnID,
			Role: "assistant", Kind: "text", Status: "completed",
			Payload: map[string]any{"sourceSessionId": "source"}, OccurredAtUnixMS: started + 1,
		}},
	}); err != nil {
		t.Fatal(err)
	}
	reportRootProviderTurn(t, store, "source", turnID, providerTurnID,
		RootProviderTurnPhaseCompleted, started+2)
}

func prepareAcceptedFork(t *testing.T, store *Store, input SessionForkPrepare) {
	t.Helper()
	ctx := context.Background()
	if _, _, err := prepareSessionForkForTest(t, store, ctx, input); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.MarkSessionForkDispatching(ctx, input.WorkspaceID, input.OperationID, input.OccurredAtUnixMS+1); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.RecordSessionForkProviderResult(ctx, SessionForkProviderResult{
		WorkspaceID: input.WorkspaceID, OperationID: input.OperationID,
		Status:                  SessionForkStatusProviderAccepted,
		TargetProviderSessionID: "provider-" + input.TargetAgentSessionID,
		OccurredAtUnixMS:        input.OccurredAtUnixMS + 2,
	}); err != nil {
		t.Fatal(err)
	}
}

func commitFork(t *testing.T, store *Store, input SessionForkPrepare) SessionForkCommitResult {
	t.Helper()
	prepareAcceptedFork(t, store, input)
	result, err := store.CommitSessionFork(
		context.Background(), input.WorkspaceID, input.OperationID, input.OccurredAtUnixMS+3,
	)
	if err != nil {
		t.Fatal(err)
	}
	return result
}
