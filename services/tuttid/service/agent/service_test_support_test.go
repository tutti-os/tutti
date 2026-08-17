package agent

import (
	"context"
	"slices"
	"strings"
	"testing"

	agentactivitybiz "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
	reporterservice "github.com/tutti-os/tutti/services/tuttid/service/reporter"
)

type fakeAgentTargetLookup struct {
	targets map[string]agenttargetbiz.Target
}

func (f fakeAgentTargetLookup) GetAgentTarget(_ context.Context, id string) (agenttargetbiz.Target, error) {
	target, ok := f.targets[strings.TrimSpace(id)]
	if !ok {
		return agenttargetbiz.Target{}, workspacedata.ErrAgentTargetNotFound
	}
	return target, nil
}

type activityProjectionRepoStub struct {
	clearResult     agentactivitybiz.ClearSessionsResult
	settleStaleErr  error
	settlements     []agentactivitybiz.StaleTurnSettlement
	stateResult     agentactivitybiz.StateReportResult
	stateInput      agentactivitybiz.SessionStateReport
	messageInput    agentactivitybiz.SessionMessageReport
	messageResult   agentactivitybiz.MessageReportResult
	messagePage     agentactivitybiz.MessagePage
	messagePageOK   bool
	messagePageErr  error
	turnResult      agentactivitybiz.Turn
	turnResults     map[string]agentactivitybiz.Turn
	turnFound       bool
	turnErr         error
	sectionsPage    agentactivitybiz.SessionSectionsPage
	sectionsOK      bool
	sectionsErr     error
	submission      agentactivitybiz.TurnSubmission
	submissionFound bool
	submissionErr   error
}

func (r *activityProjectionRepoStub) ClearSessions(context.Context, string) (agentactivitybiz.ClearSessionsResult, error) {
	return r.clearResult, nil
}

func (*activityProjectionRepoStub) ListDeletedSessions(context.Context, agentactivitybiz.ListDeletedSessionsInput) (agentactivitybiz.DeletedSessionPage, error) {
	return agentactivitybiz.DeletedSessionPage{}, nil
}

func (*activityProjectionRepoStub) RestoreDeletedSession(context.Context, agentactivitybiz.RestoreDeletedSessionInput) (agentactivitybiz.RestoreDeletedSessionResult, error) {
	return agentactivitybiz.RestoreDeletedSessionResult{}, nil
}

func (*activityProjectionRepoStub) PurgeDeletedSessionTrees(context.Context, agentactivitybiz.PurgeDeletedSessionTreesInput) (agentactivitybiz.PurgeDeletedSessionTreesResult, error) {
	return agentactivitybiz.PurgeDeletedSessionTreesResult{}, nil
}

func (*activityProjectionRepoStub) ListRecoverableDeletedSessionResources(context.Context) ([]agentactivitybiz.DeletedSessionResource, error) {
	return []agentactivitybiz.DeletedSessionResource{}, nil
}

func (*activityProjectionRepoStub) GetSession(context.Context, string, string) (agentactivitybiz.Session, bool, error) {
	return agentactivitybiz.Session{}, false, nil
}

func (*activityProjectionRepoStub) ListChildSessions(context.Context, string, string) ([]agentactivitybiz.Session, error) {
	return nil, nil
}

func (*activityProjectionRepoStub) SessionDeleted(context.Context, string, string) (bool, error) {
	return false, nil
}

func (*activityProjectionRepoStub) ListSessions(context.Context, string) ([]agentactivitybiz.Session, bool, error) {
	return nil, false, nil
}

func (*activityProjectionRepoStub) ListSessionsPage(context.Context, agentactivitybiz.ListSessionsPageInput) (agentactivitybiz.SessionListPage, bool, error) {
	return agentactivitybiz.SessionListPage{}, false, nil
}

func (*activityProjectionRepoStub) ListSessionSection(context.Context, agentactivitybiz.ListSessionSectionInput) (agentactivitybiz.SessionSectionPage, bool, error) {
	return agentactivitybiz.SessionSectionPage{}, false, nil
}

