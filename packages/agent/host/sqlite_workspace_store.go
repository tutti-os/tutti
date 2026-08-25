package agenthost

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
)

const canonicalRuntimeSessionOrigin = "WORKSPACE_AGENT_SESSION_ORIGIN_RUNTIME"

// SQLiteWorkspaceStore is the official workspace-routed store composition for
// Agent Host. It owns canonical runtime-session initialization and post-commit
// notifications so product services cannot drift on lifecycle projection.
//
// Product-owned sidecar projections should wrap this type and observe the
// persisted result; they must not reimplement canonical initialization.
type SQLiteWorkspaceStore struct {
	StoreForWorkspace      func(string) *storesqlite.Store
	CurrentUserID          func() string
	Clock                  Clock
	Observer               CommitObserver
	InitializationPolicy   RuntimeSessionInitializationPolicy
	InitializationObserver RuntimeSessionInitializationObserver
}

// RuntimeSessionInitializationPolicy normalizes product-owned identity fields
// before the shared store commits the canonical session shell. It cannot write
// canonical state itself.
type RuntimeSessionInitializationPolicy interface {
	NormalizeRuntimeSessionInitialization(context.Context, ProviderRuntimeSession) (ProviderRuntimeSession, error)
}

// RuntimeSessionInitializationObserver projects product-owned, repairable
// sidecars after canonical initialization succeeds. It cannot reject or alter
// the canonical commit; implementations own their own diagnostics and repair.
type RuntimeSessionInitializationObserver interface {
	ObserveRuntimeSessionInitialized(context.Context, ProviderRuntimeSession, storesqlite.Session)
}

var _ CanonicalStore = (*SQLiteWorkspaceStore)(nil)
var _ CanonicalRuntimeContextCASStore = (*SQLiteWorkspaceStore)(nil)
var _ TurnSubmissionStore = (*SQLiteWorkspaceStore)(nil)
var _ EffectiveHistoryStore = (*SQLiteWorkspaceStore)(nil)
var _ SessionManagementStore = (*SQLiteWorkspaceStore)(nil)
var _ SessionBatchManagementStore = (*SQLiteWorkspaceStore)(nil)
var _ SessionForkStore = (*SQLiteWorkspaceStore)(nil)
var _ SessionForkTurnIdentityStore = (*SQLiteWorkspaceStore)(nil)

func (s *SQLiteWorkspaceStore) GetSession(ctx context.Context, workspaceID, sessionID string) (storesqlite.Session, bool, error) {
	store, err := s.store(workspaceID)
	if err != nil {
		return storesqlite.Session{}, false, err
	}
	return store.GetSession(ctx, workspaceID, sessionID)
}

// GetSessionAndTurn preserves the SQLite snapshot boundary through the
// workspace-routing Host adapter. Shared Agent live projections must not fall
// back to independent Session and Turn reads at a terminal transition.
func (s *SQLiteWorkspaceStore) GetSessionAndTurn(
	ctx context.Context,
	workspaceID string,
	sessionID string,
	turnID string,
) (storesqlite.Session, storesqlite.Turn, bool, error) {
	store, err := s.store(workspaceID)
	if err != nil {
		return storesqlite.Session{}, storesqlite.Turn{}, false, err
	}
	return store.GetSessionAndTurn(ctx, workspaceID, sessionID, turnID)
}

func (s *SQLiteWorkspaceStore) GetSessionForkSource(
	ctx context.Context,
	workspaceID, sourceSessionID string,
) (storesqlite.Session, bool, error) {
	store, err := s.store(workspaceID)
	if err != nil {
		return storesqlite.Session{}, false, err
	}
	return store.GetSessionForkSource(ctx, workspaceID, sourceSessionID)
}

func (s *SQLiteWorkspaceStore) CheckSessionForkThroughTurn(
	ctx context.Context,
	workspaceID, sourceSessionID, throughTurnID string,
) (storesqlite.SessionForkBoundary, bool, error) {
	store, err := s.store(workspaceID)
	if err != nil {
		return storesqlite.SessionForkBoundary{}, false, err
	}
	return store.CheckSessionForkThroughTurn(ctx, workspaceID, sourceSessionID, throughTurnID)
}

func (s *SQLiteWorkspaceStore) ListSessionForkTurnIdentities(
	ctx context.Context,
	workspaceID, sourceSessionID string,
) ([]storesqlite.SessionForkTurnIdentity, error) {
	store, err := s.store(workspaceID)
	if err != nil {
		return nil, err
	}
	return store.ListSessionForkTurnIdentities(ctx, workspaceID, sourceSessionID)
}

