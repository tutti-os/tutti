package workspace

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	agentactivitybiz "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	agentturnanalyticsbiz "github.com/tutti-os/tutti/services/tuttid/biz/agentturnanalytics"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
)

func TestTerminalAnalyticsMarkerIsAtomicWithCanonicalSettlement(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := openTestSQLiteStore(t)
	seedTerminalAnalyticsWorkspace(t, store, "ws-atomic")
	seedTerminalAnalyticsSession(t, store, "ws-atomic", "root", agentactivitybiz.SessionKindRoot, "", "")
	seedTerminalAnalyticsTurn(t, store, "ws-atomic", "root", "turn-1", agentactivitybiz.TurnOriginUserPrompt, 100)

	if _, err := store.writeDB.ExecContext(ctx, `DROP TABLE agent_turn_terminal_analytics`); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.AgentCanonicalStore().RecordTurnTransition(ctx, agentactivitybiz.TurnTransition{
		WorkspaceID: "ws-atomic", AgentSessionID: "root", TurnID: "turn-1",
		Phase: agentactivitybiz.TurnPhaseSettled, Outcome: agentactivitybiz.TurnOutcomeCompleted,
		OccurredAtUnixMS: 200, SettledAtUnixMS: 200,
	}); err == nil {
		t.Fatal("terminal transition succeeded without its durable analytics participant table")
	}
	turn, found, err := store.GetTurn(ctx, "ws-atomic", "root", "turn-1")
	if err != nil || !found || turn.Phase != agentactivitybiz.TurnPhaseSubmitted {
		t.Fatalf("canonical turn after participant rollback=%#v found=%v err=%v", turn, found, err)
	}
}

func TestTerminalAnalyticsPutCannotBypassCanonicalChildEligibility(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := openTestSQLiteStore(t)
	seedTerminalAnalyticsWorkspace(t, store, "ws-put-child")
	seedTerminalAnalyticsSession(t, store, "ws-put-child", "root", agentactivitybiz.SessionKindRoot, "", "")
	seedTerminalAnalyticsTurn(t, store, "ws-put-child", "root", "root-turn", agentactivitybiz.TurnOriginUserPrompt, 100)
	seedTerminalAnalyticsSession(t, store, "ws-put-child", "child", agentactivitybiz.SessionKindChild, "root", "root-turn")
	seedTerminalAnalyticsTurn(t, store, "ws-put-child", "child", "child-turn", agentactivitybiz.TurnOriginUserPrompt, 110)
	settleTerminalAnalyticsTurn(t, store, "ws-put-child", "child", "child-turn", 120)
	assertTerminalAnalyticsRows(t, store, "ws-put-child", "child", 0)

	inserted, err := store.PutAgentTurnTerminalAnalytics(ctx, agentturnanalyticsbiz.Settlement{
		WorkspaceID: "ws-put-child", AgentSessionID: "child", TurnID: "child-turn",
		// Simulate a sparse observer that misclassified the child as a root and
		// supplied otherwise eligible fields. Put must re-check canonical rows.
		Origin: agentactivitybiz.TurnOriginUserPrompt, Outcome: agentactivitybiz.TurnOutcomeCompleted,
		SettledAtUnixMS: 120,
	}, 130)
	if err != nil || inserted {
		t.Fatalf("misclassified child Put inserted=%v err=%v", inserted, err)
	}
	assertTerminalAnalyticsRows(t, store, "ws-put-child", "child", 0)
}

