package workspace

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
	agentactivitybiz "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
)

var _ agentactivitybiz.Repository = (*SQLiteStore)(nil)
var _ AgentActivityStore = (*SQLiteStore)(nil)

// Agent activity and agent target persistence is delegated to the
// embeddable packages/agent/store-sqlite module, sharing this store's
// database handle. The delegation below keeps tuttid's persistence seams thin
// while store-sqlite owns canonical query and migration behavior.

var _ AgentActivityStore = (*SQLiteStore)(nil)

const legacyIDLocalCodex = "local-codex"
const legacyIDLocalClaudeCode = "local-claude-code"

func newAgentStore(db *sql.DB) *agentactivitybiz.Store {
	return agentactivitybiz.New(db, agentactivitybiz.Options{
		WorkspaceExists: func(ctx context.Context, workspaceID string) error {
			return ensureWorkspaceExistsOn(ctx, db, workspaceID)
		},
		ProjectPaths:           userProjectPathsQuerier{},
		NormalizeTarget:        normalizeStoreAgentTarget,
		IsSkippableTargetError: isSkippableAgentTargetRowError,
		SeedSystemTargets:      defaultSystemStoreAgentTargets,
		LegacySystemTargetIDRenames: map[string]string{
			legacyIDLocalCodex:      agenttargetbiz.IDLocalCodex,
			legacyIDLocalClaudeCode: agenttargetbiz.IDLocalClaudeCode,
		},
		TargetIDBackfillByProvider: defaultTargetIDBackfillByProvider(),
		TransactionParticipant: agentTransactionParticipants{
			tuttiModeSourceActivityParticipant{},
			agentTurnTerminalAnalyticsParticipant{},
		},
	})
}

func defaultTargetIDBackfillByProvider() map[string]string {
	result := map[string]string{
		"claude-code": agenttargetbiz.IDLocalClaudeCode,
		"cursor":      agenttargetbiz.IDLocalCursor,
	}
	for _, descriptor := range providerregistry.Migrated() {
		result[descriptor.Identity.ID] = descriptor.Target.ID
	}
	return result
}

func (s *SQLiteStore) agentStore() *agentactivitybiz.Store {
	if s == nil {
		return nil
	}
	return s.agentWriter
}

// AgentCanonicalStore exposes the official canonical agent store for Host
// composition. Product services must not wrap its lifecycle mutations.
func (s *SQLiteStore) AgentCanonicalStore() *agentactivitybiz.Store {
	return s.agentStore()
}

func (s *SQLiteStore) agentReadStore() *agentactivitybiz.Store {
	if s == nil {
		return nil
	}
	if s.agentReader != nil {
		return s.agentReader
	}
	return s.agentWriter
}

// userProjectPathsQuerier feeds the user_projects table into the agent
// store's rail section classification, using whatever querier (transaction
// or database) the store is currently running on.
type userProjectPathsQuerier struct{}