func (s *SQLiteWorkspaceStore) PrepareSessionFork(
	ctx context.Context,
	input storesqlite.SessionForkPrepare,
) (storesqlite.SessionForkOperation, bool, error) {
	store, err := s.store(input.WorkspaceID)
	if err != nil {
		return storesqlite.SessionForkOperation{}, false, err
	}
	operation, changed, err := store.PrepareSessionFork(ctx, input)
	if err == nil && changed {
		NotifyCommitted(ctx, s.Observer, CanonicalDelta(operation.CommitDelta))
	}
	return operation, changed, err
}

func (s *SQLiteWorkspaceStore) GetSessionForkOperation(
	ctx context.Context,
	workspaceID, operationID string,
) (storesqlite.SessionForkOperation, bool, error) {
	store, err := s.store(workspaceID)
	if err != nil {
		return storesqlite.SessionForkOperation{}, false, err
	}
	return store.GetSessionForkOperation(ctx, workspaceID, operationID)
}

func (s *SQLiteWorkspaceStore) GetSessionForkOperationByRequest(
	ctx context.Context,
	workspaceID, requestID string,
) (storesqlite.SessionForkOperation, bool, error) {
	store, err := s.store(workspaceID)
	if err != nil {
		return storesqlite.SessionForkOperation{}, false, err
	}
	return store.GetSessionForkOperationByRequest(ctx, workspaceID, requestID)
}

func (s *SQLiteWorkspaceStore) GetUnknownSessionForkOperation(
	ctx context.Context,
	workspaceID, sourceSessionID, pointKind, sourceTurnID string,
) (storesqlite.SessionForkOperation, bool, error) {
	store, err := s.store(workspaceID)
	if err != nil {
		return storesqlite.SessionForkOperation{}, false, err
	}
	return store.GetUnknownSessionForkOperation(
		ctx,
		workspaceID,
		sourceSessionID,
		pointKind,
		sourceTurnID,
	)
}

func (s *SQLiteWorkspaceStore) GetBlockingSessionForkOperation(
	ctx context.Context,
	workspaceID, sourceSessionID, pointKind, sourceTurnID string,
) (storesqlite.SessionForkOperation, bool, error) {
	store, err := s.store(workspaceID)
	if err != nil {
		return storesqlite.SessionForkOperation{}, false, err
	}
	return store.GetBlockingSessionForkOperation(
		ctx,
		workspaceID,
		sourceSessionID,
		pointKind,
		sourceTurnID,
	)
}

func (s *SQLiteWorkspaceStore) MarkSessionForkDispatching(
	ctx context.Context,
	workspaceID, operationID string,
	now int64,
) (storesqlite.SessionForkOperation, bool, error) {
	store, err := s.store(workspaceID)
	if err != nil {
		return storesqlite.SessionForkOperation{}, false, err
	}
	operation, changed, err := store.MarkSessionForkDispatching(ctx, workspaceID, operationID, now)
	if err == nil && changed {
		NotifyCommitted(ctx, s.Observer, CanonicalDelta(operation.CommitDelta))
	}
	return operation, changed, err
}

func (s *SQLiteWorkspaceStore) RetryUnknownSessionFork(
	ctx context.Context,
	workspaceID, operationID string,
	now int64,
) (storesqlite.SessionForkOperation, bool, error) {
	store, err := s.store(workspaceID)
	if err != nil {
		return storesqlite.SessionForkOperation{}, false, err
	}
	operation, changed, err := store.RetryUnknownSessionFork(
		ctx,
		workspaceID,
		operationID,
		now,
	)
	if err == nil && changed {
		NotifyCommitted(ctx, s.Observer, CanonicalDelta(operation.CommitDelta))
	}
	return operation, changed, err
}

func (s *SQLiteWorkspaceStore) FailPreparedSessionFork(
	ctx context.Context,
	workspaceID, operationID, lastError string,
	now int64,
) (storesqlite.SessionForkOperation, bool, error) {
	store, err := s.store(workspaceID)
	if err != nil {
		return storesqlite.SessionForkOperation{}, false, err
	}
	operation, changed, err := store.FailPreparedSessionFork(
		ctx, workspaceID, operationID, lastError, now,
	)
	if err == nil && changed {
		NotifyCommitted(ctx, s.Observer, CanonicalDelta(operation.CommitDelta))
	}
	return operation, changed, err
}