func TestTerminalAnalyticsClaimUsesRejectedClaimAndRecoversLease(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := openTestSQLiteStore(t)
	seedTerminalAnalyticsWorkspace(t, store, "ws-rejected")
	seedTerminalAnalyticsSession(t, store, "ws-rejected", "root", agentactivitybiz.SessionKindRoot, "", "")
	seedTerminalAnalyticsTurn(t, store, "ws-rejected", "root", "turn-1", agentactivitybiz.TurnOriginUserPrompt, 100)
	prepareTerminalAnalyticsClaim(t, store, "ws-rejected", "root", "turn-1", "submit-rejected", `{"uiMode":"agent"}`, 110)
	if _, changed, err := store.RejectSubmitClaim(ctx, "ws-rejected", "root", "submit-rejected", "turn-1", 120); err != nil || !changed {
		t.Fatalf("RejectSubmitClaim() changed=%v err=%v", changed, err)
	}
	settleTerminalAnalyticsTurn(t, store, "ws-rejected", "root", "turn-1", 200)

	first, found, err := store.ClaimAgentTurnTerminalAnalytics(ctx, "owner-1", 300, 400)
	if err != nil || !found || first.ClientSubmitID != "submit-rejected" || first.MetadataJSON != `{"uiMode":"agent"}` {
		t.Fatalf("first claim=%#v found=%v err=%v", first, found, err)
	}
	if first.EventID != agentturnanalyticsbiz.StableEventID("ws-rejected", "root", "turn-1") {
		t.Fatalf("event id=%q", first.EventID)
	}
	if _, found, err := store.ClaimAgentTurnTerminalAnalytics(ctx, "owner-2", 350, 450); err != nil || found {
		t.Fatalf("live lease second claim found=%v err=%v", found, err)
	}
	if requeued, err := store.RequeueAgentTurnTerminalAnalytics(ctx, 360); err != nil || requeued != 1 {
		t.Fatalf("RequeueAgentTurnTerminalAnalytics()=%d err=%v", requeued, err)
	}
	second, found, err := store.ClaimAgentTurnTerminalAnalytics(ctx, "owner-2", 370, 470)
	if err != nil || !found || second.EventID != first.EventID {
		t.Fatalf("recovered claim=%#v found=%v err=%v", second, found, err)
	}
	if finished, err := store.CompleteAgentTurnTerminalAnalytics(ctx, "ws-rejected", "root", "turn-1", "owner-1", 380); err != nil || finished {
		t.Fatalf("stale owner completion finished=%v err=%v", finished, err)
	}
	if finished, err := store.CompleteAgentTurnTerminalAnalytics(ctx, "ws-rejected", "root", "turn-1", "owner-2", 390); err != nil || !finished {
		t.Fatalf("current owner completion finished=%v err=%v", finished, err)
	}
}

func TestTerminalAnalyticsClaimDoesNotGuessAmbiguousOrIncompleteProvenance(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := openTestSQLiteStore(t)
	seedTerminalAnalyticsWorkspace(t, store, "ws-provenance")
	seedTerminalAnalyticsSession(t, store, "ws-provenance", "root", agentactivitybiz.SessionKindRoot, "", "")

	// Two claims can legitimately target one canonical turn (initial submit and
	// guidance). Claim provenance must fail closed until the lossless envelope
	// arrives instead of silently selecting one.
	seedTerminalAnalyticsTurn(t, store, "ws-provenance", "root", "ambiguous", agentactivitybiz.TurnOriginUserPrompt, 100)
	prepareTerminalAnalyticsClaim(t, store, "ws-provenance", "root", "ambiguous", "submit-a", `{"uiMode":"agent"}`, 101)
	prepareTerminalAnalyticsClaim(t, store, "ws-provenance", "root", "ambiguous", "submit-b", `{"uiMode":"os"}`, 102)
	settleTerminalAnalyticsTurn(t, store, "ws-provenance", "root", "ambiguous", 110)

	// A claim without validated uiMode is also not definitive. A later full
	// submission may contain valid provenance and must still be deliverable.
	seedTerminalAnalyticsTurn(t, store, "ws-provenance", "root", "incomplete", agentactivitybiz.TurnOriginUserPrompt, 120)
	prepareTerminalAnalyticsClaim(t, store, "ws-provenance", "root", "incomplete", "submit-empty", `{}`, 121)
	settleTerminalAnalyticsTurn(t, store, "ws-provenance", "root", "incomplete", 130)

	if _, found, err := store.ClaimAgentTurnTerminalAnalytics(ctx, "owner", 200, 300); err != nil || found {
		t.Fatalf("claim before envelopes found=%v err=%v", found, err)
	}
	recordTerminalAnalyticsSubmission(t, store, "ws-provenance", "root", "ambiguous", "envelope-a", `{"uiMode":"os"}`, 210)
	delivery, found, err := store.ClaimAgentTurnTerminalAnalytics(ctx, "owner", 220, 320)
	if err != nil || !found || delivery.TurnID != "ambiguous" || delivery.ClientSubmitID != "envelope-a" || delivery.MetadataJSON != `{"uiMode":"os"}` {
		t.Fatalf("submission-preferred delivery=%#v found=%v err=%v", delivery, found, err)
	}
	if finished, err := store.CompleteAgentTurnTerminalAnalytics(ctx, delivery.WorkspaceID, delivery.AgentSessionID, delivery.TurnID, "owner", 230); err != nil || !finished {
		t.Fatalf("complete ambiguous delivery=%v err=%v", finished, err)
	}
	recordTerminalAnalyticsSubmission(t, store, "ws-provenance", "root", "incomplete", "envelope-empty", `{"uiMode":"agent"}`, 240)
	delivery, found, err = store.ClaimAgentTurnTerminalAnalytics(ctx, "owner", 250, 350)
	if err != nil || !found || delivery.TurnID != "incomplete" || delivery.ClientSubmitID != "envelope-empty" || delivery.MetadataJSON != `{"uiMode":"agent"}` {
		t.Fatalf("late-envelope delivery=%#v found=%v err=%v", delivery, found, err)
	}
}

