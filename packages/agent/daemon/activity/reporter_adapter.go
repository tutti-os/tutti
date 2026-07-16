package agentsessionstore

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"time"
)

// SessionActivityReporterAdapter bridges the coarse ActivityReporter interface
// to a SessionActivityReporter backend. Each Report call is converted into
// per-session state patches (ReportSessionState) and message-update groups
// (ReportSessionMessages), and the per-session sync outcome
// (pending/synced/failed with pending counts and last error) is tracked and —
// when a SyncStateStore is injected — persisted across restarts.
//
// This is the extension point for external daemons that project local agent
// activity to a remote controlplane: construct a Client with the controlplane
// BaseURL (or any custom SessionActivityReporter implementation) and wrap it
// in this adapter to obtain a drop-in ActivityReporter with durable sync-state
// tracking. No activity package code needs to be forked.
//
// Scope identifier: ReportActivityInput.WorkspaceID is used verbatim as the
// SyncStateStore roomID — tutti side = workspace ID, external daemons (tsh) =
// control-plane room ID; workspace ≡ room, one-to-one. The adapter never
// translates or remaps this value.
type SessionActivityReporterAdapter struct {
	reporter SessionActivityReporter
	store    SyncStateStore
	now      func() time.Time

	mu     sync.Mutex
	rooms  map[string]map[string]*agentSessionSyncState
	loaded map[string]struct{}
}

var _ ActivityReporter = (*SessionActivityReporterAdapter)(nil)

func (a *SessionActivityReporterAdapter) BindGoalProvenance(ctx context.Context, input BindGoalProvenanceInput) (GoalProvenanceBinding, error) {
	if a == nil {
		return GoalProvenanceBinding{}, errors.New("agent activity reporter does not support goal provenance")
	}
	ledger, ok := a.reporter.(GoalProvenanceLedger)
	if !ok {
		return GoalProvenanceBinding{}, errors.New("agent activity reporter does not support goal provenance")
	}
	return ledger.BindGoalProvenance(ctx, input)
}

func (a *SessionActivityReporterAdapter) LookupGoalProvenance(ctx context.Context, input LookupGoalProvenanceInput) (GoalProvenanceBinding, bool, error) {
	if a == nil {
		return GoalProvenanceBinding{}, false, errors.New("agent activity reporter does not support goal provenance")
	}
	ledger, ok := a.reporter.(GoalProvenanceLedger)
	if !ok {
		return GoalProvenanceBinding{}, false, errors.New("agent activity reporter does not support goal provenance")
	}
	return ledger.LookupGoalProvenance(ctx, input)
}

// SessionActivityReporterAdapterOption configures a
// SessionActivityReporterAdapter.
type SessionActivityReporterAdapterOption func(*SessionActivityReporterAdapter)

// WithReporterSyncStateStore persists the adapter's per-session sync states.
// Previously persisted states seed the adapter on first touch of a room, and
// every transition is written through. Without this option sync states live
// in memory only.
func WithReporterSyncStateStore(store SyncStateStore) SessionActivityReporterAdapterOption {
	return func(adapter *SessionActivityReporterAdapter) {
		if adapter != nil {
			adapter.store = store
		}
	}
}

// NewSessionActivityReporterAdapter returns an ActivityReporter that forwards
// activity to the given SessionActivityReporter.
func NewSessionActivityReporterAdapter(
	reporter SessionActivityReporter,
	opts ...SessionActivityReporterAdapterOption,
) *SessionActivityReporterAdapter {
	adapter := &SessionActivityReporterAdapter{
		reporter: reporter,
		now:      time.Now,
		rooms:    make(map[string]map[string]*agentSessionSyncState),
		loaded:   make(map[string]struct{}),
	}
	for _, opt := range opts {
		if opt != nil {
			opt(adapter)
		}
	}
	return adapter
}