func (s *SQLiteWorkspaceStore) RecordSessionForkProviderResult(
	ctx context.Context,
	input storesqlite.SessionForkProviderResult,
) (storesqlite.SessionForkOperation, bool, error) {
	store, err := s.store(input.WorkspaceID)
	if err != nil {
		return storesqlite.SessionForkOperation{}, false, err
	}
	operation, changed, err := store.RecordSessionForkProviderResult(ctx, input)
	if err == nil && changed {
		NotifyCommitted(ctx, s.Observer, CanonicalDelta(operation.CommitDelta))
	}
	return operation, changed, err
}

func (s *SQLiteWorkspaceStore) CommitSessionFork(
	ctx context.Context,
	workspaceID, operationID string,
	now int64,
) (storesqlite.SessionForkCommitResult, error) {
	store, err := s.store(workspaceID)
	if err != nil {
		return storesqlite.SessionForkCommitResult{}, err
	}
	result, err := store.CommitSessionFork(ctx, workspaceID, operationID, now)
	if err == nil && result.Changed {
		NotifyCommitted(ctx, s.Observer, CanonicalDelta(result.CommitDelta))
	}
	return result, err
}

func (s *SQLiteWorkspaceStore) AcknowledgeSessionForkOperation(
	ctx context.Context,
	workspaceID, operationID string,
	now int64,
) (storesqlite.SessionForkOperation, bool, bool, error) {
	store, err := s.store(workspaceID)
	if err != nil {
		return storesqlite.SessionForkOperation{}, false, false, err
	}
	operation, found, changed, err := store.AcknowledgeSessionForkOperation(
		ctx,
		workspaceID,
		operationID,
		now,
	)
	if err == nil && changed {
		NotifyCommitted(ctx, s.Observer, CanonicalDelta(operation.CommitDelta))
	}
	return operation, found, changed, err
}

func (s *SQLiteWorkspaceStore) GetSessionForkLineage(
	ctx context.Context,
	workspaceID, targetSessionID string,
) (storesqlite.SessionForkLineage, bool, error) {
	store, err := s.store(workspaceID)
	if err != nil {
		return storesqlite.SessionForkLineage{}, false, err
	}
	return store.GetSessionForkLineage(ctx, workspaceID, targetSessionID)
}

func (s *SQLiteWorkspaceStore) SessionDeleted(ctx context.Context, workspaceID, sessionID string) (bool, error) {
	store, err := s.store(workspaceID)
	if err != nil {
		return false, err
	}
	return store.SessionDeleted(ctx, workspaceID, sessionID)
}

func (s *SQLiteWorkspaceStore) RollbackRuntimeSessionInitialization(ctx context.Context, workspaceID, sessionID string) (bool, error) {
	store, err := s.store(workspaceID)
	if err != nil {
		return false, err
	}
	changed, err := store.RollbackRuntimeSessionInitialization(ctx, workspaceID, sessionID)
	if err == nil && changed {
		NotifyCommitted(ctx, s.Observer, CommittedDelta{
			ProjectionDirty: []CanonicalProjectionDirty{{
				WorkspaceID: workspaceID, AgentSessionID: sessionID,
				EntityKind: storesqlite.MutationEntitySession, EntityID: sessionID, Operation: "delete",
			}},
			ViewsInvalidated: []CanonicalViewInvalidated{{WorkspaceID: workspaceID, AgentSessionID: sessionID}},
		})
	}
	return changed, err
}