func TestTerminalAnalyticsClaimAvoidsHeadOfLineStarvation(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := openTestSQLiteStore(t)
	seedTerminalAnalyticsWorkspace(t, store, "ws-hol")
	seedTerminalAnalyticsSession(t, store, "ws-hol", "root", agentactivitybiz.SessionKindRoot, "", "")
	for index := 0; index < terminalAnalyticsClaimScanLimit; index++ {
		turnID := "blocked-" + twoDigit(index)
		seedTerminalAnalyticsTurn(t, store, "ws-hol", "root", turnID, agentactivitybiz.TurnOriginUserPrompt, int64(100+index*10))
		prepareTerminalAnalyticsClaim(t, store, "ws-hol", "root", turnID, "submit-"+turnID, `{}`, int64(101+index*10))
		settleTerminalAnalyticsTurn(t, store, "ws-hol", "root", turnID, int64(102+index*10))
	}
	seedTerminalAnalyticsTurn(t, store, "ws-hol", "root", "ready", agentactivitybiz.TurnOriginUserPrompt, 10_000)
	prepareTerminalAnalyticsClaim(t, store, "ws-hol", "root", "ready", "submit-ready", `{"uiMode":"agent"}`, 10_001)
	settleTerminalAnalyticsTurn(t, store, "ws-hol", "root", "ready", 10_002)

	delivery, found, err := store.ClaimAgentTurnTerminalAnalytics(ctx, "owner", 20_000, 21_000)
	if err != nil || !found || delivery.TurnID != "ready" {
		t.Fatalf("claim behind %d unresolved rows=%#v found=%v err=%v", terminalAnalyticsClaimScanLimit, delivery, found, err)
	}
}

func TestTerminalAnalyticsMarkerRequiresExplicitTerminalTransition(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := openTestSQLiteStore(t)
	seedTerminalAnalyticsWorkspace(t, store, "ws-marker")
	seedTerminalAnalyticsSession(t, store, "ws-marker", "root", agentactivitybiz.SessionKindRoot, "", "")
	seedTerminalAnalyticsTurn(t, store, "ws-marker", "root", "turn-1", agentactivitybiz.TurnOriginUserPrompt, 100)
	settleTerminalAnalyticsTurn(t, store, "ws-marker", "root", "turn-1", 200)
	if _, err := store.writeDB.ExecContext(ctx, `DELETE FROM agent_turn_terminal_analytics`); err != nil {
		t.Fatal(err)
	}
	turn, accepted, err := store.AgentCanonicalStore().RecordTurnTransition(ctx, agentactivitybiz.TurnTransition{
		WorkspaceID: "ws-marker", AgentSessionID: "root", TurnID: "turn-1",
		CapabilityRefs:   []agentactivitybiz.CapabilityReference{{Capability: "mcp", Source: "late"}},
		OccurredAtUnixMS: 300,
	})
	if err != nil || !accepted || turn.Phase != agentactivitybiz.TurnPhaseSettled {
		t.Fatalf("late capability merge turn=%#v accepted=%v err=%v", turn, accepted, err)
	}
	assertTerminalAnalyticsRows(t, store, "ws-marker", "root", 0)
}