func (r *activityProjectionRepoStub) ListSessionSections(context.Context, agentactivitybiz.ListSessionSectionsInput) (agentactivitybiz.SessionSectionsPage, bool, error) {
	return r.sectionsPage, r.sectionsOK, r.sectionsErr
}

func (*activityProjectionRepoStub) ListSessionSectionDeletionCandidates(context.Context, agentactivitybiz.ListSessionSectionDeletionCandidatesInput) (agentactivitybiz.SessionSectionDeletionCandidates, bool, error) {
	return agentactivitybiz.SessionSectionDeletionCandidates{}, false, nil
}

func (*activityProjectionRepoStub) DeleteSessionsBatch(context.Context, agentactivitybiz.DeleteSessionsBatchInput) (agentactivitybiz.DeleteSessionsBatchResult, error) {
	return agentactivitybiz.DeleteSessionsBatchResult{}, nil
}

func (*activityProjectionRepoStub) PlanDeleteSessions(_ context.Context, input agentactivitybiz.DeleteSessionsBatchInput) (agentactivitybiz.DeleteSessionsPlan, error) {
	return agentactivitybiz.DeleteSessionsPlan{WorkspaceID: input.WorkspaceID, SessionIDs: input.SessionIDs}, nil
}

func (*activityProjectionRepoStub) PlanClearSessions(_ context.Context, workspaceID string) (agentactivitybiz.DeleteSessionsPlan, error) {
	return agentactivitybiz.DeleteSessionsPlan{WorkspaceID: workspaceID}, nil
}

func (r *activityProjectionRepoStub) ListSessionMessages(context.Context, agentactivitybiz.ListSessionMessagesInput) (agentactivitybiz.MessagePage, bool, error) {
	return r.messagePage, r.messagePageOK, r.messagePageErr
}

func (*activityProjectionRepoStub) ListWorkspaceGeneratedFileTurns(context.Context, agentactivitybiz.ListWorkspaceGeneratedFileTurnsInput) (agentactivitybiz.GeneratedFileTurnList, bool, error) {
	return agentactivitybiz.GeneratedFileTurnList{}, false, nil
}

func (r *activityProjectionRepoStub) ReportSessionMessages(_ context.Context, input agentactivitybiz.SessionMessageReport) (agentactivitybiz.MessageReportResult, error) {
	r.messageInput = input
	return r.messageResult, nil
}

func (r *activityProjectionRepoStub) ReportSessionState(_ context.Context, input agentactivitybiz.SessionStateReport) (agentactivitybiz.StateReportResult, error) {
	r.stateInput = input
	return r.stateResult, nil
}

func (r *activityProjectionRepoStub) ReportActivityState(_ context.Context, input agentactivitybiz.ActivityStateReport) (agentactivitybiz.ActivityStateReportResult, error) {
	r.stateInput = input.Session
	result := agentactivitybiz.ActivityStateReportResult{State: r.stateResult}
	if input.Turn != nil {
		result.Turn = agentactivitybiz.Turn{
			WorkspaceID:    input.Turn.WorkspaceID,
			AgentSessionID: input.Turn.AgentSessionID,
			TurnID:         input.Turn.TurnID,
			Phase:          input.Turn.Phase,
			Outcome:        input.Turn.Outcome,
		}
		result.TurnAccepted = true
	}
	if input.Interaction != nil {
		result.Interaction = agentactivitybiz.Interaction{
			WorkspaceID:    input.Interaction.WorkspaceID,
			AgentSessionID: input.Interaction.AgentSessionID,
			RequestID:      input.Interaction.RequestID,
			TurnID:         input.Interaction.TurnID,
			Kind:           input.Interaction.Kind,
			Status:         input.Interaction.Status,
		}
		result.InteractionResult = agentactivitybiz.InteractionTransitionApplied
	}
	return result, nil
}

func (*activityProjectionRepoStub) UpdateSessionPinned(context.Context, string, string, bool) (agentactivitybiz.Session, bool, error) {
	return agentactivitybiz.Session{}, false, nil
}

func (*activityProjectionRepoStub) UpdateSessionSettings(context.Context, string, string, string, map[string]any) (agentactivitybiz.Session, bool, error) {
	return agentactivitybiz.Session{}, false, nil
}