func (s *SQLiteWorkspaceStore) InitializeRuntimeSession(ctx context.Context, input RuntimeSessionInitialization) (storesqlite.Session, error) {
	session := input.Session
	if s != nil && s.InitializationPolicy != nil {
		var err error
		session, err = s.InitializationPolicy.NormalizeRuntimeSessionInitialization(ctx, session)
		if err != nil {
			return storesqlite.Session{}, err
		}
	}
	workspaceID := strings.TrimSpace(session.WorkspaceID)
	sessionID := strings.TrimSpace(session.ID)
	if workspaceID == "" || sessionID == "" {
		return storesqlite.Session{}, ErrInvalidArgument
	}
	store, err := s.store(workspaceID)
	if err != nil {
		return storesqlite.Session{}, err
	}
	occurredAt := session.UpdatedAtUnixMS
	if occurredAt <= 0 {
		occurredAt = session.CreatedAtUnixMS
	}
	if occurredAt <= 0 {
		occurredAt = s.now().UnixMilli()
	}
	runtimeContext := cloneStringAnyMap(session.RuntimeContext)
	if runtimeContext == nil {
		runtimeContext = map[string]any{}
	}
	runtimeContext["visible"] = session.Visible && !session.Provisional
	userID := firstNonBlank(session.UserID, s.currentUserID())
	var railPlacement *storesqlite.RailSection
	if input.RailPlacement != nil {
		railPlacement = &storesqlite.RailSection{
			Kind:        string(input.RailPlacement.Kind),
			ProjectPath: input.RailPlacement.ProjectPath,
			Key:         input.RailPlacement.SectionKey,
		}
	}
	result, err := store.ReportActivityState(ctx, storesqlite.ActivityStateReport{
		Session: storesqlite.SessionStateReport{
			WorkspaceID:                workspaceID,
			AgentSessionID:             sessionID,
			Kind:                       storesqlite.SessionKindRoot,
			Origin:                     canonicalRuntimeSessionOrigin,
			UserID:                     userID,
			AgentTargetID:              strings.TrimSpace(session.AgentTargetID),
			Provider:                   strings.TrimSpace(session.Provider),
			ProviderSessionID:          strings.TrimSpace(session.ProviderSessionID),
			Model:                      composerSettingsModel(session.Settings),
			Settings:                   composerSettingsPayload(session.Settings),
			Capabilities:               canonical.CloneCapabilitySnapshot(session.Capabilities),
			RuntimeContext:             runtimeContext,
			Cwd:                        strings.TrimSpace(session.Cwd),
			RailPlacement:              railPlacement,
			RailPlacementAuthoritative: input.RailPlacementAuthoritative,
			Title:                      strings.TrimSpace(session.Title),
			Status:                     runtimeLifecycleStatus(session.Status),
			CurrentPhase:               runtimeLifecyclePhase(session.Status),
			LastError:                  strings.TrimSpace(session.LastError),
			OccurredAtUnixMS:           occurredAt,
			StartedAtUnixMS:            session.CreatedAtUnixMS,
			CreatedAtUnixMS:            session.CreatedAtUnixMS,
		},
	})
	if err != nil {
		if errors.Is(err, storesqlite.ErrRailSectionConflict) {
			return storesqlite.Session{}, fmt.Errorf("%w: %v", ErrRailPlacementConflict, err)
		}
		return storesqlite.Session{}, err
	}
	persisted := result.State.Session
	if strings.TrimSpace(persisted.ID) == "" {
		return storesqlite.Session{}, errors.New("initialized agent session was not persisted")
	}
	if s.InitializationObserver != nil {
		s.InitializationObserver.ObserveRuntimeSessionInitialized(ctx, session, persisted)
	}
	NotifyCommitted(ctx, s.Observer, CanonicalDelta(result.CommitDelta))
	persisted, found, err := store.GetSession(ctx, workspaceID, sessionID)
	if err != nil {
		return storesqlite.Session{}, err
	}
	if !found || strings.TrimSpace(persisted.ID) == "" {
		return storesqlite.Session{}, errors.New("initialized agent session was not persisted")
	}
	return persisted, nil
}

func (s *SQLiteWorkspaceStore) ResolveRuntimeSessionRailPlacement(
	ctx context.Context,
	input ResolveRuntimeSessionRailPlacementInput,
) (*RailPlacement, error) {
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	agentSessionID := strings.TrimSpace(input.AgentSessionID)
	if workspaceID == "" || agentSessionID == "" {
		return nil, ErrInvalidArgument
	}
	requested, err := normalizeRailPlacement(input.RailPlacement)
	if err != nil {
		return nil, err
	}
	input.RailPlacement = requested
	store, err := s.store(workspaceID)
	if err != nil {
		return nil, err
	}
	var explicit *storesqlite.RailSection
	if input.RailPlacement != nil {
		explicit = &storesqlite.RailSection{
			Kind:        string(input.RailPlacement.Kind),
			ProjectPath: input.RailPlacement.ProjectPath,
			Key:         input.RailPlacement.SectionKey,
		}
	}
	section, err := store.ResolveAgentSessionRailSection(ctx, storesqlite.ResolveAgentSessionRailSectionInput{
		WorkspaceID:                    workspaceID,
		AgentSessionID:                 agentSessionID,
		Cwd:                            input.Cwd,
		RuntimeContext:                 cloneStringAnyMap(input.RuntimeContext),
		ExplicitPlacement:              explicit,
		ExplicitPlacementAuthoritative: input.RailPlacementAuthoritative,
	})
	if err != nil {
		if errors.Is(err, storesqlite.ErrRailSectionConflict) {
			return nil, fmt.Errorf("%w: %v", ErrRailPlacementConflict, err)
		}
		return nil, err
	}
	resolved, err := normalizeRailPlacement(&RailPlacement{
		Version:     RailPlacementVersion,
		Kind:        RailPlacementKind(section.Kind),
		ProjectPath: section.ProjectPath,
		SectionKey:  section.Key,
	})
	if err != nil {
		return nil, err
	}
	if input.RailPlacement != nil && !railPlacementsEqual(input.RailPlacement, resolved) {
		return nil, ErrRailPlacementConflict
	}
	return resolved, nil
}