func TestLateProviderBindingDoesNotRecreateTerminalMarker(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := openTestSQLiteStore(t)
	seedTerminalAnalyticsWorkspace(t, store, "ws-binding")
	seedTerminalAnalyticsSession(t, store, "ws-binding", "root", agentactivitybiz.SessionKindRoot, "", "")
	seedTerminalAnalyticsTurn(t, store, "ws-binding", "root", "turn-1", agentactivitybiz.TurnOriginUserPrompt, 100)
	completed, err := store.ReportActivityState(ctx, agentactivitybiz.ActivityStateReport{
		Session: agentactivitybiz.SessionStateReport{
			WorkspaceID: "ws-binding", AgentSessionID: "root", OccurredAtUnixMS: 110,
		},
		RootProviderTurn: &agentactivitybiz.RootProviderTurnTransition{
			WorkspaceID: "ws-binding", RootAgentSessionID: "root", RootTurnID: "turn-1",
			ProviderTurnID: "provider-turn", Phase: agentactivitybiz.RootProviderTurnPhaseCompleted,
			Outcome: agentactivitybiz.TurnOutcomeCompleted, OccurredAtUnixMS: 110,
		},
	})
	if err != nil || !completed.RootTurnAccepted || completed.RootTurn.Phase != agentactivitybiz.TurnPhaseSettled {
		t.Fatalf("provider completion=%#v err=%v", completed, err)
	}
	if _, err := store.writeDB.ExecContext(ctx, `DELETE FROM agent_turn_terminal_analytics`); err != nil {
		t.Fatal(err)
	}
	late, err := store.ReportActivityState(ctx, agentactivitybiz.ActivityStateReport{
		Session: agentactivitybiz.SessionStateReport{
			WorkspaceID: "ws-binding", AgentSessionID: "root", OccurredAtUnixMS: 120,
		},
		RootProviderTurn: &agentactivitybiz.RootProviderTurnTransition{
			WorkspaceID: "ws-binding", RootAgentSessionID: "root", RootTurnID: "turn-1",
			ProviderTurnID:          "provider-turn",
			ProviderTurnBindingJSON: json.RawMessage(`{"checkpointMessageId":"late"}`),
			OccurredAtUnixMS:        120,
		},
	})
	if err != nil || late.RootTurnAccepted || !late.RootProviderTurnAccepted {
		t.Fatalf("late provider binding=%#v err=%v", late, err)
	}
	assertTerminalAnalyticsRows(t, store, "ws-binding", "root", 0)
}

func TestTerminalAnalyticsMarkerCascadesOnPurgeAndClear(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := openTestSQLiteStore(t)
	seedTerminalAnalyticsWorkspace(t, store, "ws-cleanup")
	for _, sessionID := range []string{"purge", "clear"} {
		seedTerminalAnalyticsSession(t, store, "ws-cleanup", sessionID, agentactivitybiz.SessionKindRoot, "", "")
		seedTerminalAnalyticsTurn(t, store, "ws-cleanup", sessionID, "turn-1", agentactivitybiz.TurnOriginUserPrompt, 100)
		settleTerminalAnalyticsTurn(t, store, "ws-cleanup", sessionID, "turn-1", 200)
	}
	if removed, err := store.DeleteSession(ctx, "ws-cleanup", "purge"); err != nil || !removed {
		t.Fatalf("DeleteSession() removed=%v err=%v", removed, err)
	}
	if _, err := store.PurgeDeletedSessions(ctx, agentactivitybiz.PurgeDeletedSessionsInput{
		CutoffUnixMS: time.Now().Add(time.Hour).UnixMilli(),
	}); err != nil {
		t.Fatalf("PurgeDeletedSessions() err=%v", err)
	}
	assertTerminalAnalyticsRows(t, store, "ws-cleanup", "purge", 0)
	assertTerminalAnalyticsRows(t, store, "ws-cleanup", "clear", 1)
	if _, err := store.ClearSessions(ctx, "ws-cleanup"); err != nil {
		t.Fatalf("ClearSessions() err=%v", err)
	}
	assertTerminalAnalyticsRows(t, store, "ws-cleanup", "clear", 0)
}

