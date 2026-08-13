package agentruntime

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"time"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

// claudeSDKGoalCommandTimeout bounds the sidecar ack round-trip for /goal
// command execs issued by goal controls.
const claudeSDKGoalCommandTimeout = 30 * time.Second

func claudeGoalSlashPromptUpdate(prompt string) (map[string]any, string, bool) {
	text := strings.TrimSpace(prompt)
	if !strings.HasPrefix(text, appServerSlashGoal) {
		return nil, "", false
	}
	if len(text) > len(appServerSlashGoal) {
		switch text[len(appServerSlashGoal)] {
		case ' ', '\t', '\n', '\r':
		default:
			return nil, "", false
		}
	}
	objective := strings.TrimSpace(text[len(appServerSlashGoal):])
	if objective == "" {
		return nil, "", false
	}
	if isGoalClearCommandArgs(objective) {
		return nil, "thread_goal_cleared", true
	}
	return map[string]any{"objective": objective, "status": "active"}, "thread_goal_update", true
}

// Claude Code's goal is a session-level entity inside the CLI (a condition
// whose evaluator drives autonomous new turns until it is met), but the SDK
// exposes no control API for it: commands go in as /goal prompt text, state
// comes out as active_goal lifecycle messages, and there is no paused state — an
// interrupted goal stays active and resumes continuation after the next user
// message. The adapter therefore keeps goal interaction 1:1 with that
// surface: set and clear forward the native /goal command (the sidecar
// queues it behind a live turn), display is observation-only, and
// pause/resume are rejected rather than emulated — a wrapper may shorten
// native operations but must not invent states the CLI cannot honor.
// Providers with a real paused state advertise CapabilityGoalPause; the GUI
// hides the pause/resume controls without it.

// GoalControl performs a direct goal action (GUI banner buttons) without
// claiming the session's turn slot.
func (*ClaudeCodeSDKAdapter) GoalCapabilities() GoalAdapterCapabilities {
	return GoalAdapterCapabilities{
		QuerySupported: false, ClearSupported: true, PauseSupported: false,
		QuiesceGoalTurns: true, ReplaySetAfterRestart: false,
	}
}