func (*activityProjectionRepoStub) UpdateSessionTitle(context.Context, string, string, string) (agentactivitybiz.Session, bool, error) {
	return agentactivitybiz.Session{}, false, nil
}

func (r *activityProjectionRepoStub) GetTurn(_ context.Context, _ string, agentSessionID string, turnID string) (agentactivitybiz.Turn, bool, error) {
	if r.turnResults != nil {
		turn, ok := r.turnResults[agentSessionID+"\x00"+turnID]
		return turn, ok, r.turnErr
	}
	return r.turnResult, r.turnFound, r.turnErr
}

func (r *activityProjectionRepoStub) GetTurnSubmission(context.Context, string, string, string) (agentactivitybiz.TurnSubmission, bool, error) {
	return r.submission, r.submissionFound, r.submissionErr
}

func (*activityProjectionRepoStub) GetLatestTurn(context.Context, string, string) (agentactivitybiz.Turn, bool, error) {
	return agentactivitybiz.Turn{}, false, nil
}

func (*activityProjectionRepoStub) ListLatestTurns(context.Context, string, []string) (map[string]agentactivitybiz.Turn, error) {
	return map[string]agentactivitybiz.Turn{}, nil
}

func (*activityProjectionRepoStub) ListTurnsBySession(context.Context, string, map[string]string) (map[string]agentactivitybiz.Turn, error) {
	return map[string]agentactivitybiz.Turn{}, nil
}

func (*activityProjectionRepoStub) ListPendingInteractionsBySession(context.Context, string, []string) (map[string][]agentactivitybiz.Interaction, error) {
	return map[string][]agentactivitybiz.Interaction{}, nil
}

func (*activityProjectionRepoStub) ListLatestTurnInteractions(context.Context, string, []string) (map[string][]agentactivitybiz.Interaction, error) {
	return map[string][]agentactivitybiz.Interaction{}, nil
}

func (*activityProjectionRepoStub) PrepareRuntimeOperation(context.Context, agentactivitybiz.RuntimeOperationPrepare) (agentactivitybiz.RuntimeOperation, bool, error) {
	return agentactivitybiz.RuntimeOperation{}, false, nil
}

func (*activityProjectionRepoStub) PrepareInteractiveRuntimeOperation(context.Context, agentactivitybiz.RuntimeOperationPrepare) (agentactivitybiz.RuntimeOperation, agentactivitybiz.Interaction, agentactivitybiz.InteractionTransitionResult, error) {
	return agentactivitybiz.RuntimeOperation{}, agentactivitybiz.Interaction{}, agentactivitybiz.InteractionTransitionConflict, nil
}

func (*activityProjectionRepoStub) GetRuntimeOperation(context.Context, string, string) (agentactivitybiz.RuntimeOperation, bool, error) {
	return agentactivitybiz.RuntimeOperation{}, false, nil
}

func (*activityProjectionRepoStub) ListClaimableRuntimeOperations(context.Context, agentactivitybiz.ListClaimableRuntimeOperationsInput) ([]agentactivitybiz.RuntimeOperation, error) {
	return nil, nil
}

func (*activityProjectionRepoStub) ClaimRuntimeOperationLease(context.Context, agentactivitybiz.ClaimRuntimeOperationLeaseInput) (agentactivitybiz.RuntimeOperation, bool, error) {
	return agentactivitybiz.RuntimeOperation{}, false, nil
}

func (*activityProjectionRepoStub) ReleaseOrFailRuntimeOperation(context.Context, agentactivitybiz.ReleaseOrFailRuntimeOperationInput) (agentactivitybiz.RuntimeOperation, bool, error) {
	return agentactivitybiz.RuntimeOperation{}, false, nil
}

func (*activityProjectionRepoStub) RequeueLeasedRuntimeOperationsOnStartup(context.Context, int64) (int64, error) {
	return 0, nil
}

func (*activityProjectionRepoStub) CompleteInteractiveRuntimeOperation(context.Context, agentactivitybiz.CompleteInteractiveRuntimeOperationInput) (agentactivitybiz.RuntimeOperationCompletion, bool, error) {
	return agentactivitybiz.RuntimeOperationCompletion{}, false, nil
}

