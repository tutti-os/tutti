package workspace

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
	agentstore "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
)

// Agent activity and agent target persistence is delegated to the
// embeddable packages/agent/store-sqlite module, sharing this store's
// database handle. The delegation below keeps SQLiteStore satisfying the
// AgentActivityStore and AgentTargetStore interfaces unchanged.

var _ AgentActivityStore = (*SQLiteStore)(nil)

const legacyIDLocalCodex = "local-codex"
const legacyIDLocalClaudeCode = "local-claude-code"

func (s *SQLiteStore) newAgentStore() *agentstore.Store {
	return agentstore.New(s.db, agentstore.Options{
		WorkspaceExists:        s.ensureWorkspaceExists,
		ProjectPaths:           userProjectPathsQuerier{},
		NormalizeTarget:        normalizeStoreAgentTarget,
		IsSkippableTargetError: isSkippableAgentTargetRowError,
		SeedSystemTargets:      defaultSystemStoreAgentTargets,
		LegacySystemTargetIDRenames: map[string]string{
			legacyIDLocalCodex:      agenttargetbiz.IDLocalCodex,
			legacyIDLocalClaudeCode: agenttargetbiz.IDLocalClaudeCode,
		},
		TargetIDBackfillByProvider: defaultTargetIDBackfillByProvider(),
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

func (s *SQLiteStore) agentStore() *agentstore.Store {
	if s == nil {
		return nil
	}
	return s.agent
}

// userProjectPathsQuerier feeds the user_projects table into the agent
// store's rail section classification, using whatever querier (transaction
// or database) the store is currently running on.
type userProjectPathsQuerier struct{}

func (userProjectPathsQuerier) ProjectPaths(ctx context.Context, q agentstore.Querier) ([]string, error) {
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

func (s *SQLiteStore) ReportActivityState(ctx context.Context, input agentactivitybiz.ActivityStateReport) (agentactivitybiz.ActivityStateReportResult, error) {
	return s.agentStore().ReportActivityState(ctx, input)
}

func (s *SQLiteStore) ReportSessionMessages(ctx context.Context, input agentactivitybiz.SessionMessageReport) (agentactivitybiz.MessageReportResult, error) {
	return s.agentStore().ReportSessionMessages(ctx, input)
}

func (s *SQLiteStore) GetSession(ctx context.Context, workspaceID string, agentSessionID string) (agentactivitybiz.Session, bool, error) {
	return s.agentStore().GetSession(ctx, workspaceID, agentSessionID)
}

func (s *SQLiteStore) ListChildSessions(ctx context.Context, workspaceID string, agentSessionID string) ([]agentactivitybiz.Session, error) {
	return s.agentStore().ListChildSessions(ctx, workspaceID, agentSessionID)
}

func (s *SQLiteStore) SessionDeleted(ctx context.Context, workspaceID string, agentSessionID string) (bool, error) {
	return s.agentStore().SessionDeleted(ctx, workspaceID, agentSessionID)
}

func (s *SQLiteStore) ListSessions(ctx context.Context, workspaceID string) ([]agentactivitybiz.Session, bool, error) {
	return s.agentStore().ListSessions(ctx, workspaceID)
}

func (s *SQLiteStore) ListSessionSection(ctx context.Context, input agentactivitybiz.ListSessionSectionInput) (agentactivitybiz.SessionSectionPage, bool, error) {
	return s.agentStore().ListSessionSection(ctx, input)
}

func (s *SQLiteStore) ListSessionSectionDeletionCandidates(ctx context.Context, input agentactivitybiz.ListSessionSectionDeletionCandidatesInput) (agentactivitybiz.SessionSectionDeletionCandidates, bool, error) {
	return s.agentStore().ListSessionSectionDeletionCandidates(ctx, input)
}

func (s *SQLiteStore) ListSessionMessages(ctx context.Context, input agentactivitybiz.ListSessionMessagesInput) (agentactivitybiz.MessagePage, bool, error) {
	return s.agentStore().ListSessionMessages(ctx, input)
}

func (s *SQLiteStore) ListWorkspaceGeneratedFiles(ctx context.Context, input agentactivitybiz.ListWorkspaceGeneratedFilesInput) (agentactivitybiz.GeneratedFileList, bool, error) {
	return s.agentStore().ListWorkspaceGeneratedFiles(ctx, input)
}

func (s *SQLiteStore) DeleteSession(ctx context.Context, workspaceID string, agentSessionID string) (bool, error) {
	result, err := s.deleteAgentSessionsWithTuttiModeTx(ctx, agentactivitybiz.DeleteSessionsBatchInput{
		WorkspaceID: workspaceID,
		SessionIDs:  []string{agentSessionID},
	})
	return result.RemovedSessions > 0, err
}

func (s *SQLiteStore) DeleteSessionsBatch(ctx context.Context, input agentactivitybiz.DeleteSessionsBatchInput) (agentactivitybiz.DeleteSessionsBatchResult, error) {
	return s.deleteAgentSessionsWithTuttiModeTx(ctx, input)
}

func (s *SQLiteStore) ClearSessions(ctx context.Context, workspaceID string) (agentactivitybiz.ClearSessionsResult, error) {
	if s == nil || s.db == nil {
		return agentactivitybiz.ClearSessionsResult{}, errors.New("workspace database is not initialized")
	}
	workspaceID = strings.TrimSpace(workspaceID)
	if workspaceID == "" {
		return agentactivitybiz.ClearSessionsResult{}, nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
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

func (s *SQLiteStore) deleteAgentSessionsWithTuttiModeTx(ctx context.Context, input agentactivitybiz.DeleteSessionsBatchInput) (agentactivitybiz.DeleteSessionsBatchResult, error) {
	if s == nil || s.db == nil {
		return agentactivitybiz.DeleteSessionsBatchResult{}, errors.New("workspace database is not initialized")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return agentactivitybiz.DeleteSessionsBatchResult{}, fmt.Errorf("begin delete agent and Tutti mode sessions: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	result, err := s.agentStore().DeleteSessionsBatchTx(ctx, tx, input)
	if err != nil {
		return agentactivitybiz.DeleteSessionsBatchResult{}, err
	}
	if err := deleteTuttiModeSessionStatesTx(ctx, tx, strings.TrimSpace(input.WorkspaceID), result.RemovedSessionIDs); err != nil {
		return agentactivitybiz.DeleteSessionsBatchResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return agentactivitybiz.DeleteSessionsBatchResult{}, fmt.Errorf("commit delete agent and Tutti mode sessions: %w", err)
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

func (s *SQLiteStore) UpdateSessionPinned(ctx context.Context, workspaceID string, agentSessionID string, pinned bool) (agentactivitybiz.Session, bool, error) {
	return s.agentStore().UpdateSessionPinned(ctx, workspaceID, agentSessionID, pinned)
}

func (s *SQLiteStore) UpdateSessionTitle(ctx context.Context, workspaceID string, agentSessionID string, title string) (agentactivitybiz.Session, bool, error) {
	return s.agentStore().UpdateSessionTitle(ctx, workspaceID, agentSessionID, title)
}

func (s *SQLiteStore) GetTurn(ctx context.Context, workspaceID string, agentSessionID string, turnID string) (agentactivitybiz.Turn, bool, error) {
	return s.agentStore().GetTurn(ctx, workspaceID, agentSessionID, turnID)
}

func (s *SQLiteStore) GetLatestTurn(ctx context.Context, workspaceID string, agentSessionID string) (agentactivitybiz.Turn, bool, error) {
	return s.agentStore().GetLatestTurn(ctx, workspaceID, agentSessionID)
}

func (s *SQLiteStore) ListLatestTurns(ctx context.Context, workspaceID string, agentSessionIDs []string) (map[string]agentactivitybiz.Turn, error) {
	return s.agentStore().ListLatestTurns(ctx, workspaceID, agentSessionIDs)
}

func (s *SQLiteStore) ListLatestTurnInteractions(ctx context.Context, workspaceID string, agentSessionIDs []string) (map[string][]agentactivitybiz.Interaction, error) {
	return s.agentStore().ListLatestTurnInteractions(ctx, workspaceID, agentSessionIDs)
}

func (s *SQLiteStore) ListTurnsBySession(ctx context.Context, workspaceID string, turnIDBySessionID map[string]string) (map[string]agentactivitybiz.Turn, error) {
	return s.agentStore().ListTurnsBySession(ctx, workspaceID, turnIDBySessionID)
}

func (s *SQLiteStore) ListPendingInteractionsBySession(ctx context.Context, workspaceID string, agentSessionIDs []string) (map[string][]agentactivitybiz.Interaction, error) {
	return s.agentStore().ListPendingInteractionsBySession(ctx, workspaceID, agentSessionIDs)
}

func (s *SQLiteStore) ListSessionTurns(ctx context.Context, workspaceID string, agentSessionID string) ([]agentactivitybiz.Turn, error) {
	return s.agentStore().ListSessionTurns(ctx, workspaceID, agentSessionID)
}

func (s *SQLiteStore) SettleStaleTurns(ctx context.Context) ([]agentactivitybiz.StaleTurnSettlement, error) {
	return s.agentStore().SettleStaleTurns(ctx)
}

func (s *SQLiteStore) ListSessionInteractions(ctx context.Context, input agentactivitybiz.ListSessionInteractionsInput) ([]agentactivitybiz.Interaction, error) {
	return s.agentStore().ListSessionInteractions(ctx, input)
}

func (s *SQLiteStore) PrepareRuntimeOperation(ctx context.Context, input agentactivitybiz.RuntimeOperationPrepare) (agentactivitybiz.RuntimeOperation, bool, error) {
	return s.agentStore().PrepareRuntimeOperation(ctx, input)
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

func (s *SQLiteStore) DeleteSubmitClaim(ctx context.Context, workspaceID, agentSessionID, clientSubmitID string) (bool, error) {
	return s.agentStore().DeleteSubmitClaim(ctx, workspaceID, agentSessionID, clientSubmitID)
}

func (s *SQLiteStore) GetRuntimeOperation(ctx context.Context, workspaceID string, operationID string) (agentactivitybiz.RuntimeOperation, bool, error) {
	return s.agentStore().GetRuntimeOperation(ctx, workspaceID, operationID)
}

func (s *SQLiteStore) ListClaimableRuntimeOperations(ctx context.Context, input agentactivitybiz.ListClaimableRuntimeOperationsInput) ([]agentactivitybiz.RuntimeOperation, error) {
	return s.agentStore().ListClaimableRuntimeOperations(ctx, input)
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
	return s.agentStore().FindTurnByClientSubmitID(ctx, workspaceID, agentSessionID, clientSubmitID)
}

func (s *SQLiteStore) ListPendingRuntimeOperationEvents(ctx context.Context, workspaceID string, limit int) ([]agentactivitybiz.RuntimeOperationEvent, error) {
	return s.agentStore().ListPendingRuntimeOperationEvents(ctx, workspaceID, limit)
}

func (s *SQLiteStore) MarkRuntimeOperationEventPublished(ctx context.Context, workspaceID string, eventID int64, publishedAtUnixMS int64) (bool, error) {
	return s.agentStore().MarkRuntimeOperationEventPublished(ctx, workspaceID, eventID, publishedAtUnixMS)
}

func (s *SQLiteStore) ListAgentTargets(ctx context.Context) ([]agenttargetbiz.Target, error) {
	targets, err := s.agentStore().ListAgentTargets(ctx)
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
	target, err := s.agentStore().GetAgentTarget(ctx, id)
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

func agentTargetToStore(target agenttargetbiz.Target) agentstore.Target {
	return agentstore.Target{
		ID:              target.ID,
		Provider:        target.Provider,
		LaunchRefJSON:   target.LaunchRefJSON,
		Name:            target.Name,
		IconKey:         target.IconKey,
		IconURL:         target.IconURL,
		HeroImageURL:    target.HeroImageURL,
		Enabled:         target.Enabled,
		Source:          target.Source,
		SortOrder:       target.SortOrder,
		CreatedAtUnixMS: target.CreatedAtUnixMS,
		UpdatedAtUnixMS: target.UpdatedAtUnixMS,
	}
}

func agentTargetFromStore(target agentstore.Target) agenttargetbiz.Target {
	return agenttargetbiz.Target{
		ID:              target.ID,
		Provider:        target.Provider,
		LaunchRefJSON:   target.LaunchRefJSON,
		Name:            target.Name,
		IconKey:         target.IconKey,
		IconURL:         target.IconURL,
		HeroImageURL:    target.HeroImageURL,
		Enabled:         target.Enabled,
		Source:          target.Source,
		SortOrder:       target.SortOrder,
		CreatedAtUnixMS: target.CreatedAtUnixMS,
		UpdatedAtUnixMS: target.UpdatedAtUnixMS,
	}
}

func normalizeStoreAgentTarget(target agentstore.Target) (agentstore.Target, error) {
	normalized, err := agenttargetbiz.NormalizeTarget(agentTargetFromStore(target))
	if err != nil {
		return agentstore.Target{}, err
	}
	return agentTargetToStore(normalized), nil
}

func isSkippableAgentTargetRowError(err error) bool {
	return errors.Is(err, agenttargetbiz.ErrInvalidTarget) ||
		errors.Is(err, agenttargetbiz.ErrInvalidLaunchRef)
}

func defaultSystemStoreAgentTargets(nowUnixMS int64) []agentstore.Target {
	defaults := agenttargetbiz.DefaultSystemTargets(nowUnixMS)
	targets := make([]agentstore.Target, 0, len(defaults))
	for _, target := range defaults {
		targets = append(targets, agentTargetToStore(target))
	}
	return targets
}