func (a *ClaudeCodeSDKAdapter) FenceGoalGeneration(
	ctx context.Context,
	session Session,
	input GoalGenerationFenceInput,
) error {
	identity := goalOperationIdentity{
		operationID: strings.TrimSpace(input.OperationID),
		revision:    input.Revision,
		repairEpoch: input.RepairEpoch,
	}
	if !identity.valid() {
		return errors.New("valid Goal generation fence identity is required")
	}
	a.mu.Lock()
	adapterSession := a.sessions[strings.TrimSpace(session.AgentSessionID)]
	if adapterSession == nil {
		a.mu.Unlock()
		return ErrSessionDisconnected
	}
	if adapterSession.fencedGoalIdentities == nil {
		adapterSession.fencedGoalIdentities = make(map[goalOperationIdentity]struct{})
	}
	adapterSession.fencedGoalIdentities[identity] = struct{}{}
	bindings := make([]claudeSDKGoalTurnBinding, 0, 1)
	pendingTurnIDs := make([]string, 0, 1)
	boundTurnIDs := make(map[string]struct{})
	publicationDone := make([]<-chan struct{}, 0, 1)
	for _, binding := range adapterSession.goalTurnBindings {
		if binding.identity != identity {
			continue
		}
		markClaudeSDKGoalTurnFencedLocked(adapterSession, binding.published, binding.turnID, binding.providerTurnID)
		bindings = append(bindings, binding)
		boundTurnIDs[binding.turnID] = struct{}{}
		if binding.published && binding.publicationDone != nil {
			publicationDone = append(publicationDone, binding.publicationDone)
		}
	}
	for turnID, pending := range adapterSession.pendingGoalCommands {
		if pending.identity != identity {
			continue
		}
		if _, alreadyBound := boundTurnIDs[turnID]; alreadyBound {
			continue
		}
		// The provider identity/start events may already be queued in the
		// transport while the accepted Goal command is still pending here. Own
		// the exact Turn fence before releasing the lock so those late events
		// cannot publish a canonical start, and retain both aliases until their
		// terminal cleanup arrives.
		markClaudeSDKGoalTurnFencedLocked(adapterSession, false, turnID)
		if adapterSession.goalTurnBindings == nil {
			adapterSession.goalTurnBindings = make(map[string]claudeSDKGoalTurnBinding)
		}
		if _, bound := adapterSession.goalTurnBindings[turnID]; !bound {
			adapterSession.goalTurnBindings[turnID] = claudeSDKGoalTurnBinding{
				turnID: turnID, identity: pending.identity,
			}
		}
		if adapterSession.rootProviderTurns == nil {
			adapterSession.rootProviderTurns = make(map[string]struct{})
		}
		adapterSession.rootProviderTurns[turnID] = struct{}{}
		pendingTurnIDs = append(pendingTurnIDs, turnID)
	}
	a.mu.Unlock()
	for _, binding := range bindings {
		a.rememberClaudeSDKRootProviderTurn(adapterSession, binding.turnID)
		a.rememberClaudeSDKRootProviderTurn(adapterSession, binding.providerTurnID)
		a.cancelClaudeSDKGoalTurn(adapterSession, session, binding.turnID, identity.revision, identity.repairEpoch)
	}
	for _, turnID := range pendingTurnIDs {
		a.cancelClaudeSDKGoalTurn(adapterSession, session, turnID, identity.revision, identity.repairEpoch)
	}
	for _, done := range publicationDone {
		select {
		case <-done:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return nil
}

func (a *ClaudeCodeSDKAdapter) ApplyGoal(
	ctx context.Context,
	session Session,
	input GoalApplyInput,
) (GoalAdapterResult, error) {
	action := input.Action
	objective := input.Objective
	adapterSession := a.getSession(session.AgentSessionID)
	if adapterSession == nil {
		return GoalAdapterResult{}, ErrSessionDisconnected
	}
	session.ProviderSessionID = adapterSession.providerSessionID
	slog.Info("agent session claude sdk goal control",
		"event", "agent_session.claude_sdk.goal.control",
		"agent_session_id", session.AgentSessionID,
		"action", string(action),
	)

	var events []activityshared.Event
	previousOperationID, previousRevision, previousRepairEpoch := a.replaceClaudeGoalOperationIdentity(adapterSession, input.OperationID, input.Revision, input.RepairEpoch)
	restoreIdentity := func() {
		a.restoreClaudeGoalOperationIdentity(adapterSession, input.OperationID, input.Revision, input.RepairEpoch, previousOperationID, previousRevision, previousRepairEpoch)
	}
	switch action {
	case GoalControlSet:
		objective = strings.TrimSpace(objective)
		if objective == "" {
			restoreIdentity()
			return GoalAdapterResult{}, fmt.Errorf("goal objective is required")
		}
		if err := a.applyGoalMirrorAndSend(ctx, session, adapterSession,
			map[string]any{"objective": objective, "status": "active"},
			appServerSlashGoal+" "+objective, input.OperationID, input.Revision, input.RepairEpoch); err != nil {
			restoreIdentity()
			return GoalAdapterResult{}, err
		}
		events = a.goalMirrorEvents(session, "thread_goal_update")
	case GoalControlClear:
		if err := a.applyGoalMirrorAndSend(ctx, session, adapterSession, nil, appServerSlashGoal+" clear", input.OperationID, input.Revision, input.RepairEpoch); err != nil {
			restoreIdentity()
			return GoalAdapterResult{}, err
		}
		events = append(events, a.goalMirrorEvents(session, "thread_goal_cleared")...)
	case GoalControlPause, GoalControlResume:
		restoreIdentity()
		return GoalAdapterResult{}, fmt.Errorf("goal %s is not supported for claude sessions: Claude Code has no paused goal state (stop the turn, or clear the goal)", action)
	default:
		restoreIdentity()
		return GoalAdapterResult{}, fmt.Errorf("unsupported goal control action %q", action)
	}
	return GoalAdapterResult{
		Events: events, Observation: a.localGoal(adapterSession),
		Evidence:         map[string]any{"source": "claude_command_ack", "confidence": "accepted_only", "phase": "accepted", "repairEpoch": input.RepairEpoch},
		ProviderPhase:    "accepted",
		ExecutionPending: action == GoalControlSet,
	}, nil
}

// GoalControl is retained as an adapter-level compatibility shim for focused
// provider tests; controller consumers use the semantic ApplyGoal contract.
func (a *ClaudeCodeSDKAdapter) GoalControl(ctx context.Context, session Session, action GoalControlAction, objective string) ([]activityshared.Event, map[string]any, error) {
	result, err := a.ApplyGoal(ctx, session, GoalApplyInput{Action: action, Objective: objective})
	return result.Events, result.Observation, err
}

func (a *ClaudeCodeSDKAdapter) replaceClaudeGoalOperationIdentity(adapterSession *claudeSDKAdapterSession, operationID string, revision int64, repairEpoch int64) (string, int64, int64) {
	a.mu.Lock()
	defer a.mu.Unlock()
	previousOperationID, previousRevision, previousRepairEpoch := adapterSession.goalOperationID, adapterSession.goalRevision, adapterSession.goalRepairEpoch
	if revision > 0 || strings.TrimSpace(operationID) != "" {
		adapterSession.goalOperationID, adapterSession.goalRevision, adapterSession.goalRepairEpoch = strings.TrimSpace(operationID), revision, repairEpoch
	}
	return previousOperationID, previousRevision, previousRepairEpoch
}

func (a *ClaudeCodeSDKAdapter) restoreClaudeGoalOperationIdentity(adapterSession *claudeSDKAdapterSession, operationID string, revision int64, repairEpoch int64, previousOperationID string, previousRevision int64, previousRepairEpoch int64) {
	if revision <= 0 && strings.TrimSpace(operationID) == "" {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if adapterSession.goalOperationID != strings.TrimSpace(operationID) || adapterSession.goalRevision != revision || adapterSession.goalRepairEpoch != repairEpoch {
		return
	}
	adapterSession.goalOperationID, adapterSession.goalRevision, adapterSession.goalRepairEpoch = previousOperationID, previousRevision, previousRepairEpoch
}

type claudeSDKGoalTurnAdmission struct {
	metadata map[string]any
	origin   string
	identity goalOperationIdentity
	goalTurn bool
	fenced   bool
	stale    bool
}

func (admission claudeSDKGoalTurnAdmission) denied() bool {
	return admission.fenced || admission.stale
}

// admitClaudeSDKGoalTurn applies the same exact Goal-generation rule at both
// provider identity and turn-start barriers. Provenance comes only from the
// sidecar's immutable RuntimeTurn; mutable session Goal state is never used to
// guess which durable operation created a Turn.
func (a *ClaudeCodeSDKAdapter) admitClaudeSDKGoalTurn(
	adapterSession *claudeSDKAdapterSession,
	turnID string,
	providerTurnID string,
	payload map[string]any,
) (claudeSDKGoalTurnAdmission, error) {
	origin := strings.TrimSpace(payloadString(payload, "turnOrigin"))
	operationID := strings.TrimSpace(payloadString(payload, "sourceGoalOperationId"))
	revision := payloadInt64(payload, "sourceGoalRevision")
	repairEpoch := payloadInt64(payload, "sourceGoalRepairEpoch")
	if origin != "goal_arm" && origin != "goal_continuation" {
		return claudeSDKGoalTurnAdmission{}, nil
	}
	admission := claudeSDKGoalTurnAdmission{
		metadata: map[string]any{
			"turnOrigin":            origin,
			"sourceGoalOperationId": operationID,
			"sourceGoalRevision":    revision,
			"sourceGoalRepairEpoch": repairEpoch,
		},
		origin: origin,
		identity: goalOperationIdentity{
			operationID: operationID,
			revision:    revision,
			repairEpoch: repairEpoch,
		},
		goalTurn: true,
	}
	if !admission.identity.valid() {
		return claudeSDKGoalTurnAdmission{}, errors.New("claude SDK Goal turn omitted generation identity")
	}
	if a == nil || adapterSession == nil {
		return admission, nil
	}

	turnID = strings.TrimSpace(turnID)
	providerTurnID = strings.TrimSpace(providerTurnID)
	a.mu.Lock()
	defer a.mu.Unlock()
	_, admission.fenced = adapterSession.fencedGoalIdentities[admission.identity]
	admission.stale = adapterSession.goalOperationID == admission.identity.operationID &&
		adapterSession.goalRevision == admission.identity.revision &&
		adapterSession.goalRepairEpoch > admission.identity.repairEpoch
	if admission.denied() {
		markClaudeSDKGoalTurnFencedLocked(adapterSession, false, turnID, providerTurnID)
		return admission, nil
	}
	if turnID == "" {
		return claudeSDKGoalTurnAdmission{}, errors.New("claude SDK Goal turn omitted identity")
	}
	if adapterSession.goalTurnBindings == nil {
		adapterSession.goalTurnBindings = make(map[string]claudeSDKGoalTurnBinding)
	}
	if existing, ok := adapterSession.goalTurnBindings[turnID]; ok {
		if existing.origin != admission.origin || existing.identity != admission.identity ||
			(existing.providerTurnID != "" && providerTurnID != "" && existing.providerTurnID != providerTurnID) {
			return claudeSDKGoalTurnAdmission{}, errors.New("claude SDK Goal turn provenance changed after binding")
		}
		if existing.providerTurnID == "" {
			existing.providerTurnID = providerTurnID
		}
		adapterSession.goalTurnBindings[turnID] = existing
		return admission, nil
	}
	adapterSession.goalTurnBindings[turnID] = claudeSDKGoalTurnBinding{
		turnID: turnID, providerTurnID: providerTurnID,
		origin: admission.origin, identity: admission.identity,
	}
	return admission, nil
}

func markClaudeSDKGoalTurnFencedLocked(adapterSession *claudeSDKAdapterSession, settle bool, turnIDs ...string) {
	if adapterSession == nil {
		return
	}
	if adapterSession.fencedGoalTurns == nil {
		adapterSession.fencedGoalTurns = make(map[string]claudeSDKGoalTurnFenceState)
	}
	state := claudeSDKGoalTurnFenceSuppress
	if settle {
		state = claudeSDKGoalTurnFenceSettle
	}
	for _, turnID := range turnIDs {
		if turnID = strings.TrimSpace(turnID); turnID != "" {
			if adapterSession.fencedGoalTurns[turnID] < state {
				adapterSession.fencedGoalTurns[turnID] = state
			}
		}
	}
}

// publishClaudeSDKGoalTurn is the in-memory linearization point between
// provider admission and event publication. A fence that wins first suppresses
// the start entirely; a fence that wins after this point must preserve the
// terminal event so the reporter FIFO can settle the already-published start.
func (a *ClaudeCodeSDKAdapter) publishClaudeSDKGoalTurn(
	adapterSession *claudeSDKAdapterSession,
	turnID string,
) bool {
	if a == nil || adapterSession == nil {
		return false
	}
	turnID = strings.TrimSpace(turnID)
	a.mu.Lock()
	defer a.mu.Unlock()
	binding, ok := adapterSession.goalTurnBindings[turnID]
	if !ok || adapterSession.fencedGoalTurns[turnID] != 0 {
		return false
	}
	if binding.published {
		return false
	}
	if _, fenced := adapterSession.fencedGoalIdentities[binding.identity]; fenced {
		markClaudeSDKGoalTurnFencedLocked(adapterSession, false, binding.turnID, binding.providerTurnID)
		return false
	}
	binding.published = true
	binding.publicationDone = make(chan struct{})
	adapterSession.goalTurnBindings[turnID] = binding
	return true
}

func (a *ClaudeCodeSDKAdapter) finishClaudeSDKGoalTurnPublication(
	adapterSession *claudeSDKAdapterSession,
	events []activityshared.Event,
) {
	if a == nil || adapterSession == nil || len(events) == 0 {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, event := range events {
		if event.Type != activityshared.EventRootProviderTurnStarted {
			continue
		}
		origin := strings.TrimSpace(payloadString(event.Payload.Metadata, "turnOrigin"))
		if origin != "goal_arm" && origin != "goal_continuation" {
			continue
		}
		turnID := strings.TrimSpace(event.Payload.TurnID)
		binding, ok := adapterSession.goalTurnBindings[turnID]
		if !ok || !binding.published || binding.publicationDone == nil {
			continue
		}
		close(binding.publicationDone)
		binding.publicationDone = nil
		adapterSession.goalTurnBindings[turnID] = binding
	}
}

func isClaudeSDKGoalClearHiddenEvent(eventType string) bool {
	switch eventType {
	case "provider_turn_identity_resolved", "turn_started", "provider_turn_checkpoint", "assistant_delta", "assistant_completed", "assistant_failed", "thinking_delta", "thinking_completed":
		return true
	default:
		return false
	}
}

func (a *ClaudeCodeSDKAdapter) rejectClaudeSDKGoalTurn(
	adapterSession *claudeSDKAdapterSession,
	session Session,
	turnID string,
	providerTurnID string,
	admission claudeSDKGoalTurnAdmission,
) {
	// Retain both aliases until the provider terminal event so dispatcher
	// filtering cannot discard the cleanup event before the fence consumes it.
	a.rememberClaudeSDKRootProviderTurn(adapterSession, turnID)
	a.rememberClaudeSDKRootProviderTurn(adapterSession, providerTurnID)
	a.cancelClaudeSDKGoalTurn(
		adapterSession,
		session,
		turnID,
		admission.identity.revision,
		admission.identity.repairEpoch,
	)
}

func (a *ClaudeCodeSDKAdapter) forgetClaudeSDKGoalTurnBinding(adapterSession *claudeSDKAdapterSession, turnID string) {
	if a == nil || adapterSession == nil {
		return
	}
	a.mu.Lock()
	delete(adapterSession.goalTurnBindings, strings.TrimSpace(turnID))
	a.mu.Unlock()
}

func (a *ClaudeCodeSDKAdapter) ReconcileGoal(_ context.Context, session Session) (GoalAdapterResult, error) {
	adapterSession := a.getSession(session.AgentSessionID)
	if adapterSession == nil {
		return GoalAdapterResult{}, ErrSessionDisconnected
	}
	return GoalAdapterResult{
		Observation: a.localGoal(adapterSession),
		Evidence:    map[string]any{"source": "claude_lifecycle_mirror", "confidence": "lifecycle_inferred"},
	}, nil
}

func (*ClaudeCodeSDKAdapter) NormalizeGoalObservation(raw map[string]any) map[string]any {
	return clonePayload(raw)
}

// applyGoalMirrorAndSend updates the local goal mirror and forwards the
// matching /goal command. The mirror is written before the send so the
// reader goroutine cannot observe the goal turn settling ahead of the mirror
// state, and rolled back when the send fails so the GUI never shows a goal
// state the CLI did not receive.
func (a *ClaudeCodeSDKAdapter) applyGoalMirrorAndSend(
	ctx context.Context,
	session Session,
	adapterSession *claudeSDKAdapterSession,
	goal map[string]any,
	command string,
	operationID string,
	revision int64,
	repairEpoch int64,
) error {
	previous := a.localGoal(adapterSession)
	a.applyLocalGoal(adapterSession, goal)
	if err := a.sendGoalCommandExec(ctx, session, adapterSession, command, operationID, revision, repairEpoch, previous); err != nil {
		a.restoreClaudeGoalMirrorIfCurrent(adapterSession, operationID, revision, repairEpoch, previous)
		return err
	}
	return nil
}

func (a *ClaudeCodeSDKAdapter) restoreClaudeGoalMirrorIfCurrent(
	adapterSession *claudeSDKAdapterSession,
	operationID string,
	revision int64,
	repairEpoch int64,
	previous map[string]any,
) {
	a.mu.Lock()
	defer a.mu.Unlock()
	operationID = strings.TrimSpace(operationID)
	if operationID != "" || revision > 0 {
		if adapterSession.goalOperationID != operationID || adapterSession.goalRevision != revision || adapterSession.goalRepairEpoch != repairEpoch {
			return
		}
	}
	adapterSession.liveState.goal = clonePayload(previous)
}

// cancelClaudeSDKGoalTurn fences one exact provider turn from a superseded
// repair epoch. The sidecar validates turnId before interrupting the query;
// terminal lifecycle remains provider-owned.
func (*ClaudeCodeSDKAdapter) cancelClaudeSDKGoalTurn(adapterSession *claudeSDKAdapterSession, session Session, turnID string, revision, repairEpoch int64) {
	turnID = strings.TrimSpace(turnID)
	if adapterSession == nil || turnID == "" {
		return
	}
	if err := adapterSession.send(claudeSDKSidecarRequest{
		ID: newID(), Type: "cancel",
		Payload: map[string]any{
			"agentSessionId":  session.AgentSessionID,
			"turnId":          turnID,
			"goalRevision":    revision,
			"goalRepairEpoch": repairEpoch,
		},
	}); err != nil {
		slog.Warn("agent session claude sdk precise goal interrupt failed",
			"event", "agent_session.claude_sdk.goal.precise_interrupt_failed",
			"agent_session_id", session.AgentSessionID,
			"turn_id", turnID,
			"goal_revision", revision,
			"goal_repair_epoch", repairEpoch,
			"error", err.Error(),
		)
	}
}

// ExecGoalControl forwards a typed "/goal …" prompt through the sidecar's
// native prompt queue while another turn holds the session's turn slot, so
// the command is not rejected by the single-turn gate. handled is false when
// the prompt is not a /goal command.
func (a *ClaudeCodeSDKAdapter) ExecGoalControl(
	ctx context.Context,
	session Session,
	content []PromptContentBlock,
	displayPrompt string,
) ([]activityshared.Event, bool, error) {
	explicitDisplayPrompt, visibleText := explicitAndVisiblePromptText(content, displayPrompt)
	command, _ := splitSlashCommand(visibleText)
	if command != appServerSlashGoal {
		return nil, false, nil
	}
	adapterSession := a.getSession(session.AgentSessionID)
	if adapterSession == nil {
		return nil, true, ErrSessionDisconnected
	}
	session.ProviderSessionID = adapterSession.providerSessionID
	// The command is a session-level control operation. Its transcript audit
	// message is deliberately turnless; any later model execution is adopted
	// as a separate provider-started Turn.
	events := []activityshared.Event{
		newSessionAuditEventWithID(session, newID(), RoleUser, visibleText, userPromptActivityPayload(content, explicitDisplayPrompt, userPromptActivityPayloadExtraFromExecMetadata(ctx, map[string]any{
			"adapter":     claudeSDKSidecarAdapterName,
			"goalControl": true,
		}))),
	}
	if event, ok := adapterSession.mirrorGoalSlashPrompt(session, visibleText); ok {
		events = append(events, event)
	}
	if err := a.sendGoalCommandExec(ctx, session, adapterSession, visibleText, "", 0, 0, nil); err != nil {
		return events, true, err
	}
	return events, true, nil
}

// isGoalClearCommandArgs recognizes Claude Code's reserved clear keywords.
func isGoalClearCommandArgs(args string) bool {
	switch strings.ToLower(strings.TrimSpace(args)) {
	case "clear", "reset":
		return true
	default:
		return false
	}
}

// liveClaudeSDKTurnIDs is the diagnostic live-waiter view used by lifecycle
// tests. Goal control never uses it to cancel an active Turn.
func (a *ClaudeCodeSDKAdapter) liveClaudeSDKTurnIDs(
	adapterSession *claudeSDKAdapterSession,
) []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	ids := make([]string, 0, len(adapterSession.turns))
	for turnID := range adapterSession.turns {
		if _, settled := adapterSession.settledTurns[turnID]; settled {
			continue
		}
		ids = append(ids, turnID)
	}
	sort.Strings(ids)
	return ids
}

// sendGoalCommandExec forwards a /goal command to the sidecar as its own
// exec. The sidecar queues it behind a live turn; its turn events come back
// without a waiter and flow through the session event sink with stamped
// lifecycle snapshots, so the session never strands mid-turn. A set command
// records its turn as the goal's arm turn so completion inference does not
// fire before the goal has actually started running.
func (a *ClaudeCodeSDKAdapter) sendGoalCommandExec(
	ctx context.Context,
	session Session,
	adapterSession *claudeSDKAdapterSession,
	command string,
	operationID string,
	revision int64,
	repairEpoch int64,
	previousGoal map[string]any,
) error {
	if err := a.startClaudeSDKReader(session.AgentSessionID, adapterSession); err != nil {
		return err
	}
	turnID := newID()
	args := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(command), appServerSlashGoal))
	isClear := isGoalClearCommandArgs(args)
	a.mu.Lock()
	previousArm := adapterSession.goalArmTurnID
	assignedArm := turnID
	if isClear {
		assignedArm = ""
		adapterSession.goalArmTurnID = assignedArm
		if adapterSession.goalClearControlTurns == nil {
			adapterSession.goalClearControlTurns = make(map[string]struct{})
		}
		adapterSession.goalClearControlTurns[turnID] = struct{}{}
	} else {
		adapterSession.goalArmTurnID = assignedArm
	}
	identity := goalOperationIdentity{
		operationID: strings.TrimSpace(operationID),
		revision:    revision,
		repairEpoch: repairEpoch,
	}
	if identity.valid() {
		if adapterSession.pendingGoalCommands == nil {
			adapterSession.pendingGoalCommands = make(map[string]claudeSDKPendingGoalCommand)
		}
		action := "set"
		if isClear {
			action = "clear"
		}
		adapterSession.pendingGoalCommands[turnID] = claudeSDKPendingGoalCommand{
			identity:     identity,
			action:       action,
			previousGoal: clonePayload(previousGoal),
		}
	}
	a.mu.Unlock()
	// The API context may carry no deadline; a missing sidecar ack must not
	// hang this goroutine forever.
	ctx, cancel := context.WithTimeout(ctx, claudeSDKGoalCommandTimeout)
	defer cancel()
	promptCorrelationID := newID()
	payload := map[string]any{
		"agentSessionId":      session.AgentSessionID,
		"turnId":              turnID,
		"promptCorrelationId": promptCorrelationID,
		"prompt":              command,
		"content":             promptContentForClaudeSDK(nil, command),
	}
	if !isGoalClearCommandArgs(args) {
		payload["turnOrigin"] = "goal_arm"
	}
	if strings.TrimSpace(operationID) != "" && revision > 0 {
		payload["goalOperationId"] = strings.TrimSpace(operationID)
		payload["goalRevision"] = revision
		payload["goalRepairEpoch"] = repairEpoch
		if isGoalClearCommandArgs(args) {
			payload["goalAction"] = "clear"
		} else {
			payload["goalAction"] = "set"
		}
	}
	err := a.roundTripClaudeSDK(ctx, session.AgentSessionID, adapterSession, claudeSDKSidecarRequest{
		ID:      newID(),
		Type:    "exec",
		Payload: payload,
	})
	if err != nil {
		a.restoreClaudeGoalArmIfCurrent(adapterSession, operationID, revision, repairEpoch, assignedArm, previousArm)
		if isClear {
			a.mu.Lock()
			delete(adapterSession.goalClearControlTurns, turnID)
			a.mu.Unlock()
		}
		a.forgetClaudeSDKPendingGoalCommand(adapterSession, turnID)
	}
	return err
}

// applyClaudeSDKGoalObservation consumes the sidecar's normalized projection
// of Claude active_goal messages and native goal_status attachments.
func (a *ClaudeCodeSDKAdapter) applyClaudeSDKGoalObservation(
	adapterSession *claudeSDKAdapterSession,
	payload map[string]any,
) string {
	updateType := strings.TrimSpace(payloadString(payload, "updateType"))
	switch updateType {
	case "thread_goal_cleared":
		a.mu.Lock()
		defer a.mu.Unlock()
		adapterSession.goalArmTurnID = ""
		adapterSession.liveState.goal = nil
		return updateType
	case "thread_goal_completed":
		a.mu.Lock()
		defer a.mu.Unlock()
		adapterSession.goalArmTurnID = ""
		if len(adapterSession.liveState.goal) == 0 {
			return ""
		}
		next := clonePayload(adapterSession.liveState.goal)
		next["status"] = "complete"
		delete(next, "reason")
		adapterSession.liveState.goal = next
		return "thread_goal_update"
	case "thread_goal_update":
		// Continue below and validate the normalized Goal payload.
	default:
		return ""
	}
	goal := payloadObject(payload["goal"])
	objective := strings.TrimSpace(asString(goal["objective"]))
	status := strings.TrimSpace(asString(goal["status"]))
	if objective == "" || status != "active" && status != "blocked" && status != "complete" {
		return ""
	}
	next := map[string]any{"objective": objective, "status": status}
	if reason := strings.TrimSpace(asString(goal["reason"])); reason != "" {
		next["reason"] = reason
	}
	for _, key := range []string{"startedAtUnixMs", "iterations", "durationMs", "tokens"} {
		if value, ok := firstInt64Value(goal, key); ok && value >= 0 {
			next[key] = value
		}
	}
	if sentinel, ok := goal["sentinel"].(bool); ok {
		next["sentinel"] = sentinel
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	adapterSession.goalArmTurnID = ""
	adapterSession.liveState.goal = normalizeClaudeGoalTiming(next, adapterSession.liveState.goal, time.Now().UnixMilli())
	return updateType
}

func normalizeClaudeGoalTiming(goal, previous map[string]any, occurredAt int64) map[string]any {
	if len(goal) == 0 {
		return nil
	}
	normalized := clonePayload(goal)
	startedAt, _ := firstInt64Value(normalized, "startedAtUnixMs")
	if startedAt <= 0 && strings.TrimSpace(asString(normalized["objective"])) == strings.TrimSpace(asString(previous["objective"])) {
		startedAt, _ = firstInt64Value(previous, "startedAtUnixMs")
	}
	if startedAt <= 0 {
		startedAt = occurredAt
	}
	normalized["startedAtUnixMs"] = startedAt
	status := strings.TrimSpace(asString(normalized["status"]))
	if status != "" && status != "active" {
		duration, _ := firstInt64Value(normalized, "durationMs")
		if duration <= 0 && occurredAt >= startedAt {
			normalized["durationMs"] = occurredAt - startedAt
		}
	}
	return normalized
}

// localGoal returns a copy of the adapter-local goal mirror.
func (a *ClaudeCodeSDKAdapter) localGoal(adapterSession *claudeSDKAdapterSession) map[string]any {
	a.mu.Lock()
	defer a.mu.Unlock()
	return clonePayload(adapterSession.liveState.goal)
}

func (a *ClaudeCodeSDKAdapter) applyLocalGoal(adapterSession *claudeSDKAdapterSession, goal map[string]any) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if len(goal) == 0 {
		adapterSession.liveState.goal = nil
		return
	}
	adapterSession.liveState.goal = normalizeClaudeGoalTiming(goal, adapterSession.liveState.goal, time.Now().UnixMilli())
}

func (*ClaudeCodeSDKAdapter) goalMirrorEvents(session Session, updateType string) []activityshared.Event {
	if event, ok := normalizedGoalUpdatedEvent(session, updateType); ok {
		return []activityshared.Event{event}
	}
	return nil
}