// Report converts the activity input into session state and message reports
// and forwards them session by session. Each session's batch transitions its
// sync state to pending before sending and to synced or failed afterwards.
// The first send failure marks that session failed and aborts the report;
// sessions not yet attempted keep their previous sync state.
func (a *SessionActivityReporterAdapter) Report(ctx context.Context, input ReportActivityInput) error {
	if a == nil || a.reporter == nil {
		return nil
	}
	// The workspace ID is the scope identifier used as-is for sync-state
	// persistence and report inputs below (workspace ≡ control-plane room,
	// one-to-one, no translation).
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	if workspaceID == "" {
		return errors.New("workspace id is required")
	}
	if len(input.GoalReconcileRequests) > 0 {
		goalReporter, ok := a.reporter.(GoalReconcileRequestReporter)
		if !ok {
			return errors.New("agent activity reporter does not support goal reconcile requests")
		}
		for _, request := range input.GoalReconcileRequests {
			reply, err := goalReporter.ReportGoalReconcileRequired(ctx, ReportGoalReconcileRequiredInput{
				WorkspaceID: workspaceID,
				Request:     request,
			})
			if err != nil {
				return err
			}
			if !reply.Accepted {
				return errors.New("goal reconcile request was not accepted")
			}
		}
	}
	stateInputs := SessionStateInputsFromActivity(input)
	auditInputs := SessionAuditInputsFromActivity(input)
	messageInputs, err := SessionMessageInputsFromActivity(input)
	if err != nil {
		return err
	}

	type sessionWork struct {
		agentSessionID string
		states         []ReportSessionStateInput
		messages       []ReportSessionMessagesInput
		messageUpdates int
	}
	order := make([]string, 0, len(stateInputs)+len(auditInputs)+len(messageInputs))
	workBySession := make(map[string]*sessionWork)
	workFor := func(agentSessionID string) *sessionWork {
		work := workBySession[agentSessionID]
		if work == nil {
			work = &sessionWork{agentSessionID: agentSessionID}
			workBySession[agentSessionID] = work
			order = append(order, agentSessionID)
		}
		return work
	}
	for _, stateInput := range stateInputs {
		stateInput.WorkspaceID = workspaceID
		work := workFor(stateInput.AgentSessionID)
		work.states = append(work.states, stateInput)
	}
	for _, messagesInput := range messageInputs {
		messagesInput.WorkspaceID = workspaceID
		work := workFor(messagesInput.AgentSessionID)
		work.messages = append(work.messages, messagesInput)
		work.messageUpdates += len(messagesInput.Updates)
	}
	for _, auditInput := range auditInputs {
		auditInput.WorkspaceID = workspaceID
		work := workFor(auditInput.AgentSessionID)
		work.messages = append(work.messages, auditInput)
		work.messageUpdates += len(auditInput.Updates)
	}

	for _, agentSessionID := range order {
		work := workBySession[agentSessionID]
		a.markSyncPending(workspaceID, agentSessionID, len(work.states), work.messageUpdates)
		if err := a.reportSessionWork(ctx, work.states, work.messages); err != nil {
			a.markSyncFailed(workspaceID, agentSessionID, err)
			return err
		}
		a.markSyncSucceeded(workspaceID, agentSessionID, len(work.states), work.messageUpdates)
	}
	return nil
}

func (a *SessionActivityReporterAdapter) reportSessionWork(
	ctx context.Context,
	states []ReportSessionStateInput,
	messages []ReportSessionMessagesInput,
) error {
	for _, stateInput := range states {
		if _, err := a.reporter.ReportSessionState(ctx, stateInput); err != nil {
			return err
		}
	}
	for _, messagesInput := range messages {
		if _, err := a.reporter.ReportSessionMessages(ctx, messagesInput); err != nil {
			return err
		}
	}
	return nil
}