func (userProjectPathsQuerier) ProjectPaths(ctx context.Context, q agentactivitybiz.Querier) ([]string, error) {
	rows, err := q.QueryContext(ctx, `
SELECT path
FROM user_projects
WHERE TRIM(path) != ''
ORDER BY length(path) DESC, path ASC
`)
	if err != nil {
		return nil, fmt.Errorf("list user projects for workspace agent session rail classification: %w", err)
	}
	defer rows.Close()

	paths := make([]string, 0)
	for rows.Next() {
		var path string
		if err := rows.Scan(&path); err != nil {
			return nil, fmt.Errorf("scan user project for workspace agent session rail classification: %w", err)
		}
		path = strings.TrimSpace(path)
		if path != "" {
			paths = append(paths, path)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate user projects for workspace agent session rail classification: %w", err)
	}
	return paths, nil
}

func (s *SQLiteStore) ReportSessionState(ctx context.Context, input agentactivitybiz.SessionStateReport) (agentactivitybiz.StateReportResult, error) {
	return s.agentStore().ReportSessionState(ctx, input)
}

func (s *SQLiteStore) BindGoalProvenance(ctx context.Context, input agentactivitybiz.BindGoalProvenanceInput) (agentactivitybiz.GoalProvenanceBinding, error) {
	return s.agentStore().BindGoalProvenance(ctx, input)
}

func (s *SQLiteStore) LookupGoalProvenance(ctx context.Context, input agentactivitybiz.LookupGoalProvenanceInput) (agentactivitybiz.GoalProvenanceBinding, bool, error) {
	return s.agentReadStore().LookupGoalProvenance(ctx, input)
}

func (s *SQLiteStore) ReportActivityState(ctx context.Context, input agentactivitybiz.ActivityStateReport) (agentactivitybiz.ActivityStateReportResult, error) {
	return s.agentStore().ReportActivityState(ctx, input)
}

func (s *SQLiteStore) ReportSessionMessages(ctx context.Context, input agentactivitybiz.SessionMessageReport) (agentactivitybiz.MessageReportResult, error) {
	return s.agentStore().ReportSessionMessages(ctx, input)
}

func (s *SQLiteStore) PutGoalReconcileInbox(ctx context.Context, input agentactivitybiz.GoalReconcileInboxItem) (bool, error) {
	return s.agentStore().PutGoalReconcileInbox(ctx, input)
}

func (s *SQLiteStore) ListClaimableGoalReconcileInbox(ctx context.Context, now int64, limit int) ([]agentactivitybiz.GoalReconcileInboxItem, error) {
	return s.agentReadStore().ListClaimableGoalReconcileInbox(ctx, now, limit)
}

func (s *SQLiteStore) ClaimGoalReconcileInbox(ctx context.Context, input agentactivitybiz.ClaimGoalReconcileInboxInput) (agentactivitybiz.GoalReconcileInboxItem, bool, error) {
	return s.agentStore().ClaimGoalReconcileInbox(ctx, input)
}

func (s *SQLiteStore) CompleteGoalReconcileInbox(ctx context.Context, requestID, owner string, now int64) (bool, error) {
	return s.agentStore().CompleteGoalReconcileInbox(ctx, requestID, owner, now)
}

func (s *SQLiteStore) ReleaseGoalReconcileInbox(ctx context.Context, input agentactivitybiz.ReleaseGoalReconcileInboxInput) (bool, error) {
	return s.agentStore().ReleaseGoalReconcileInbox(ctx, input)
}

func (s *SQLiteStore) RequeueLeasedGoalReconcileInboxOnStartup(ctx context.Context, now int64) (int64, error) {
	return s.agentStore().RequeueLeasedGoalReconcileInboxOnStartup(ctx, now)
}

func (s *SQLiteStore) GetSession(ctx context.Context, workspaceID string, agentSessionID string) (agentactivitybiz.Session, bool, error) {
	return s.agentReadStore().GetSession(ctx, workspaceID, agentSessionID)
}

func (s *SQLiteStore) ListChildSessions(ctx context.Context, workspaceID string, agentSessionID string) ([]agentactivitybiz.Session, error) {
	return s.agentReadStore().ListChildSessions(ctx, workspaceID, agentSessionID)
}

func (s *SQLiteStore) SessionDeleted(ctx context.Context, workspaceID string, agentSessionID string) (bool, error) {
	return s.agentReadStore().SessionDeleted(ctx, workspaceID, agentSessionID)
}

func (s *SQLiteStore) ListDeletedSessions(ctx context.Context, input agentactivitybiz.ListDeletedSessionsInput) (agentactivitybiz.DeletedSessionPage, error) {
	return s.agentReadStore().ListDeletedSessions(ctx, input)
}

func (s *SQLiteStore) RestoreDeletedSession(ctx context.Context, input agentactivitybiz.RestoreDeletedSessionInput) (agentactivitybiz.RestoreDeletedSessionResult, error) {
	return s.agentStore().RestoreDeletedSession(ctx, input)
}

func (s *SQLiteStore) PurgeDeletedSessionTrees(ctx context.Context, input agentactivitybiz.PurgeDeletedSessionTreesInput) (agentactivitybiz.PurgeDeletedSessionTreesResult, error) {
	if s == nil || s.writeDB == nil {
		return agentactivitybiz.PurgeDeletedSessionTreesResult{}, errors.New("workspace database is not initialized")
	}
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return agentactivitybiz.PurgeDeletedSessionTreesResult{}, fmt.Errorf("begin purge deleted agent and Tutti mode sessions: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	result, err := s.agentStore().PurgeDeletedSessionTreesTx(ctx, tx, input)
	if err != nil {
		return agentactivitybiz.PurgeDeletedSessionTreesResult{}, err
	}
	if err := deleteTuttiModeSessionStatesTx(ctx, tx, strings.TrimSpace(input.WorkspaceID), result.PurgedSessionIDs); err != nil {
		return agentactivitybiz.PurgeDeletedSessionTreesResult{}, err
	}
	cleanupItems := make([]AgentSessionResourceCleanup, 0, len(result.PurgedSessionIDs))
	for _, sessionID := range result.PurgedSessionIDs {
		cleanupItems = append(cleanupItems, AgentSessionResourceCleanup{
			WorkspaceID: strings.TrimSpace(input.WorkspaceID), AgentSessionID: sessionID,
		})
	}
	if err := enqueueAgentSessionResourceCleanupTx(ctx, tx, cleanupItems); err != nil {
		return agentactivitybiz.PurgeDeletedSessionTreesResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return agentactivitybiz.PurgeDeletedSessionTreesResult{}, fmt.Errorf("commit purge deleted agent and Tutti mode sessions: %w", err)
	}
	return result, nil
}

func (s *SQLiteStore) ListRecoverableDeletedSessionResources(ctx context.Context) ([]agentactivitybiz.DeletedSessionResource, error) {
	return s.agentReadStore().ListRecoverableDeletedSessionResources(ctx)
}

func (s *SQLiteStore) RollbackRuntimeSessionInitialization(ctx context.Context, workspaceID string, agentSessionID string) (bool, error) {
	return s.agentStore().RollbackRuntimeSessionInitialization(ctx, workspaceID, agentSessionID)
}

func (s *SQLiteStore) ListSessions(ctx context.Context, workspaceID string) ([]agentactivitybiz.Session, bool, error) {
	return s.agentReadStore().ListSessions(ctx, workspaceID)
}

func (s *SQLiteStore) ListSessionsPage(ctx context.Context, input agentactivitybiz.ListSessionsPageInput) (agentactivitybiz.SessionListPage, bool, error) {
	return s.agentReadStore().ListSessionsPage(ctx, input)
}

func (s *SQLiteStore) ListSessionSection(ctx context.Context, input agentactivitybiz.ListSessionSectionInput) (agentactivitybiz.SessionSectionPage, bool, error) {
	return s.agentReadStore().ListSessionSection(ctx, input)
}

func (s *SQLiteStore) ListSessionSections(ctx context.Context, input agentactivitybiz.ListSessionSectionsInput) (agentactivitybiz.SessionSectionsPage, bool, error) {
	return s.agentReadStore().ListSessionSections(ctx, input)
}

func (s *SQLiteStore) ListSessionSectionDeletionCandidates(ctx context.Context, input agentactivitybiz.ListSessionSectionDeletionCandidatesInput) (agentactivitybiz.SessionSectionDeletionCandidates, bool, error) {
	return s.agentReadStore().ListSessionSectionDeletionCandidates(ctx, input)
}

func (s *SQLiteStore) ListSessionMessages(ctx context.Context, input agentactivitybiz.ListSessionMessagesInput) (agentactivitybiz.MessagePage, bool, error) {
	return s.agentReadStore().ListSessionMessages(ctx, input)
}

func (s *SQLiteStore) ListWorkspaceGeneratedFileTurns(ctx context.Context, input agentactivitybiz.ListWorkspaceGeneratedFileTurnsInput) (agentactivitybiz.GeneratedFileTurnList, bool, error) {
	return s.agentReadStore().ListWorkspaceGeneratedFileTurns(ctx, input)
}

func (s *SQLiteStore) DeleteSession(ctx context.Context, workspaceID string, agentSessionID string) (bool, error) {
	return s.agentStore().DeleteSession(ctx, workspaceID, agentSessionID)
}

func (s *SQLiteStore) DeleteSessionWithCommit(ctx context.Context, workspaceID string, agentSessionID string) (agentactivitybiz.DeleteSessionResult, error) {
	return s.agentStore().DeleteSessionWithCommit(ctx, workspaceID, agentSessionID)
}

func (s *SQLiteStore) DeleteSessionsBatch(ctx context.Context, input agentactivitybiz.DeleteSessionsBatchInput) (agentactivitybiz.DeleteSessionsBatchResult, error) {
	return s.agentStore().DeleteSessionsBatch(ctx, input)
}

func (s *SQLiteStore) PlanDeleteSessions(ctx context.Context, input agentactivitybiz.DeleteSessionsBatchInput) (agentactivitybiz.DeleteSessionsPlan, error) {
	return s.agentReadStore().PlanDeleteSessions(ctx, input)
}

func (s *SQLiteStore) PlanClearSessions(ctx context.Context, workspaceID string) (agentactivitybiz.DeleteSessionsPlan, error) {
	return s.agentReadStore().PlanClearSessions(ctx, workspaceID)
}

func (s *SQLiteStore) ClearSessions(ctx context.Context, workspaceID string) (agentactivitybiz.ClearSessionsResult, error) {
	if s == nil || s.writeDB == nil {
		return agentactivitybiz.ClearSessionsResult{}, errors.New("workspace database is not initialized")
	}
	workspaceID = strings.TrimSpace(workspaceID)
	if workspaceID == "" {
		return agentactivitybiz.ClearSessionsResult{}, nil
	}
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return agentactivitybiz.ClearSessionsResult{}, fmt.Errorf("begin clear agent and Tutti mode sessions: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	result, err := s.agentStore().ClearSessionsTx(ctx, tx, workspaceID)
	if err != nil {
		return agentactivitybiz.ClearSessionsResult{}, err
	}
	if err := deleteTuttiModeWorkspaceSessionStateTx(ctx, tx, workspaceID); err != nil {
		return agentactivitybiz.ClearSessionsResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return agentactivitybiz.ClearSessionsResult{}, fmt.Errorf("commit clear agent and Tutti mode sessions: %w", err)
	}
	return result, nil
}

func deleteTuttiModeSessionStatesTx(ctx context.Context, tx *sql.Tx, workspaceID string, sessionIDs []string) error {
	for _, sessionID := range sessionIDs {
		sessionID = strings.TrimSpace(sessionID)
		if sessionID == "" {
			continue
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM tutti_mode_turn_snapshots WHERE workspace_id = ? AND agent_session_id = ?`, workspaceID, sessionID); err != nil {
			return fmt.Errorf("delete Tutti mode turn snapshots with agent session: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM tutti_mode_activations WHERE workspace_id = ? AND agent_session_id = ?`, workspaceID, sessionID); err != nil {
			return fmt.Errorf("delete Tutti mode activation with agent session: %w", err)
		}
	}
	return nil
}

func deleteTuttiModeWorkspaceSessionStateTx(ctx context.Context, tx *sql.Tx, workspaceID string) error {
	if _, err := tx.ExecContext(ctx, `DELETE FROM tutti_mode_turn_snapshots WHERE workspace_id = ?`, workspaceID); err != nil {
		return fmt.Errorf("clear Tutti mode turn snapshots with agent sessions: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM tutti_mode_activations WHERE workspace_id = ?`, workspaceID); err != nil {
		return fmt.Errorf("clear Tutti mode activations with agent sessions: %w", err)
	}
	return nil
}

func (s *SQLiteStore) PurgeDeletedSessions(ctx context.Context, input agentactivitybiz.PurgeDeletedSessionsInput) (agentactivitybiz.PurgeDeletedSessionsResult, error) {
	if s == nil || s.writeDB == nil {
		return agentactivitybiz.PurgeDeletedSessionsResult{}, errors.New("workspace database is not initialized")
	}
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return agentactivitybiz.PurgeDeletedSessionsResult{}, fmt.Errorf("begin purge deleted agent and Tutti mode sessions: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	result, err := s.agentStore().PurgeDeletedSessionsTx(ctx, tx, input)
	if err != nil {
		return agentactivitybiz.PurgeDeletedSessionsResult{}, err
	}
	sessionIDsByWorkspace := make(map[string][]string)
	cleanupItems := make([]AgentSessionResourceCleanup, 0, len(result.Sessions))
	for _, session := range result.Sessions {
		workspaceID := strings.TrimSpace(session.WorkspaceID)
		sessionIDsByWorkspace[workspaceID] = append(sessionIDsByWorkspace[workspaceID], session.AgentSessionID)
		cleanupItems = append(cleanupItems, AgentSessionResourceCleanup{
			WorkspaceID: workspaceID, AgentSessionID: session.AgentSessionID,
		})
	}
	for workspaceID, sessionIDs := range sessionIDsByWorkspace {
		if err := deleteTuttiModeSessionStatesTx(ctx, tx, workspaceID, sessionIDs); err != nil {
			return agentactivitybiz.PurgeDeletedSessionsResult{}, err
		}
	}
	if err := enqueueAgentSessionResourceCleanupTx(ctx, tx, cleanupItems); err != nil {
		return agentactivitybiz.PurgeDeletedSessionsResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return agentactivitybiz.PurgeDeletedSessionsResult{}, fmt.Errorf("commit purge deleted agent and Tutti mode sessions: %w", err)
	}
	return result, nil
}

func (s *SQLiteStore) UpdateSessionPinned(ctx context.Context, workspaceID string, agentSessionID string, pinned bool) (agentactivitybiz.Session, bool, error) {
	return s.agentStore().UpdateSessionPinned(ctx, workspaceID, agentSessionID, pinned)
}

func (s *SQLiteStore) UpdateSessionSettings(ctx context.Context, workspaceID string, agentSessionID string, model string, settings map[string]any) (agentactivitybiz.Session, bool, error) {
	return s.agentStore().UpdateSessionSettings(ctx, workspaceID, agentSessionID, model, settings)
}

func (s *SQLiteStore) UpdateSessionTitle(ctx context.Context, workspaceID string, agentSessionID string, title string) (agentactivitybiz.Session, bool, error) {
	return s.agentStore().UpdateSessionTitle(ctx, workspaceID, agentSessionID, title)
}

func (s *SQLiteStore) GetTurn(ctx context.Context, workspaceID string, agentSessionID string, turnID string) (agentactivitybiz.Turn, bool, error) {
	return s.agentReadStore().GetTurn(ctx, workspaceID, agentSessionID, turnID)
}

func (s *SQLiteStore) GetTurnSubmission(ctx context.Context, workspaceID string, agentSessionID string, turnID string) (agentactivitybiz.TurnSubmission, bool, error) {
	return s.agentReadStore().GetTurnSubmission(ctx, workspaceID, agentSessionID, turnID)
}

func (s *SQLiteStore) GetLatestTurn(ctx context.Context, workspaceID string, agentSessionID string) (agentactivitybiz.Turn, bool, error) {
	return s.agentReadStore().GetLatestTurn(ctx, workspaceID, agentSessionID)
}

func (s *SQLiteStore) ListLatestTurns(ctx context.Context, workspaceID string, agentSessionIDs []string) (map[string]agentactivitybiz.Turn, error) {
	return s.agentReadStore().ListLatestTurns(ctx, workspaceID, agentSessionIDs)
}

func (s *SQLiteStore) ListLatestTurnInteractions(ctx context.Context, workspaceID string, agentSessionIDs []string) (map[string][]agentactivitybiz.Interaction, error) {
	return s.agentReadStore().ListLatestTurnInteractions(ctx, workspaceID, agentSessionIDs)
}

func (s *SQLiteStore) ListTurnsBySession(ctx context.Context, workspaceID string, turnIDBySessionID map[string]string) (map[string]agentactivitybiz.Turn, error) {
	return s.agentReadStore().ListTurnsBySession(ctx, workspaceID, turnIDBySessionID)
}

func (s *SQLiteStore) ListPendingInteractionsBySession(ctx context.Context, workspaceID string, agentSessionIDs []string) (map[string][]agentactivitybiz.Interaction, error) {
	return s.agentReadStore().ListPendingInteractionsBySession(ctx, workspaceID, agentSessionIDs)
}

func (s *SQLiteStore) ListSessionTurns(ctx context.Context, workspaceID string, agentSessionID string) ([]agentactivitybiz.Turn, error) {
	return s.agentReadStore().ListSessionTurns(ctx, workspaceID, agentSessionID)
}

func (s *SQLiteStore) ListEffectiveSessionTurns(ctx context.Context, workspaceID string, agentSessionID string) ([]agentactivitybiz.Turn, error) {
	return s.agentReadStore().ListEffectiveSessionTurns(ctx, workspaceID, agentSessionID)
}

func (s *SQLiteStore) ListSessionTurnSummaries(ctx context.Context, input agentactivitybiz.ListSessionTurnSummariesInput) (agentactivitybiz.SessionTurnSummaryPage, error) {
	return s.agentReadStore().ListSessionTurnSummaries(ctx, input)
}

func (s *SQLiteStore) SettleStaleTurns(ctx context.Context) ([]agentactivitybiz.StaleTurnSettlement, error) {
	return s.agentStore().SettleStaleTurns(ctx)
}

func (s *SQLiteStore) ListSessionInteractions(ctx context.Context, input agentactivitybiz.ListSessionInteractionsInput) ([]agentactivitybiz.Interaction, error) {
	return s.agentReadStore().ListSessionInteractions(ctx, input)
}

func (s *SQLiteStore) PrepareRuntimeOperation(ctx context.Context, input agentactivitybiz.RuntimeOperationPrepare) (agentactivitybiz.RuntimeOperation, bool, error) {
	return s.agentStore().PrepareRuntimeOperation(ctx, input)
}

func (s *SQLiteStore) PrepareInteractiveRuntimeOperation(ctx context.Context, input agentactivitybiz.RuntimeOperationPrepare) (agentactivitybiz.RuntimeOperation, agentactivitybiz.Interaction, agentactivitybiz.InteractionTransitionResult, error) {
	return s.agentStore().PrepareInteractiveRuntimeOperation(ctx, input)
}

func (s *SQLiteStore) PrepareGoalControlOperation(ctx context.Context, input agentactivitybiz.GoalControlOperationPrepare) (agentactivitybiz.GoalControlOperation, agentactivitybiz.SessionGoalState, bool, error) {
	return s.agentStore().PrepareGoalControlOperation(ctx, input)
}

func (s *SQLiteStore) AdoptProviderGoalOperation(ctx context.Context, input agentactivitybiz.ProviderGoalAdoption) (agentactivitybiz.GoalControlOperation, agentactivitybiz.SessionGoalState, bool, error) {
	return s.agentStore().AdoptProviderGoalOperation(ctx, input)
}

func (s *SQLiteStore) GetGoalControlAudit(ctx context.Context, workspaceID string, agentSessionID string, operationID string) (agentactivitybiz.Message, bool, error) {
	return s.agentReadStore().GetGoalControlAudit(ctx, workspaceID, agentSessionID, operationID)
}

func (s *SQLiteStore) MarkGoalControlOperationDispatched(ctx context.Context, workspaceID, operationID string, occurredAtUnixMS int64) (agentactivitybiz.GoalControlOperation, bool, error) {
	return s.agentStore().MarkGoalControlOperationDispatched(ctx, workspaceID, operationID, occurredAtUnixMS)
}

func (s *SQLiteStore) AcknowledgeGoalControlOperation(ctx context.Context, input agentactivitybiz.GoalControlOperationAcknowledge) (agentactivitybiz.GoalControlOperation, agentactivitybiz.SessionGoalState, bool, error) {
	return s.agentStore().AcknowledgeGoalControlOperation(ctx, input)
}

func (s *SQLiteStore) CompleteGoalControlOperation(ctx context.Context, input agentactivitybiz.GoalControlOperationComplete) (agentactivitybiz.GoalControlOperation, agentactivitybiz.SessionGoalState, bool, error) {
	return s.agentStore().CompleteGoalControlOperation(ctx, input)
}

func (s *SQLiteStore) GetSessionGoalState(ctx context.Context, workspaceID, agentSessionID string) (agentactivitybiz.SessionGoalState, bool, error) {
	return s.agentReadStore().GetSessionGoalState(ctx, workspaceID, agentSessionID)
}

func (s *SQLiteStore) ListSessionGoalStates(ctx context.Context, workspaceID string, agentSessionIDs []string) (map[string]agentactivitybiz.SessionGoalState, error) {
	return s.agentReadStore().ListSessionGoalStates(ctx, workspaceID, agentSessionIDs)
}

func (s *SQLiteStore) ReconcileSessionGoalObservation(ctx context.Context, input agentactivitybiz.GoalObservationReconcile) (agentactivitybiz.SessionGoalState, error) {
	return s.agentStore().ReconcileSessionGoalObservation(ctx, input)
}

func (s *SQLiteStore) GetGoalControlOperation(ctx context.Context, workspaceID, operationID string) (agentactivitybiz.GoalControlOperation, bool, error) {
	return s.agentReadStore().GetGoalControlOperation(ctx, workspaceID, operationID)
}

func (s *SQLiteStore) ListClaimableGoalControlOperations(ctx context.Context, input agentactivitybiz.ListClaimableGoalControlOperationsInput) ([]agentactivitybiz.GoalControlOperation, error) {
	return s.agentReadStore().ListClaimableGoalControlOperations(ctx, input)
}

func (s *SQLiteStore) ClaimGoalControlOperation(ctx context.Context, input agentactivitybiz.ClaimGoalControlOperationInput) (agentactivitybiz.GoalControlOperation, bool, error) {
	return s.agentStore().ClaimGoalControlOperation(ctx, input)
}

func (s *SQLiteStore) ReleaseGoalControlOperation(ctx context.Context, input agentactivitybiz.ReleaseGoalControlOperationInput) (agentactivitybiz.GoalControlOperation, bool, error) {
	return s.agentStore().ReleaseGoalControlOperation(ctx, input)
}

func (s *SQLiteStore) RecordGoalControlOperationEvidence(ctx context.Context, input agentactivitybiz.GoalControlOperationEvidence) (agentactivitybiz.GoalControlOperation, bool, error) {
	return s.agentStore().RecordGoalControlOperationEvidence(ctx, input)
}

func (s *SQLiteStore) EnsureOrWakeGoalRepairOperation(ctx context.Context, input agentactivitybiz.EnsureGoalRepairOperationInput) (agentactivitybiz.GoalControlOperation, agentactivitybiz.SessionGoalState, bool, error) {
	return s.agentStore().EnsureOrWakeGoalRepairOperation(ctx, input)
}

func (s *SQLiteStore) MarkGoalRevisionTerminalIncident(ctx context.Context, input agentactivitybiz.GoalTerminalIncidentInput) (agentactivitybiz.SessionGoalState, error) {
	return s.agentStore().MarkGoalRevisionTerminalIncident(ctx, input)
}

func (s *SQLiteStore) RequeueLeasedGoalControlOperationsOnStartup(ctx context.Context, now int64) (int64, error) {
	return s.agentStore().RequeueLeasedGoalControlOperationsOnStartup(ctx, now)
}

func (s *SQLiteStore) PrepareGoalGenerationFence(ctx context.Context, input agentactivitybiz.GoalGenerationFencePrepare) (agentactivitybiz.GoalGenerationFence, bool, error) {
	return s.agentStore().PrepareGoalGenerationFence(ctx, input)
}

func (s *SQLiteStore) GetGoalGenerationFence(ctx context.Context, workspaceID, fenceID string) (agentactivitybiz.GoalGenerationFence, bool, error) {
	return s.agentReadStore().GetGoalGenerationFence(ctx, workspaceID, fenceID)
}

func (s *SQLiteStore) ListGoalGenerationFencesForSession(ctx context.Context, workspaceID, agentSessionID string) ([]agentactivitybiz.GoalGenerationFence, error) {
	return s.agentReadStore().ListGoalGenerationFencesForSession(ctx, workspaceID, agentSessionID)
}

func (s *SQLiteStore) ListClaimableGoalGenerationFences(ctx context.Context, input agentactivitybiz.ListClaimableGoalGenerationFencesInput) ([]agentactivitybiz.GoalGenerationFence, error) {
	return s.agentReadStore().ListClaimableGoalGenerationFences(ctx, input)
}

func (s *SQLiteStore) ClaimGoalGenerationFence(ctx context.Context, input agentactivitybiz.ClaimGoalGenerationFenceInput) (agentactivitybiz.GoalGenerationFence, bool, error) {
	return s.agentStore().ClaimGoalGenerationFence(ctx, input)
}

func (s *SQLiteStore) ReleaseGoalGenerationFence(ctx context.Context, input agentactivitybiz.ReleaseGoalGenerationFenceInput) (agentactivitybiz.GoalGenerationFence, bool, error) {
	return s.agentStore().ReleaseGoalGenerationFence(ctx, input)
}

func (s *SQLiteStore) CompleteGoalGenerationFence(ctx context.Context, input agentactivitybiz.CompleteGoalGenerationFenceInput) (agentactivitybiz.GoalGenerationFence, bool, error) {
	return s.agentStore().CompleteGoalGenerationFence(ctx, input)
}

func (s *SQLiteStore) RequeueLeasedGoalGenerationFencesOnStartup(ctx context.Context, now int64) (int64, error) {
	return s.agentStore().RequeueLeasedGoalGenerationFencesOnStartup(ctx, now)
}

func (s *SQLiteStore) PrepareSubmitClaim(ctx context.Context, input agentactivitybiz.SubmitClaimPrepare) (agentactivitybiz.SubmitClaim, bool, error) {
	return s.agentStore().PrepareSubmitClaim(ctx, input)
}

func (s *SQLiteStore) GetSubmitClaim(ctx context.Context, workspaceID, agentSessionID, clientSubmitID string) (agentactivitybiz.SubmitClaim, bool, error) {
	return s.agentStore().GetSubmitClaim(ctx, workspaceID, agentSessionID, clientSubmitID)
}

func (s *SQLiteStore) AcceptSubmitClaim(ctx context.Context, workspaceID, agentSessionID, clientSubmitID, turnID string, nowUnixMS int64) (agentactivitybiz.SubmitClaim, bool, error) {
	return s.agentStore().AcceptSubmitClaim(ctx, workspaceID, agentSessionID, clientSubmitID, turnID, nowUnixMS)
}

func (s *SQLiteStore) RejectSubmitClaim(ctx context.Context, workspaceID, agentSessionID, clientSubmitID, turnID string, nowUnixMS int64) (agentactivitybiz.SubmitClaim, bool, error) {
	return s.agentStore().RejectSubmitClaim(ctx, workspaceID, agentSessionID, clientSubmitID, turnID, nowUnixMS)
}

func (s *SQLiteStore) DeleteSubmitClaim(ctx context.Context, workspaceID, agentSessionID, clientSubmitID string) (bool, error) {
	return s.agentStore().DeleteSubmitClaim(ctx, workspaceID, agentSessionID, clientSubmitID)
}

func (s *SQLiteStore) GetRuntimeOperation(ctx context.Context, workspaceID string, operationID string) (agentactivitybiz.RuntimeOperation, bool, error) {
	return s.agentReadStore().GetRuntimeOperation(ctx, workspaceID, operationID)
}

func (s *SQLiteStore) ListClaimableRuntimeOperations(ctx context.Context, input agentactivitybiz.ListClaimableRuntimeOperationsInput) ([]agentactivitybiz.RuntimeOperation, error) {
	return s.agentReadStore().ListClaimableRuntimeOperations(ctx, input)
}

func (s *SQLiteStore) ClaimRuntimeOperationLease(ctx context.Context, input agentactivitybiz.ClaimRuntimeOperationLeaseInput) (agentactivitybiz.RuntimeOperation, bool, error) {
	return s.agentStore().ClaimRuntimeOperationLease(ctx, input)
}

func (s *SQLiteStore) ReleaseOrFailRuntimeOperation(ctx context.Context, input agentactivitybiz.ReleaseOrFailRuntimeOperationInput) (agentactivitybiz.RuntimeOperation, bool, error) {
	return s.agentStore().ReleaseOrFailRuntimeOperation(ctx, input)
}

func (s *SQLiteStore) CheckpointRuntimeOperation(ctx context.Context, input agentactivitybiz.CheckpointRuntimeOperationInput) (agentactivitybiz.RuntimeOperation, bool, error) {
	return s.agentStore().CheckpointRuntimeOperation(ctx, input)
}

func (s *SQLiteStore) RequeueLeasedRuntimeOperationsOnStartup(ctx context.Context, nowUnixMS int64) (int64, error) {
	return s.agentStore().RequeueLeasedRuntimeOperationsOnStartup(ctx, nowUnixMS)
}

func (s *SQLiteStore) CompleteInteractiveRuntimeOperation(ctx context.Context, input agentactivitybiz.CompleteInteractiveRuntimeOperationInput) (agentactivitybiz.RuntimeOperationCompletion, bool, error) {
	return s.agentStore().CompleteInteractiveRuntimeOperation(ctx, input)
}

func (s *SQLiteStore) CompleteCancelRuntimeOperation(ctx context.Context, input agentactivitybiz.CompleteCancelRuntimeOperationInput) (agentactivitybiz.RuntimeOperationCompletion, bool, error) {
	return s.agentStore().CompleteCancelRuntimeOperation(ctx, input)
}

func (s *SQLiteStore) CompletePlanDecisionRuntimeOperation(ctx context.Context, input agentactivitybiz.CompletePlanDecisionRuntimeOperationInput) (agentactivitybiz.RuntimeOperationCompletion, bool, error) {
	return s.agentStore().CompletePlanDecisionRuntimeOperation(ctx, input)
}

func (s *SQLiteStore) FindTurnByClientSubmitID(ctx context.Context, workspaceID string, agentSessionID string, clientSubmitID string) (string, bool, error) {
	return s.agentReadStore().FindTurnByClientSubmitID(ctx, workspaceID, agentSessionID, clientSubmitID)
}

func (s *SQLiteStore) ListPendingRuntimeOperationEvents(ctx context.Context, workspaceID string, limit int) ([]agentactivitybiz.RuntimeOperationEvent, error) {
	return s.agentReadStore().ListPendingRuntimeOperationEvents(ctx, workspaceID, limit)
}

func (s *SQLiteStore) MarkRuntimeOperationEventPublished(ctx context.Context, workspaceID string, eventID int64, publishedAtUnixMS int64) (bool, error) {
	return s.agentStore().MarkRuntimeOperationEventPublished(ctx, workspaceID, eventID, publishedAtUnixMS)
}

func (s *SQLiteStore) ListAgentTargets(ctx context.Context) ([]agenttargetbiz.Target, error) {
	targets, err := s.agentReadStore().ListAgentTargets(ctx)
	if err != nil {
		return nil, err
	}
	var result []agenttargetbiz.Target
	for _, target := range targets {
		result = append(result, agentTargetFromStore(target))
	}
	return result, nil
}

func (s *SQLiteStore) GetAgentTarget(ctx context.Context, id string) (agenttargetbiz.Target, error) {
	target, err := s.agentReadStore().GetAgentTarget(ctx, id)
	if err != nil {
		return agenttargetbiz.Target{}, err
	}
	return agentTargetFromStore(target), nil
}

func (s *SQLiteStore) PutAgentTarget(ctx context.Context, target agenttargetbiz.Target) (agenttargetbiz.Target, error) {
	stored, err := s.agentStore().PutAgentTarget(ctx, agentTargetToStore(target))
	if err != nil {
		return agenttargetbiz.Target{}, err
	}
	return agentTargetFromStore(stored), nil
}

func (s *SQLiteStore) DeleteAgentTarget(ctx context.Context, id string) error {
	return s.agentStore().DeleteAgentTarget(ctx, id)
}

// ResolveAgentTargetAlias reverse-looks-up which registered agent target
// claims the given id as an alias, returning that target's primary id.
//
// Contract: cross-domain id translation is owned by the host projection layer
// (tsh/tutti-os rewrites a shared session's owner-domain agentTargetId to the
// caller-local `shared-agent:{sharedAgentId}` id at its sync boundary), so
// owner-domain ids are never expected to reach this store and no alias column
// is planned. This hook exists purely as defense in depth for the ingestion
// boundary in services/tuttid/service/agent: a hit means an upstream missed
// its translation. The store-backed implementation therefore resolves
// nothing.
func (*SQLiteStore) ResolveAgentTargetAlias(context.Context, string) (string, bool) {
	return "", false
}

func agentTargetToStore(target agenttargetbiz.Target) agentactivitybiz.Target {
	return agentactivitybiz.Target{
		ID:              target.ID,
		Provider:        target.Provider,
		LaunchRefJSON:   target.LaunchRefJSON,
		Name:            target.Name,
		IconKey:         target.IconKey,
		IconURL:         target.IconURL,
		MaskIconURL:     target.MaskIconURL,
		HeroImageURL:    target.HeroImageURL,
		Enabled:         target.Enabled,
		Source:          target.Source,
		SortOrder:       target.SortOrder,
		CreatedAtUnixMS: target.CreatedAtUnixMS,
		UpdatedAtUnixMS: target.UpdatedAtUnixMS,
	}
}

func agentTargetFromStore(target agentactivitybiz.Target) agenttargetbiz.Target {
	return agenttargetbiz.Target{
		ID:              target.ID,
		Provider:        target.Provider,
		LaunchRefJSON:   target.LaunchRefJSON,
		Name:            target.Name,
		IconKey:         target.IconKey,
		IconURL:         target.IconURL,
		MaskIconURL:     target.MaskIconURL,
		HeroImageURL:    target.HeroImageURL,
		Enabled:         target.Enabled,
		Source:          target.Source,
		SortOrder:       target.SortOrder,
		CreatedAtUnixMS: target.CreatedAtUnixMS,
		UpdatedAtUnixMS: target.UpdatedAtUnixMS,
	}
}

func normalizeStoreAgentTarget(target agentactivitybiz.Target) (agentactivitybiz.Target, error) {
	normalized, err := agenttargetbiz.NormalizeTarget(agentTargetFromStore(target))
	if err != nil {
		return agentactivitybiz.Target{}, err
	}
	return agentTargetToStore(normalized), nil
}

func isSkippableAgentTargetRowError(err error) bool {
	return errors.Is(err, agenttargetbiz.ErrInvalidTarget) ||
		errors.Is(err, agenttargetbiz.ErrInvalidLaunchRef)
}

func defaultSystemStoreAgentTargets(nowUnixMS int64) []agentactivitybiz.Target {
	defaults := agenttargetbiz.DefaultSystemTargets(nowUnixMS)
	targets := make([]agentactivitybiz.Target, 0, len(defaults))
	for _, target := range defaults {
		targets = append(targets, agentTargetToStore(target))
	}
	return targets
}