func railPlacementsEqual(left, right *RailPlacement) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return left.Version == right.Version && left.Kind == right.Kind &&
		storesqlite.AreProjectPathsEqual(left.ProjectPath, right.ProjectPath) &&
		storesqlite.NormalizeRailSectionKey(left.SectionKey) ==
			storesqlite.NormalizeRailSectionKey(right.SectionKey)
}

func (s *SQLiteWorkspaceStore) UpdateSessionTitle(ctx context.Context, workspaceID, sessionID, title string) (storesqlite.Session, bool, error) {
	store, err := s.store(workspaceID)
	if err != nil {
		return storesqlite.Session{}, false, err
	}
	session, changed, err := store.UpdateSessionTitle(ctx, workspaceID, sessionID, title)
	if err == nil && changed {
		NotifyCommitted(ctx, s.Observer, CanonicalDelta(session.CommitDelta))
	}
	return session, changed, err
}

func (s *SQLiteWorkspaceStore) UpdateSessionSettings(ctx context.Context, workspaceID, sessionID string, settings ComposerSettings) (storesqlite.Session, bool, error) {
	store, err := s.store(workspaceID)
	if err != nil {
		return storesqlite.Session{}, false, err
	}
	session, changed, err := store.UpdateSessionSettings(ctx, workspaceID, sessionID, settings.Model, composerSettingsPayload(&settings))
	if err == nil && changed {
		NotifyCommitted(ctx, s.Observer, CanonicalDelta(session.CommitDelta))
	}
	return session, changed, err
}

func (s *SQLiteWorkspaceStore) UpdateSessionPinned(ctx context.Context, workspaceID, sessionID string, pinned bool) (storesqlite.Session, bool, error) {
	store, err := s.store(workspaceID)
	if err != nil {
		return storesqlite.Session{}, false, err
	}
	session, changed, err := store.UpdateSessionPinned(ctx, workspaceID, sessionID, pinned)
	if err == nil && changed {
		NotifyCommitted(ctx, s.Observer, CanonicalDelta(session.CommitDelta))
	}
	return session, changed, err
}

func (s *SQLiteWorkspaceStore) PlanDeleteSessions(ctx context.Context, input storesqlite.DeleteSessionsBatchInput) (storesqlite.DeleteSessionsPlan, error) {
	store, err := s.store(input.WorkspaceID)
	if err != nil {
		return storesqlite.DeleteSessionsPlan{}, err
	}
	return store.PlanDeleteSessions(ctx, input)
}

func (s *SQLiteWorkspaceStore) PlanClearSessions(ctx context.Context, workspaceID string) (storesqlite.DeleteSessionsPlan, error) {
	store, err := s.store(strings.TrimSpace(workspaceID))
	if err != nil {
		return storesqlite.DeleteSessionsPlan{}, err
	}
	return store.PlanClearSessions(ctx, workspaceID)
}

func (s *SQLiteWorkspaceStore) DeleteSessionsBatch(ctx context.Context, input storesqlite.DeleteSessionsBatchInput) (storesqlite.DeleteSessionsBatchResult, error) {
	store, err := s.store(input.WorkspaceID)
	if err != nil {
		return storesqlite.DeleteSessionsBatchResult{}, err
	}
	result, err := store.DeleteSessionsBatch(ctx, input)
	if err == nil && result.RemovedSessions > 0 {
		NotifyCommitted(ctx, s.Observer, CanonicalDelta(result.CommitDelta))
	}
	return result, err
}

func (s *SQLiteWorkspaceStore) ListChildSessions(ctx context.Context, workspaceID, sessionID string) ([]storesqlite.Session, error) {
	store, err := s.store(workspaceID)
	if err != nil {
		return nil, err
	}
	return store.ListChildSessions(ctx, workspaceID, sessionID)
}