// RoomSyncStates returns the adapter's current sync states for a room keyed by
// agent session id, seeding from the injected SyncStateStore on first touch.
// roomID is the scope identifier: it is exactly the WorkspaceID passed to
// Report (tutti side = workspace ID, tsh side = control-plane room ID;
// workspace ≡ room, one-to-one).
func (a *SessionActivityReporterAdapter) RoomSyncStates(roomID string) map[string]WorkspaceAgentSyncState {
	roomID = strings.TrimSpace(roomID)
	if a == nil || roomID == "" {
		return nil
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	room := a.roomStatesLocked(roomID)
	out := make(map[string]WorkspaceAgentSyncState, len(room))
	for agentSessionID, current := range room {
		out[agentSessionID] = current.state
	}
	return out
}

func (a *SessionActivityReporterAdapter) markSyncPending(
	roomID string,
	agentSessionID string,
	statePatchCount int,
	messageUpdateCount int,
) {
	a.updateSyncState(roomID, agentSessionID, func(current *agentSessionSyncState, now int64) WorkspaceAgentSyncState {
		return applyActivitySyncPending(current, agentSessionID, 0, statePatchCount, messageUpdateCount, now)
	})
}

func (a *SessionActivityReporterAdapter) markSyncSucceeded(
	roomID string,
	agentSessionID string,
	statePatchCount int,
	messageUpdateCount int,
) {
	a.updateSyncState(roomID, agentSessionID, func(current *agentSessionSyncState, now int64) WorkspaceAgentSyncState {
		return applyActivitySyncSucceeded(current, agentSessionID, 0, statePatchCount, messageUpdateCount, now)
	})
}

func (a *SessionActivityReporterAdapter) markSyncFailed(roomID string, agentSessionID string, err error) {
	a.updateSyncState(roomID, agentSessionID, func(current *agentSessionSyncState, now int64) WorkspaceAgentSyncState {
		return applyActivitySyncFailed(current, agentSessionID, err, now)
	})
}

func (a *SessionActivityReporterAdapter) updateSyncState(
	roomID string,
	agentSessionID string,
	update func(*agentSessionSyncState, int64) WorkspaceAgentSyncState,
) {
	roomID = strings.TrimSpace(roomID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	if a == nil || roomID == "" || agentSessionID == "" || update == nil {
		return
	}
	a.mu.Lock()
	room := a.roomStatesLocked(roomID)
	current := room[agentSessionID]
	if current == nil {
		current = &agentSessionSyncState{
			state: WorkspaceAgentSyncState{AgentSessionID: agentSessionID},
		}
		room[agentSessionID] = current
	}
	next := update(current, a.adapterNow().UnixMilli())
	current.state = next
	// Persist while holding a.mu so the persisted order matches the
	// transition order under concurrent Reports: a stale pending write must
	// never land after a newer synced/failed write, or a restart would
	// resurrect it as a spurious failure.
	a.persistSyncState(roomID, next)
	a.mu.Unlock()
}

func (a *SessionActivityReporterAdapter) roomStatesLocked(roomID string) map[string]*agentSessionSyncState {
	if a.rooms == nil {
		a.rooms = make(map[string]map[string]*agentSessionSyncState)
	}
	room := a.rooms[roomID]
	if room == nil {
		room = make(map[string]*agentSessionSyncState)
		a.rooms[roomID] = room
	}
	if a.loaded == nil {
		a.loaded = make(map[string]struct{})
	}
	if _, ok := a.loaded[roomID]; !ok {
		a.loaded[roomID] = struct{}{}
		for agentSessionID, syncState := range a.loadPersistedSyncStates(roomID) {
			agentSessionID = strings.TrimSpace(agentSessionID)
			if agentSessionID == "" {
				continue
			}
			if _, exists := room[agentSessionID]; exists {
				continue
			}
			room[agentSessionID] = syncEntryFromState(syncState)
		}
	}
	return room
}

func (a *SessionActivityReporterAdapter) loadPersistedSyncStates(roomID string) map[string]WorkspaceAgentSyncState {
	if a.store == nil {
		return nil
	}
	states, err := a.store.LoadRoomSyncStates(context.Background(), roomID)
	if err != nil {
		slog.Warn("agent activity reporter sync state load failed",
			"event", "agent_activity.reporter_sync_state.load_failed",
			"room_id", roomID,
			"error", err,
		)
		return nil
	}
	return states
}

func (a *SessionActivityReporterAdapter) persistSyncState(roomID string, syncState WorkspaceAgentSyncState) {
	if a == nil || a.store == nil {
		return
	}
	if err := a.store.SaveAgentSyncState(context.Background(), roomID, syncState); err != nil {
		slog.Warn("agent activity reporter sync state save failed",
			"event", "agent_activity.reporter_sync_state.save_failed",
			"room_id", roomID,
			"agent_session_id", strings.TrimSpace(syncState.AgentSessionID),
			"error", err,
		)
	}
}

func (a *SessionActivityReporterAdapter) adapterNow() time.Time {
	if a != nil && a.now != nil {
		return a.now()
	}
	return time.Now()
}