func TestSoftDeleteEmitsOnlyActualRootTurnTerminalTransition(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := openTestSQLiteStore(t)
	seedTerminalAnalyticsWorkspace(t, store, "ws-delete")
	seedTerminalAnalyticsSession(t, store, "ws-delete", "root", agentactivitybiz.SessionKindRoot, "", "")

	// Remove the ordinary marker for an already-settled historical Turn. If
	// soft deletion inferred transitions from final row shape, it would recreate
	// this event even though deletion did not settle it.
	seedTerminalAnalyticsTurn(t, store, "ws-delete", "root", "old-settled", agentactivitybiz.TurnOriginUserPrompt, 100)
	settleTerminalAnalyticsTurn(t, store, "ws-delete", "root", "old-settled", 110)
	if _, err := store.writeDB.ExecContext(ctx, `
DELETE FROM agent_turn_terminal_analytics
WHERE workspace_id = 'ws-delete' AND agent_session_id = 'root' AND turn_id = 'old-settled'
`); err != nil {
		t.Fatal(err)
	}

	seedTerminalAnalyticsTurn(t, store, "ws-delete", "root", "live-root", agentactivitybiz.TurnOriginUserPrompt, 200)
	prepareTerminalAnalyticsClaim(t, store, "ws-delete", "root", "live-root", "submit-root", `{"uiMode":"agent"}`, 201)
	seedTerminalAnalyticsSession(t, store, "ws-delete", "child", agentactivitybiz.SessionKindChild, "root", "live-root")
	seedTerminalAnalyticsTurn(t, store, "ws-delete", "child", "live-child", agentactivitybiz.TurnOriginUserPrompt, 210)
	prepareTerminalAnalyticsClaim(t, store, "ws-delete", "child", "live-child", "submit-child", `{"uiMode":"agent"}`, 211)

	if removed, err := store.DeleteSession(ctx, "ws-delete", "root"); err != nil || !removed {
		t.Fatalf("DeleteSession() removed=%v err=%v", removed, err)
	}
	var total int
	if err := store.writeDB.QueryRowContext(ctx, `
SELECT COUNT(*) FROM agent_turn_terminal_analytics WHERE workspace_id = 'ws-delete'
`).Scan(&total); err != nil || total != 1 {
		t.Fatalf("soft-delete analytics count=%d err=%v, want only live root", total, err)
	}
	delivery, found, err := store.ClaimAgentTurnTerminalAnalytics(ctx, "owner", time.Now().UnixMilli(), time.Now().Add(time.Minute).UnixMilli())
	if err != nil || !found || delivery.TurnID != "live-root" || delivery.Outcome != agentactivitybiz.TurnOutcomeInterrupted {
		t.Fatalf("soft-delete delivery=%#v found=%v err=%v", delivery, found, err)
	}
}