func (s *SQLiteWorkspaceStore) GetTurn(ctx context.Context, workspaceID, sessionID, turnID string) (storesqlite.Turn, bool, error) {
	store, err := s.store(workspaceID)
	if err != nil {
		return storesqlite.Turn{}, false, err
	}
	return store.GetTurn(ctx, workspaceID, sessionID, turnID)
}

func (s *SQLiteWorkspaceStore) FindTurnByClientSubmitID(ctx context.Context, workspaceID, sessionID, clientSubmitID string) (string, bool, error) {
	store, err := s.store(workspaceID)
	if err != nil {
		return "", false, err
	}
	return store.FindTurnByClientSubmitID(ctx, workspaceID, sessionID, clientSubmitID)
}

func (s *SQLiteWorkspaceStore) FindSubmitClaimByCanonicalTurn(
	ctx context.Context,
	workspaceID, sessionID, turnID string,
) (storesqlite.SubmitClaim, bool, error) {
	store, err := s.store(workspaceID)
	if err != nil {
		return storesqlite.SubmitClaim{}, false, err
	}
	return store.FindSubmitClaimByCanonicalTurn(
		ctx,
		workspaceID,
		sessionID,
		turnID,
	)
}

func (s *SQLiteWorkspaceStore) RecoverProviderTurnBinding(
	ctx context.Context,
	input storesqlite.ProviderTurnBindingRecovery,
) (storesqlite.ProviderTurnBindingRecoveryResult, error) {
	store, err := s.store(input.WorkspaceID)
	if err != nil {
		return storesqlite.ProviderTurnBindingRecoveryResult{}, err
	}
	result, err := store.RecoverProviderTurnBinding(ctx, input)
	if err == nil && result.Changed {
		NotifyCommitted(ctx, s.Observer, CanonicalDelta(result.CommitDelta))
	}
	return result, err
}

func (s *SQLiteWorkspaceStore) ListLatestTurnInteractions(ctx context.Context, workspaceID string, sessionIDs []string) (map[string][]storesqlite.Interaction, error) {
	store, err := s.store(workspaceID)
	if err != nil {
		return nil, err
	}
	return store.ListLatestTurnInteractions(ctx, workspaceID, sessionIDs)
}

func (s *SQLiteWorkspaceStore) GetSessionInteractionTreeSnapshot(
	ctx context.Context,
	query storesqlite.SessionInteractionTreeQuery,
) (storesqlite.SessionInteractionTreeSnapshot, bool, error) {
	store, err := s.store(query.WorkspaceID)
	if err != nil {
		return storesqlite.SessionInteractionTreeSnapshot{}, false, err
	}
	return store.GetSessionInteractionTreeSnapshot(ctx, query)
}

func (s *SQLiteWorkspaceStore) ListSessionInteractions(ctx context.Context, input storesqlite.ListSessionInteractionsInput) ([]storesqlite.Interaction, error) {
	store, err := s.store(input.WorkspaceID)
	if err != nil {
		return nil, err
	}
	return store.ListSessionInteractions(ctx, input)
}

func (s *SQLiteWorkspaceStore) ListSessionMessages(ctx context.Context, input storesqlite.ListSessionMessagesInput) (storesqlite.MessagePage, bool, error) {
	store, err := s.store(input.WorkspaceID)
	if err != nil {
		return storesqlite.MessagePage{}, false, err
	}
	return store.ListSessionMessages(ctx, input)
}

func (s *SQLiteWorkspaceStore) RecordTurnSubmission(ctx context.Context, input storesqlite.TurnSubmission) (storesqlite.TurnSubmission, bool, error) {
	store, err := s.store(input.WorkspaceID)
	if err != nil {
		return storesqlite.TurnSubmission{}, false, err
	}
	return store.RecordTurnSubmission(ctx, input)
}

func (s *SQLiteWorkspaceStore) GetTurnSubmission(ctx context.Context, workspaceID, sessionID, turnID string) (storesqlite.TurnSubmission, bool, error) {
	store, err := s.store(workspaceID)
	if err != nil {
		return storesqlite.TurnSubmission{}, false, err
	}
	return store.GetTurnSubmission(ctx, workspaceID, sessionID, turnID)
}

func (s *SQLiteWorkspaceStore) GetSessionHistory(ctx context.Context, workspaceID, sessionID string) (storesqlite.SessionHistory, bool, error) {
	store, err := s.store(workspaceID)
	if err != nil {
		return storesqlite.SessionHistory{}, false, err
	}
	return store.GetSessionHistory(ctx, workspaceID, sessionID)
}