func (*activityProjectionRepoStub) CompleteCancelRuntimeOperation(context.Context, agentactivitybiz.CompleteCancelRuntimeOperationInput) (agentactivitybiz.RuntimeOperationCompletion, bool, error) {
	return agentactivitybiz.RuntimeOperationCompletion{}, false, nil
}

func (*activityProjectionRepoStub) ListPendingRuntimeOperationEvents(context.Context, string, int) ([]agentactivitybiz.RuntimeOperationEvent, error) {
	return nil, nil
}

func (*activityProjectionRepoStub) MarkRuntimeOperationEventPublished(context.Context, string, int64, int64) (bool, error) {
	return false, nil
}

func (*activityProjectionRepoStub) ListSessionTurns(context.Context, string, string) ([]agentactivitybiz.Turn, error) {
	return nil, nil
}

func (*activityProjectionRepoStub) ListEffectiveSessionTurns(context.Context, string, string) ([]agentactivitybiz.Turn, error) {
	return nil, nil
}

func (*activityProjectionRepoStub) RecordTurnTransition(_ context.Context, transition agentactivitybiz.TurnTransition) (agentactivitybiz.Turn, bool, error) {
	return agentactivitybiz.Turn{
		WorkspaceID:    transition.WorkspaceID,
		AgentSessionID: transition.AgentSessionID,
		TurnID:         transition.TurnID,
		Phase:          transition.Phase,
		Outcome:        transition.Outcome,
	}, true, nil
}

func (r *activityProjectionRepoStub) SettleStaleTurns(context.Context) ([]agentactivitybiz.StaleTurnSettlement, error) {
	return append([]agentactivitybiz.StaleTurnSettlement(nil), r.settlements...), r.settleStaleErr
}

func (*activityProjectionRepoStub) UpsertInteraction(_ context.Context, upsert agentactivitybiz.InteractionUpsert) (agentactivitybiz.Interaction, agentactivitybiz.InteractionTransitionResult, error) {
	return agentactivitybiz.Interaction{
		WorkspaceID:    upsert.WorkspaceID,
		AgentSessionID: upsert.AgentSessionID,
		RequestID:      upsert.RequestID,
		TurnID:         upsert.TurnID,
		Kind:           upsert.Kind,
		Status:         upsert.Status,
	}, agentactivitybiz.InteractionTransitionApplied, nil
}

func (*activityProjectionRepoStub) ListSessionInteractions(context.Context, agentactivitybiz.ListSessionInteractionsInput) ([]agentactivitybiz.Interaction, error) {
	return nil, nil
}

type publishedActivityUpdate struct {
	workspaceID    string
	agentSessionID string
	eventType      string
	payload        map[string]any
}

type activityUpdatePublisherStub struct {
	events []publishedActivityUpdate
}

func (p *activityUpdatePublisherStub) PublishAgentActivityUpdated(_ context.Context, workspaceID string, agentSessionID string, eventType string, payload map[string]any) error {
	p.events = append(p.events, publishedActivityUpdate{
		workspaceID:    workspaceID,
		agentSessionID: agentSessionID,
		eventType:      eventType,
		payload:        payload,
	})
	return nil
}

type recordingAgentAnalyticsReporter struct {
	events []reporterservice.Event
}

func (r *recordingAgentAnalyticsReporter) Track(_ context.Context, events ...reporterservice.Event) {
	r.events = append(r.events, events...)
}

func (*recordingAgentAnalyticsReporter) Close() error {
	return nil
}

func assertAgentNodeSequence(t *testing.T, events []reporterservice.Event, want []string) {
	t.Helper()
	got := make([]string, 0, len(events))
	for _, event := range events {
		if event.Name != "agent.node_result" {
			continue
		}
		if node, ok := event.Params["node"].(string); ok {
			got = append(got, node)
		}
	}
	if !slices.Equal(got, want) {
		t.Fatalf("agent node sequence = %#v, want %#v; events = %#v", got, want, events)
	}
}

func stringRef(value string) *string {
	return &value
}