func TestChildTerminalSettlesAndMarksCanonicalRootOnlyOnce(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := openTestSQLiteStore(t)
	seedTerminalAnalyticsWorkspace(t, store, "ws-child")
	seedTerminalAnalyticsSession(t, store, "ws-child", "root", agentactivitybiz.SessionKindRoot, "", "")
	seedTerminalAnalyticsTurn(t, store, "ws-child", "root", "root-turn", agentactivitybiz.TurnOriginUserPrompt, 100)
	prepareTerminalAnalyticsClaim(t, store, "ws-child", "root", "root-turn", "submit-root", `{"uiMode":"agent"}`, 101)
	seedTerminalAnalyticsSession(t, store, "ws-child", "child", agentactivitybiz.SessionKindChild, "root", "root-turn")
	seedTerminalAnalyticsTurn(t, store, "ws-child", "child", "child-turn", agentactivitybiz.TurnOriginProviderInitiated, 110)

	providerCompleted, err := store.ReportActivityState(ctx, agentactivitybiz.ActivityStateReport{
		Session: agentactivitybiz.SessionStateReport{
			WorkspaceID: "ws-child", AgentSessionID: "root", OccurredAtUnixMS: 120,
		},
		RootProviderTurn: &agentactivitybiz.RootProviderTurnTransition{
			WorkspaceID: "ws-child", RootAgentSessionID: "root", RootTurnID: "root-turn",
			ProviderTurnID: "provider-turn", Phase: agentactivitybiz.RootProviderTurnPhaseCompleted,
			Outcome: agentactivitybiz.TurnOutcomeCompleted, OccurredAtUnixMS: 120,
		},
	})
	if err != nil || !providerCompleted.RootTurnAccepted || providerCompleted.RootTurn.Phase != agentactivitybiz.TurnPhaseWaiting {
		t.Fatalf("provider completion=%#v err=%v", providerCompleted, err)
	}
	terminalInput := agentactivitybiz.ActivityStateReport{
		Session: agentactivitybiz.SessionStateReport{
			WorkspaceID: "ws-child", AgentSessionID: "child", OccurredAtUnixMS: 130,
		},
		Turn: &agentactivitybiz.TurnTransition{
			WorkspaceID: "ws-child", AgentSessionID: "child", TurnID: "child-turn",
			Phase: agentactivitybiz.TurnPhaseSettled, Outcome: agentactivitybiz.TurnOutcomeCompleted,
			SettledAtUnixMS: 130, OccurredAtUnixMS: 130,
		},
	}
	terminal, err := store.ReportActivityState(ctx, terminalInput)
	if err != nil || !terminal.RootTurnAccepted || terminal.RootTurn.Phase != agentactivitybiz.TurnPhaseSettled {
		t.Fatalf("child terminal=%#v err=%v", terminal, err)
	}
	var rootRows, childRows int
	if err := store.writeDB.QueryRowContext(ctx, `
SELECT COUNT(*) FROM agent_turn_terminal_analytics
WHERE workspace_id = 'ws-child' AND agent_session_id = 'root' AND turn_id = 'root-turn'
`).Scan(&rootRows); err != nil {
		t.Fatal(err)
	}
	if err := store.writeDB.QueryRowContext(ctx, `
SELECT COUNT(*) FROM agent_turn_terminal_analytics
WHERE workspace_id = 'ws-child' AND agent_session_id = 'child'
`).Scan(&childRows); err != nil {
		t.Fatal(err)
	}
	if rootRows != 1 || childRows != 0 {
		t.Fatalf("terminal marker rows root=%d child=%d", rootRows, childRows)
	}
	if _, err := store.ReportActivityState(ctx, terminalInput); err != nil {
		t.Fatalf("terminal replay err=%v", err)
	}
	assertTerminalAnalyticsRows(t, store, "ws-child", "root", 1)
	delivery, found, err := store.ClaimAgentTurnTerminalAnalytics(ctx, "owner", 200, 300)
	if err != nil || !found || delivery.AgentSessionID != "root" || delivery.TurnID != "root-turn" {
		t.Fatalf("root delivery=%#v found=%v err=%v", delivery, found, err)
	}
}

func seedTerminalAnalyticsWorkspace(t *testing.T, store *SQLiteStore, workspaceID string) {
	t.Helper()
	if err := store.Create(context.Background(), workspacebiz.Summary{ID: workspaceID, Name: workspaceID}); err != nil {
		t.Fatal(err)
	}
}

func seedTerminalAnalyticsSession(t *testing.T, store *SQLiteStore, workspaceID, sessionID, kind, rootSessionID, rootTurnID string) {
	t.Helper()
	input := agentactivitybiz.SessionStateReport{
		WorkspaceID: workspaceID, AgentSessionID: sessionID, Kind: kind,
		RootAgentSessionID: rootSessionID, RootTurnID: rootTurnID,
		Origin: "runtime", Provider: "codex", Status: "active", CurrentPhase: "working",
		OccurredAtUnixMS: 10,
	}
	if kind == agentactivitybiz.SessionKindChild {
		input.ParentAgentSessionID = rootSessionID
		input.ParentTurnID = rootTurnID
		input.ParentToolCallID = "tool-" + sessionID
	}
	if _, err := store.ReportSessionState(context.Background(), input); err != nil {
		t.Fatal(err)
	}
}