func (s *SQLiteWorkspaceStore) GetTurnHistory(ctx context.Context, workspaceID, sessionID, turnID string) (storesqlite.TurnHistory, bool, error) {
	store, err := s.store(workspaceID)
	if err != nil {
		return storesqlite.TurnHistory{}, false, err
	}
	return store.GetTurnHistory(ctx, workspaceID, sessionID, turnID)
}

func (s *SQLiteWorkspaceStore) ListEffectiveSessionTurns(ctx context.Context, workspaceID, sessionID string) ([]storesqlite.Turn, error) {
	store, err := s.store(workspaceID)
	if err != nil {
		return nil, err
	}
	return store.ListEffectiveSessionTurns(ctx, workspaceID, sessionID)
}

func (s *SQLiteWorkspaceStore) MarkEditRetryRollbackDispatched(ctx context.Context, input storesqlite.MarkEditRetryRollbackDispatchedInput) (storesqlite.RuntimeOperation, bool, error) {
	store, err := s.store(input.WorkspaceID)
	if err != nil {
		return storesqlite.RuntimeOperation{}, false, err
	}
	return store.MarkEditRetryRollbackDispatched(ctx, input)
}

func (s *SQLiteWorkspaceStore) ConfirmEditRetryRollback(ctx context.Context, input storesqlite.ConfirmEditRetryRollbackInput) (storesqlite.RuntimeOperation, bool, error) {
	store, err := s.store(input.WorkspaceID)
	if err != nil {
		return storesqlite.RuntimeOperation{}, false, err
	}
	return store.ConfirmEditRetryRollback(ctx, input)
}

func (s *SQLiteWorkspaceStore) AbortEditRetryRollback(ctx context.Context, input storesqlite.AbortEditRetryRollbackInput) (storesqlite.RuntimeOperation, bool, error) {
	store, err := s.store(input.WorkspaceID)
	if err != nil {
		return storesqlite.RuntimeOperation{}, false, err
	}
	return store.AbortEditRetryRollback(ctx, input)
}

func (s *SQLiteWorkspaceStore) PrepareEditRetryReplacementRedispatch(
	ctx context.Context,
	input storesqlite.PrepareEditRetryReplacementRedispatchInput,
) (storesqlite.RuntimeOperation, bool, error) {
	store, err := s.store(input.WorkspaceID)
	if err != nil {
		return storesqlite.RuntimeOperation{}, false, err
	}
	return store.PrepareEditRetryReplacementRedispatch(ctx, input)
}

func (s *SQLiteWorkspaceStore) CompleteEditRetryRuntimeOperation(ctx context.Context, input storesqlite.CompleteEditRetryRuntimeOperationInput) (storesqlite.RuntimeOperationCompletion, bool, error) {
	store, err := s.store(input.WorkspaceID)
	if err != nil {
		return storesqlite.RuntimeOperationCompletion{}, false, err
	}
	return store.CompleteEditRetryRuntimeOperation(ctx, input)
}

func (s *SQLiteWorkspaceStore) FailEditRetryRecovery(ctx context.Context, input storesqlite.FailEditRetryRecoveryInput) (storesqlite.RuntimeOperation, bool, error) {
	store, err := s.store(input.WorkspaceID)
	if err != nil {
		return storesqlite.RuntimeOperation{}, false, err
	}
	return store.FailEditRetryRecovery(ctx, input)
}

func (s *SQLiteWorkspaceStore) QuarantineEditRetryOperation(ctx context.Context, input storesqlite.QuarantineEditRetryOperationInput) (storesqlite.RuntimeOperation, bool, error) {
	store, err := s.store(input.WorkspaceID)
	if err != nil {
		return storesqlite.RuntimeOperation{}, false, err
	}
	return store.QuarantineEditRetryOperation(ctx, input)
}

func (s *SQLiteWorkspaceStore) ClearAbandonedEditRetryFence(ctx context.Context, input storesqlite.ClearAbandonedEditRetryFenceInput) (bool, error) {
	store, err := s.store(input.WorkspaceID)
	if err != nil {
		return false, err
	}
	return store.ClearAbandonedEditRetryFence(ctx, input)
}

func (s *SQLiteWorkspaceStore) ListSessionTurnSummaries(ctx context.Context, input storesqlite.ListSessionTurnSummariesInput) (storesqlite.SessionTurnSummaryPage, error) {
	store, err := s.store(input.WorkspaceID)
	if err != nil {
		return storesqlite.SessionTurnSummaryPage{}, err
	}
	return store.ListSessionTurnSummaries(ctx, input)
}

