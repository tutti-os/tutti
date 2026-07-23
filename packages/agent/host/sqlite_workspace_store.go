package agenthost

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
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
var _ SessionManagementStore = (*SQLiteWorkspaceStore)(nil)
var _ SessionBatchManagementStore = (*SQLiteWorkspaceStore)(nil)

func (s *SQLiteWorkspaceStore) GetSession(ctx context.Context, workspaceID, sessionID string) (storesqlite.Session, bool, error) {
	store, err := s.store(workspaceID)
	if err != nil {
		return storesqlite.Session{}, false, err
	}
	return store.GetSession(ctx, workspaceID, sessionID)
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
			WorkspaceID:       workspaceID,
			AgentSessionID:    sessionID,
			Kind:              storesqlite.SessionKindRoot,
			Origin:            canonicalRuntimeSessionOrigin,
			UserID:            userID,
			AgentTargetID:     strings.TrimSpace(session.AgentTargetID),
			Provider:          strings.TrimSpace(session.Provider),
			ProviderSessionID: strings.TrimSpace(session.ProviderSessionID),
			Model:             composerSettingsModel(session.Settings),
			Settings:          composerSettingsPayload(session.Settings),
			RuntimeContext:    runtimeContext,
			Cwd:               strings.TrimSpace(session.Cwd),
			RailPlacement:     railPlacement,
			Title:             strings.TrimSpace(session.Title),
			Status:            runtimeLifecycleStatus(session.Status),
			CurrentPhase:      runtimeLifecyclePhase(session.Status),
			LastError:         strings.TrimSpace(session.LastError),
			OccurredAtUnixMS:  occurredAt,
			StartedAtUnixMS:   session.CreatedAtUnixMS,
			CreatedAtUnixMS:   session.CreatedAtUnixMS,
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

func (s *SQLiteWorkspaceStore) ListLatestTurnInteractions(ctx context.Context, workspaceID string, sessionIDs []string) (map[string][]storesqlite.Interaction, error) {
	store, err := s.store(workspaceID)
	if err != nil {
		return nil, err
	}
	return store.ListLatestTurnInteractions(ctx, workspaceID, sessionIDs)
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
		"model": settings.Model, "permissionModeId": settings.PermissionModeID, "planMode": settings.PlanMode,
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