func seedTerminalAnalyticsTurn(t *testing.T, store *SQLiteStore, workspaceID, sessionID, turnID, origin string, occurred int64) {
	t.Helper()
	if _, accepted, err := store.AgentCanonicalStore().RecordTurnTransition(context.Background(), agentactivitybiz.TurnTransition{
		WorkspaceID: workspaceID, AgentSessionID: sessionID, TurnID: turnID,
		Phase: agentactivitybiz.TurnPhaseSubmitted, Origin: origin,
		StartedAtUnixMS: occurred, OccurredAtUnixMS: occurred,
	}); err != nil || !accepted {
		t.Fatalf("seed turn %q accepted=%v err=%v", turnID, accepted, err)
	}
}

func settleTerminalAnalyticsTurn(t *testing.T, store *SQLiteStore, workspaceID, sessionID, turnID string, occurred int64) {
	t.Helper()
	if _, accepted, err := store.AgentCanonicalStore().RecordTurnTransition(context.Background(), agentactivitybiz.TurnTransition{
		WorkspaceID: workspaceID, AgentSessionID: sessionID, TurnID: turnID,
		Phase: agentactivitybiz.TurnPhaseSettled, Outcome: agentactivitybiz.TurnOutcomeCompleted,
		SettledAtUnixMS: occurred, OccurredAtUnixMS: occurred,
	}); err != nil || !accepted {
		t.Fatalf("settle turn %q accepted=%v err=%v", turnID, accepted, err)
	}
}

func prepareTerminalAnalyticsClaim(t *testing.T, store *SQLiteStore, workspaceID, sessionID, turnID, clientSubmitID, metadataJSON string, occurred int64) {
	t.Helper()
	if _, created, err := store.PrepareSubmitClaim(context.Background(), agentactivitybiz.SubmitClaimPrepare{
		WorkspaceID: workspaceID, AgentSessionID: sessionID, CanonicalTurnID: turnID,
		ClientSubmitID: clientSubmitID, MetadataJSON: metadataJSON, NowUnixMS: occurred,
	}); err != nil || !created {
		t.Fatalf("prepare claim %q created=%v err=%v", clientSubmitID, created, err)
	}
}

func recordTerminalAnalyticsSubmission(t *testing.T, store *SQLiteStore, workspaceID, sessionID, turnID, clientSubmitID, metadataJSON string, occurred int64) {
	t.Helper()
	if _, created, err := store.AgentCanonicalStore().RecordTurnSubmission(context.Background(), agentactivitybiz.TurnSubmission{
		WorkspaceID: workspaceID, AgentSessionID: sessionID, TurnID: turnID,
		ContentJSON: `[]`, CapabilityRefsJSON: `[]`, TuttiModeSnapshotJSON: `{}`,
		MetadataJSON: metadataJSON, ClientSubmitID: clientSubmitID,
		CreatedAtUnixMS: occurred, UpdatedAtUnixMS: occurred,
	}); err != nil || !created {
		t.Fatalf("record submission %q created=%v err=%v", turnID, created, err)
	}
}

func assertTerminalAnalyticsRows(t *testing.T, store *SQLiteStore, workspaceID, sessionID string, want int) {
	t.Helper()
	var got int
	if err := store.writeDB.QueryRowContext(context.Background(), `
SELECT COUNT(*) FROM agent_turn_terminal_analytics
WHERE workspace_id = ? AND agent_session_id = ?
`, workspaceID, sessionID).Scan(&got); err != nil || got != want {
		t.Fatalf("terminal analytics rows workspace=%q session=%q got=%d want=%d err=%v", workspaceID, sessionID, got, want, err)
	}
}

func twoDigit(value int) string {
	return string(rune('0'+value/10)) + string(rune('0'+value%10))
}