func (s *SQLiteWorkspaceStore) GetProviderSessionResumeEvidence(
	ctx context.Context,
	workspaceID string,
	sessionID string,
) (storesqlite.ProviderSessionResumeEvidence, error) {
	store, err := s.store(workspaceID)
	if err != nil {
		return storesqlite.ProviderSessionResumeEvidence{}, err
	}
	return store.GetProviderSessionResumeEvidence(ctx, workspaceID, sessionID)
}

func (s *SQLiteWorkspaceStore) PrepareSubmitClaim(ctx context.Context, input storesqlite.SubmitClaimPrepare) (storesqlite.SubmitClaim, bool, error) {
	store, err := s.store(input.WorkspaceID)
	if err != nil {
		return storesqlite.SubmitClaim{}, false, err
	}
	return store.PrepareSubmitClaim(ctx, input)
}

func (s *SQLiteWorkspaceStore) AcceptSubmitClaim(ctx context.Context, workspaceID, sessionID, clientSubmitID, turnID string, now int64) (storesqlite.SubmitClaim, bool, error) {
	store, err := s.store(workspaceID)
	if err != nil {
		return storesqlite.SubmitClaim{}, false, err
	}
	return store.AcceptSubmitClaim(ctx, workspaceID, sessionID, clientSubmitID, turnID, now)
}

func (s *SQLiteWorkspaceStore) RejectSubmitClaim(ctx context.Context, workspaceID, sessionID, clientSubmitID, turnID string, now int64) (storesqlite.SubmitClaim, bool, error) {
	store, err := s.store(workspaceID)
	if err != nil {
		return storesqlite.SubmitClaim{}, false, err
	}
	return store.RejectSubmitClaim(ctx, workspaceID, sessionID, clientSubmitID, turnID, now)
}

func (s *SQLiteWorkspaceStore) DeleteSubmitClaim(ctx context.Context, workspaceID, sessionID, clientSubmitID string) (bool, error) {
	store, err := s.store(workspaceID)
	if err != nil {
		return false, err
	}
	return store.DeleteSubmitClaim(ctx, workspaceID, sessionID, clientSubmitID)
}

func (s *SQLiteWorkspaceStore) store(workspaceID string) (*storesqlite.Store, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	if s == nil || s.StoreForWorkspace == nil || workspaceID == "" {
		return nil, errors.New("workspace-scoped canonical agent store is unavailable")
	}
	store := s.StoreForWorkspace(workspaceID)
	if store == nil {
		return nil, errors.New("workspace-scoped canonical agent store is unavailable")
	}
	return store, nil
}

func (s *SQLiteWorkspaceStore) currentUserID() string {
	if s != nil && s.CurrentUserID != nil {
		return strings.TrimSpace(s.CurrentUserID())
	}
	return ""
}

func (s *SQLiteWorkspaceStore) now() time.Time {
	if s != nil && s.Clock != nil {
		return s.Clock.Now()
	}
	return time.Now().UTC()
}

func composerSettingsPayload(settings *ComposerSettings) map[string]any {
	if settings == nil {
		return nil
	}
	return map[string]any{
		"codexSaverMode": settings.CodexSaverMode,
		"rtkSaverMode":   settings.RTKSaverMode,
		"model":          settings.Model, "permissionModeId": settings.PermissionModeID, "planMode": settings.PlanMode,
		"browserUse": settings.BrowserUse, "computerUse": settings.ComputerUse,
		"reasoningEffort": settings.ReasoningEffort, "speed": settings.Speed,
		"conversationDetailMode": settings.ConversationDetailMode,
	}
}

func composerSettingsModel(settings *ComposerSettings) string {
	if settings == nil {
		return ""
	}
	return strings.TrimSpace(settings.Model)
}

func runtimeLifecycleStatus(status string) string {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "failed":
		return "failed"
	case "completed", "canceled":
		return "ended"
	default:
		return "active"
	}
}

func runtimeLifecyclePhase(status string) string {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "working":
		return "working"
	case "waiting":
		return "waiting"
	case "failed":
		return "failed"
	default:
		return "idle"
	}
}

func cloneStringAnyMap(input map[string]any) map[string]any {
	if input == nil {
		return nil
	}
	result := make(map[string]any, len(input))
	for key, value := range input {
		result[key] = value
	}
	return result
}

func firstNonBlank(values ...string) string {
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			return value
		}
	}
	return ""
}
