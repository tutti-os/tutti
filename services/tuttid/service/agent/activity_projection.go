package agent

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	replay "github.com/tutti-os/tutti/packages/agent/session-replay"
	agentactivitybiz "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
	reporterservice "github.com/tutti-os/tutti/services/tuttid/service/reporter"
)

type ActivityProjection struct {
	repo                         agentactivitybiz.Repository
	analyticsReporter            reporterservice.Reporter
	publisher                    ActivityUpdatePublisher
	sessionMessageObserver       SessionMessageObserver
	sessionStateObserver         SessionStateObserver
	goalReconcileInbox           GoalReconcileInboxWriter
	goalProvenanceLedger         GoalProvenanceLedgerStore
	agentTargetResolver          AgentTargetResolver
	workspaceAgentTargetResolver WorkspaceAgentTargetResolver
	rootTurnObserver             RootTurnObserver
	turnForkabilityResolver      TurnForkabilityResolver
	replayCommitObserver         ReplayCommitObserver
	terminalFailureObserver      agenthost.TerminalFailureObserver
	terminalAnalyticsOwner       string
	terminalAnalyticsWake        chan struct{}
	terminalAnalyticsDrainMu     sync.Mutex
	// rootTurnSettleStateObserver is the dedicated, opt-in consumer list for
	// synthesized canonical root-turn settlement states. It is deliberately
	// separate from sessionStateObserver: the general observers historically
	// never received live turn settles (root-provider-lifecycle adapters do
	// not report settled state patches), and each one needs its own semantic
	// review before opting in (see W4③-11).
	rootTurnSettleStateObserver SessionStateObserver
}

var (
	_ SessionReader         = (*ActivityProjection)(nil)
	_ SessionPageReader     = (*ActivityProjection)(nil)
	_ SessionSectionsReader = (*ActivityProjection)(nil)
)

func NewActivityProjection(repo agentactivitybiz.Repository) *ActivityProjection {
	return &ActivityProjection{
		repo:                   repo,
		terminalAnalyticsOwner: uuid.NewString(),
		terminalAnalyticsWake:  make(chan struct{}, 1),
	}
}

type ActivityUpdatePublisher interface {
	PublishAgentActivityUpdated(
		context.Context,
		string,
		string,
		string,
		map[string]any,
	) error
}

type SessionStateObserver interface {
	ObserveAgentSessionState(context.Context, canonical.ReportSessionStateInput, canonical.ReportSessionStateReply)
}

type RootTurnSettlementPolicy string

const (
	RootTurnSettlementsObserve RootTurnSettlementPolicy = "observe"
	RootTurnSettlementsIgnore  RootTurnSettlementPolicy = "ignore"
)

// SessionStateObserverRegistration forces production composition to make an
// explicit decision about canonical root-turn settlements for every legacy
// session-state observer.
type SessionStateObserverRegistration struct {
	Observer            SessionStateObserver
	RootTurnSettlements RootTurnSettlementPolicy
}

type SessionMessageObserver interface {
	ObserveAgentSessionMessages(context.Context, canonical.ReportSessionMessagesInput, canonical.ReportSessionMessagesReply)
}

type RootTurnObserver interface {
	ObserveRootTurnSettled(context.Context, string, string, agentactivitybiz.Turn)
}

type TurnForkabilityResolver interface {
	CanForkSessionTurn(
		context.Context,
		agenthost.SessionTurnForkabilityInput,
	) (bool, error)
}

func (p *ActivityProjection) SetTurnForkabilityResolver(
	resolver TurnForkabilityResolver,
) {
	if p != nil {
		p.turnForkabilityResolver = resolver
	}
}

type GoalReconcileRequiredInput = agenthost.GoalReconcileRequiredInput

type GoalReconcileInboxWriter interface {
	PutGoalReconcileInbox(context.Context, agentactivitybiz.GoalReconcileInboxItem) (bool, error)
}

type GoalProvenanceLedgerStore interface {
	BindGoalProvenance(context.Context, agentactivitybiz.BindGoalProvenanceInput) (agentactivitybiz.GoalProvenanceBinding, error)
	LookupGoalProvenance(context.Context, agentactivitybiz.LookupGoalProvenanceInput) (agentactivitybiz.GoalProvenanceBinding, bool, error)
}

func (p *ActivityProjection) SetPublisher(publisher ActivityUpdatePublisher) {
	if p == nil {
		return
	}
	p.publisher = publisher
}

func (p *ActivityProjection) SetAnalyticsReporter(reporter reporterservice.Reporter) {
	if p == nil {
		return
	}
	p.analyticsReporter = reporter
}

func (p *ActivityProjection) SetSessionMessageObserver(observer SessionMessageObserver) {
	if p == nil {
		return
	}
	p.sessionMessageObserver = observer
}

func (p *ActivityProjection) ConfigureSessionStateObservers(registrations ...SessionStateObserverRegistration) error {
	if p == nil {
		return errors.New("activity projection is unavailable")
	}
	all := make(SessionStateObservers, 0, len(registrations))
	rootSettlements := make(SessionStateObservers, 0, len(registrations))
	for index, registration := range registrations {
		if registration.Observer == nil {
			return fmt.Errorf("session state observer %d is unavailable", index)
		}
		switch registration.RootTurnSettlements {
		case RootTurnSettlementsObserve:
			rootSettlements = append(rootSettlements, registration.Observer)
		case RootTurnSettlementsIgnore:
		default:
			return fmt.Errorf("session state observer %d has no root-turn settlement policy", index)
		}
		all = append(all, registration.Observer)
	}
	p.sessionStateObserver = all
	p.rootTurnSettleStateObserver = rootSettlements
	return nil
}

func (p *ActivityProjection) SetRootTurnObserver(observer RootTurnObserver) {
	if p == nil {
		return
	}
	p.rootTurnObserver = observer
}

func (p *ActivityProjection) SetGoalReconcileInboxWriter(store GoalReconcileInboxWriter) {
	if p != nil {
		p.goalReconcileInbox = store
	}
}

func (p *ActivityProjection) SetGoalProvenanceLedger(store GoalProvenanceLedgerStore) {
	if p != nil {
		p.goalProvenanceLedger = store
	}
}

func (p *ActivityProjection) BindGoalProvenance(ctx context.Context, input agentsessionstore.BindGoalProvenanceInput) (agentsessionstore.GoalProvenanceBinding, error) {
	if p == nil || p.goalProvenanceLedger == nil {
		return agentsessionstore.GoalProvenanceBinding{}, ErrInvalidArgument
	}
	binding, err := p.goalProvenanceLedger.BindGoalProvenance(ctx, agentactivitybiz.BindGoalProvenanceInput{
		WorkspaceID: input.WorkspaceID, AgentSessionID: input.AgentSessionID,
		SessionCreatedAtUnixMS: input.SessionCreatedAtUnixMS,
		ProviderSessionID:      input.ProviderSessionID, Fingerprint: input.Fingerprint,
		OperationID: input.OperationID, Revision: input.Revision, RepairEpoch: input.RepairEpoch,
		OccurredAtUnixMS: input.OccurredAtUnixMS,
	})
	return activityGoalProvenanceBinding(binding), err
}

func (p *ActivityProjection) LookupGoalProvenance(ctx context.Context, input agentsessionstore.LookupGoalProvenanceInput) (agentsessionstore.GoalProvenanceBinding, bool, error) {
	if p == nil || p.goalProvenanceLedger == nil {
		return agentsessionstore.GoalProvenanceBinding{}, false, ErrInvalidArgument
	}
	binding, found, err := p.goalProvenanceLedger.LookupGoalProvenance(ctx, agentactivitybiz.LookupGoalProvenanceInput{
		WorkspaceID: input.WorkspaceID, AgentSessionID: input.AgentSessionID,
		SessionCreatedAtUnixMS: input.SessionCreatedAtUnixMS,
		ProviderSessionID:      input.ProviderSessionID, Fingerprint: input.Fingerprint,
	})
	return activityGoalProvenanceBinding(binding), found, err
}

func activityGoalProvenanceBinding(binding agentactivitybiz.GoalProvenanceBinding) agentsessionstore.GoalProvenanceBinding {
	return agentsessionstore.GoalProvenanceBinding{
		WorkspaceID: binding.WorkspaceID, AgentSessionID: binding.AgentSessionID,
		SessionCreatedAtUnixMS: binding.SessionCreatedAtUnixMS,
		ProviderSessionID:      binding.ProviderSessionID, Fingerprint: binding.Fingerprint,
		OperationID: binding.OperationID, Revision: binding.Revision, RepairEpoch: binding.RepairEpoch,
		Ambiguous: binding.Ambiguous, CreatedAtUnixMS: binding.CreatedAtUnixMS, UpdatedAtUnixMS: binding.UpdatedAtUnixMS,
	}
}

func normalizeReportSessionOrigins(
	sessionOrigin string,
	source canonical.EventSource,
) (string, canonical.EventSource, error) {
	normalizedSessionOrigin := agentsessionstore.NormalizeSessionOrigin(sessionOrigin)
	if normalizedSessionOrigin == "" {
		return "", canonical.EventSource{}, ErrInvalidArgument
	}
	sourceOrigin := strings.TrimSpace(source.SessionOrigin)
	if sourceOrigin == "" {
		source.SessionOrigin = normalizedSessionOrigin
		return normalizedSessionOrigin, source, nil
	}
	normalizedSourceOrigin := agentsessionstore.NormalizeSessionOrigin(sourceOrigin)
	if normalizedSourceOrigin == "" {
		return "", canonical.EventSource{}, ErrInvalidArgument
	}
	source.SessionOrigin = normalizedSourceOrigin
	return normalizedSessionOrigin, source, nil
}

func (p *ActivityProjection) Report(ctx context.Context, input agentsessionstore.ReportActivityInput) error {
	if p == nil || p.repo == nil {
		return nil
	}
	sourceOrigin := agentsessionstore.NormalizeSessionOrigin(input.Source.SessionOrigin)
	if sourceOrigin == "" {
		return ErrInvalidArgument
	}
	input.Source.SessionOrigin = sourceOrigin
	_, err := agentsessionstore.ReportActivityAsSessionUpdates(ctx, p, input)
	return err
}

func (p *ActivityProjection) ReportSessionState(
	ctx context.Context,
	input canonical.ReportSessionStateInput,
) (canonical.ReportSessionStateReply, error) {
	return p.reportSessionState(ctx, input, true, replay.ProviderObservationCommitContext{})
}

func (p *ActivityProjection) ReportSessionStateWithCommitContext(
	ctx context.Context,
	input canonical.ReportSessionStateInput,
	replayContext replay.ProviderObservationCommitContext,
) (canonical.ReportSessionStateReply, error) {
	if err := replay.ValidateProviderObservationCommitContext(
		replayContext,
	); err != nil {
		return canonical.ReportSessionStateReply{}, err
	}
	return p.reportSessionState(ctx, input, true, replayContext)
}

func (p *ActivityProjection) reportSessionState(
	ctx context.Context,
	input canonical.ReportSessionStateInput,
	notify bool,
	replayContext replay.ProviderObservationCommitContext,
) (canonical.ReportSessionStateReply, error) {
	if p == nil || p.repo == nil {
		return canonical.ReportSessionStateReply{}, nil
	}
	sessionOrigin, source, err := normalizeReportSessionOrigins(input.SessionOrigin, input.Source)
	if err != nil {
		return canonical.ReportSessionStateReply{}, err
	}
	input.SessionOrigin = sessionOrigin
	input.Source = source
	canonicalTargetID, runtimeContext, runtimeContextPatch := p.canonicalizeAgentTargetState(
		ctx,
		input.WorkspaceID,
		firstNonEmptyString(input.State.AgentTargetID, input.Source.AgentTargetID),
		input.State.RuntimeContext,
		input.State.RuntimeContextPatch,
	)
	stateReport := agentactivitybiz.SessionStateReport{
		WorkspaceID:          strings.TrimSpace(input.WorkspaceID),
		AgentSessionID:       strings.TrimSpace(input.AgentSessionID),
		Kind:                 strings.TrimSpace(input.State.Kind),
		RootAgentSessionID:   strings.TrimSpace(input.State.RootAgentSessionID),
		RootTurnID:           strings.TrimSpace(input.State.RootTurnID),
		ParentAgentSessionID: strings.TrimSpace(input.State.ParentAgentSessionID),
		ParentTurnID:         strings.TrimSpace(input.State.ParentTurnID),
		ParentToolCallID:     strings.TrimSpace(input.State.ParentToolCallID),
		Origin:               strings.TrimSpace(input.SessionOrigin),
		// Tutti local workspaces intentionally leave Source.UserID empty. Cloud
		// collaboration hosts may provide real account user ids on this wire.
		UserID:              strings.TrimSpace(input.Source.UserID),
		AgentTargetID:       canonicalTargetID,
		Provider:            strings.TrimSpace(firstNonEmptyString(input.State.Provider, input.Source.Provider)),
		ProviderSessionID:   strings.TrimSpace(firstNonEmptyString(input.State.ProviderSessionID, input.Source.ProviderSessionID)),
		Model:               strings.TrimSpace(input.State.Model),
		Settings:            clonePayload(input.State.Settings),
		Capabilities:        canonical.CloneCapabilitySnapshot(input.State.Capabilities),
		RuntimeContext:      cloneOptionalPayload(runtimeContext),
		RuntimeContextPatch: canonical.CloneRuntimeContextPatch(runtimeContextPatch),
		Cwd:                 strings.TrimSpace(input.State.CWD),
		RailPlacement:       canonicalRailSection(input.State.RailPlacement),
		Title:               strings.TrimSpace(sessionStateTitle(input.State)),
		Status:              strings.TrimSpace(input.State.LifecycleStatus),
		CurrentPhase:        strings.TrimSpace(input.State.CurrentPhase),
		LastError:           strings.TrimSpace(input.State.LastError),
		OccurredAtUnixMS:    input.State.OccurredAtUnixMS,
		StartedAtUnixMS:     input.State.StartedAtUnixMS,
		EndedAtUnixMS:       input.State.EndedAtUnixMS,
		CreatedAtUnixMS:     input.Source.SessionCreatedAtUnixMS,
	}
	activityReport := agentactivitybiz.ActivityStateReport{Session: stateReport}
	if transition, ok := turnTransitionFromStateInput(input); ok {
		activityReport.Turn = &transition
	}
	if transition, ok := rootProviderTurnTransitionFromStateInput(input); ok {
		activityReport.RootProviderTurn = &transition
	}
	interaction, err := interactionTransitionFromStateInput(input)
	if err != nil {
		return canonical.ReportSessionStateReply{}, err
	}
	activityReport.Interaction = interaction
	activityResult, err := p.repo.ReportActivityState(ctx, activityReport)
	if err != nil {
		return canonical.ReportSessionStateReply{}, err
	}
	result := activityResult.State
	reply := canonical.ReportSessionStateReply{
		Accepted:          result.Accepted,
		StateApplied:      result.StateApplied,
		LastEventAtUnixMS: result.LastEventUnixMS,
		RequestBodyBytes:  result.RequestBodyBytes,
	}
	if notify {
		delta := agenthost.ActivityStateDelta(input, reply, activityResult)
		p.observeCommittedOutsideHost(ctx, delta)
		p.notifyReplayCommitted(ctx, delta, replayContext)
	}
	return reply, nil
}

func (p *ActivityProjection) ReportSessionMessages(
	ctx context.Context,
	input canonical.ReportSessionMessagesInput,
) (canonical.ReportSessionMessagesReply, error) {
	return p.reportSessionMessages(ctx, input, replay.ProviderObservationCommitContext{})
}

func (p *ActivityProjection) ReportSessionMessagesWithCommitContext(
	ctx context.Context,
	input canonical.ReportSessionMessagesInput,
	replayContext replay.ProviderObservationCommitContext,
) (canonical.ReportSessionMessagesReply, error) {
	if err := replay.ValidateProviderObservationCommitContext(
		replayContext,
	); err != nil {
		return canonical.ReportSessionMessagesReply{}, err
	}
	return p.reportSessionMessages(ctx, input, replayContext)
}

func (p *ActivityProjection) reportSessionMessages(
	ctx context.Context,
	input canonical.ReportSessionMessagesInput,
	replayContext replay.ProviderObservationCommitContext,
) (canonical.ReportSessionMessagesReply, error) {
	if p == nil || p.repo == nil {
		return canonical.ReportSessionMessagesReply{}, nil
	}
	sessionOrigin, source, err := normalizeReportSessionOrigins(input.SessionOrigin, input.Source)
	if err != nil {
		return canonical.ReportSessionMessagesReply{}, err
	}
	input.SessionOrigin = sessionOrigin
	input.Source = source
	result, err := p.repo.ReportSessionMessages(ctx, agentactivitybiz.SessionMessageReport{
		WorkspaceID:    strings.TrimSpace(input.WorkspaceID),
		AgentSessionID: strings.TrimSpace(input.AgentSessionID),
		Origin:         strings.TrimSpace(input.SessionOrigin),
		Provider:       strings.TrimSpace(input.Source.Provider),
		Messages:       activityMessageUpdates(input.Updates),
	})
	if err != nil {
		return canonical.ReportSessionMessagesReply{}, err
	}
	reply := canonical.ReportSessionMessagesReply{
		AcceptedCount:    result.AcceptedCount,
		LatestVersion:    result.LatestVersion,
		RequestBodyBytes: result.RequestBodyBytes,
	}
	delta := agenthost.SessionMessagesDelta(input, reply, result)
	if delta.SessionMessages != nil {
		// A message report carries no session state, so terminal-failure identity
		// for failed tool calls has to come from the canonical session.
		provider, isChildSession := p.sessionTerminalFailureIdentity(
			ctx, input.WorkspaceID, canonicalMessageUpdateSessionID(input.AgentSessionID, result.Messages),
		)
		delta.SessionMessages.Provider = strings.TrimSpace(firstNonEmptyString(provider, delta.SessionMessages.Provider))
		delta.SessionMessages.IsChildSession = isChildSession
	}
	p.observeCommittedOutsideHost(ctx, delta)
	p.notifyReplayCommitted(ctx, delta, replayContext)
	return reply, nil
}

func (p *ActivityProjection) ReportGoalReconcileRequired(ctx context.Context, input agentsessionstore.ReportGoalReconcileRequiredInput) (agentsessionstore.ReportGoalReconcileRequiredReply, error) {
	request := input.Request
	if p == nil || p.goalReconcileInbox == nil || strings.TrimSpace(input.WorkspaceID) == "" ||
		strings.TrimSpace(request.AgentSessionID) == "" || strings.TrimSpace(request.RequestID) == "" {
		return agentsessionstore.ReportGoalReconcileRequiredReply{}, ErrInvalidArgument
	}
	now := time.Now().UTC().UnixMilli()
	_, err := p.goalReconcileInbox.PutGoalReconcileInbox(ctx, agentactivitybiz.GoalReconcileInboxItem{
		RequestID: strings.TrimSpace(request.RequestID), WorkspaceID: strings.TrimSpace(input.WorkspaceID),
		AgentSessionID: strings.TrimSpace(request.AgentSessionID), CreatedAtUnixMS: now,
		Payload: map[string]any{
			"phase":          strings.TrimSpace(request.Phase),
			"providerTurnId": strings.TrimSpace(request.ProviderTurnID), "reason": strings.TrimSpace(request.Reason),
			"fenceMode": strings.TrimSpace(request.FenceMode), "expectedOperationId": strings.TrimSpace(request.ExpectedOperationID),
			"expectedRevision": request.ExpectedRevision, "expectedRepairEpoch": request.ExpectedRepairEpoch,
			"quiesceSucceeded": request.QuiesceSucceeded, "quiesceError": strings.TrimSpace(request.QuiesceError),
		},
	})
	if err != nil {
		return agentsessionstore.ReportGoalReconcileRequiredReply{}, err
	}
	return agentsessionstore.ReportGoalReconcileRequiredReply{Accepted: true}, nil
}

func activitySessionAuditEventPayload(workspaceID, agentSessionID string, audit agentactivitybiz.Message) map[string]any {
	payload := clonePayload(audit.Payload)
	if payload == nil {
		payload = map[string]any{}
	}
	return map[string]any{
		"workspaceId": strings.TrimSpace(workspaceID), "agentSessionId": strings.TrimSpace(agentSessionID),
		"eventType": "session_audit", "audit": map[string]any{
			"auditId": strings.TrimSpace(audit.MessageID), "role": strings.TrimSpace(audit.Role),
			"payload": payload, "occurredAtUnixMs": audit.OccurredAtUnixMS, "version": audit.Version,
		},
	}
}

func (p *ActivityProjection) PublishGoalControlAudit(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
	audit agentactivitybiz.Message,
) {
	if strings.TrimSpace(audit.Kind) != "session_audit" || strings.TrimSpace(audit.TurnID) != "" {
		return
	}
	p.publishActivityUpdated(
		ctx,
		workspaceID,
		agentSessionID,
		"session_audit",
		activitySessionAuditEventPayload(workspaceID, agentSessionID, audit),
	)
}

func canonicalMessageUpdateSessionID(fallback string, messages []agentactivitybiz.Message) string {
	for _, message := range messages {
		if agentSessionID := strings.TrimSpace(message.AgentSessionID); agentSessionID != "" {
			return agentSessionID
		}
	}
	return strings.TrimSpace(fallback)
}

func (p *ActivityProjection) GetSession(workspaceID string, agentSessionID string) (PersistedSession, bool) {
	if p == nil || p.repo == nil {
		return PersistedSession{}, false
	}
	session, ok, err := p.repo.GetSession(context.Background(), workspaceID, agentSessionID)
	if err != nil {
		slog.Warn("read workspace agent session failed",
			"event", "workspace.agent_session.read_failed",
			"workspace_id", workspaceID,
			"agent_session_id", agentSessionID,
			"error", err,
		)
		return PersistedSession{}, false
	}
	if !ok {
		return PersistedSession{}, false
	}
	return p.projectPersistedSession(context.Background(), persistedSessionFromActivity(session)), true
}

func (p *ActivityProjection) ListSessions(workspaceID string) ([]PersistedSession, bool) {
	if p == nil || p.repo == nil {
		return nil, false
	}
	sessions, ok, err := p.repo.ListSessions(context.Background(), workspaceID)
	if err != nil {
		slog.Warn("list workspace agent sessions failed",
			"event", "workspace.agent_session.list_failed",
			"workspace_id", workspaceID,
			"error", err,
		)
		return nil, false
	}
	if !ok {
		return nil, false
	}
	out := make([]PersistedSession, 0, len(sessions))
	ctx := context.Background()
	for _, session := range sessions {
		out = append(out, p.projectPersistedSession(ctx, persistedSessionFromActivity(session)))
	}
	return out, true
}

func (p *ActivityProjection) ListSessionsPage(
	ctx context.Context,
	input agentactivitybiz.ListSessionsPageInput,
) (PersistedSessionListPage, bool, error) {
	if p == nil || p.repo == nil {
		return PersistedSessionListPage{}, false, nil
	}
	page, ok, err := p.repo.ListSessionsPage(ctx, input)
	if err != nil || !ok {
		return PersistedSessionListPage{}, ok, err
	}
	sessions := make([]PersistedSession, 0, len(page.Sessions))
	for _, session := range page.Sessions {
		sessions = append(sessions, p.projectPersistedSession(ctx, persistedSessionFromActivity(session)))
	}
	return PersistedSessionListPage{
		Sessions:   sessions,
		HasMore:    page.HasMore,
		NextCursor: page.NextCursor,
	}, true, nil
}

func (p *ActivityProjection) ListChildSessions(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
) ([]PersistedSession, error) {
	if p == nil || p.repo == nil {
		return []PersistedSession{}, nil
	}
	sessions, err := p.repo.ListChildSessions(ctx, workspaceID, agentSessionID)
	if err != nil {
		return nil, err
	}
	out := make([]PersistedSession, 0, len(sessions))
	for _, session := range sessions {
		out = append(out, p.projectPersistedSession(ctx, persistedSessionFromActivity(session)))
	}
	return out, nil
}

func (p *ActivityProjection) ListSessionSection(
	ctx context.Context,
	input agentactivitybiz.ListSessionSectionInput,
) (agentactivitybiz.SessionSectionPage, bool, error) {
	if p == nil || p.repo == nil {
		return agentactivitybiz.SessionSectionPage{}, false, nil
	}
	return p.repo.ListSessionSection(ctx, input)
}

func (p *ActivityProjection) ListSessionSections(
	ctx context.Context,
	input agentactivitybiz.ListSessionSectionsInput,
) (agentactivitybiz.SessionSectionsPage, bool, error) {
	if p == nil || p.repo == nil {
		return agentactivitybiz.SessionSectionsPage{}, false, nil
	}
	return p.repo.ListSessionSections(ctx, input)
}

func (p *ActivityProjection) RollbackRuntimeSessionInitialization(ctx context.Context, workspaceID string, agentSessionID string) (bool, error) {
	if p == nil || p.repo == nil {
		return false, nil
	}
	rollbacker, ok := p.repo.(interface {
		RollbackRuntimeSessionInitialization(context.Context, string, string) (bool, error)
	})
	if !ok {
		return false, fmt.Errorf("agent activity repository cannot roll back runtime session initialization")
	}
	return rollbacker.RollbackRuntimeSessionInitialization(ctx, strings.TrimSpace(workspaceID), strings.TrimSpace(agentSessionID))
}

func (p *ActivityProjection) ListSessionSectionDeletionCandidates(
	ctx context.Context,
	input agentactivitybiz.ListSessionSectionDeletionCandidatesInput,
) (agentactivitybiz.SessionSectionDeletionCandidates, bool) {
	if p == nil || p.repo == nil {
		return agentactivitybiz.SessionSectionDeletionCandidates{}, false
	}
	candidates, ok, err := p.repo.ListSessionSectionDeletionCandidates(ctx, input)
	if err != nil {
		slog.Warn("list workspace agent session section deletion candidates failed",
			"event", "workspace.agent_session.section.deletion_candidates_failed",
			"workspace_id", input.WorkspaceID,
			"section_key", input.SectionKey,
			"error", err,
		)
		return agentactivitybiz.SessionSectionDeletionCandidates{}, false
	}
	return candidates, ok
}

func (p *ActivityProjection) DeleteSessionsBatch(
	ctx context.Context,
	input agentactivitybiz.DeleteSessionsBatchInput,
) (agentactivitybiz.DeleteSessionsBatchResult, error) {
	if p == nil || p.repo == nil {
		return agentactivitybiz.DeleteSessionsBatchResult{}, nil
	}
	result, err := p.repo.DeleteSessionsBatch(ctx, input)
	if err != nil {
		slog.Warn("delete workspace agent sessions batch failed",
			"event", "workspace.agent_session.batch_delete_failed",
			"workspace_id", input.WorkspaceID,
			"error", err,
		)
		return agentactivitybiz.DeleteSessionsBatchResult{}, err
	}
	if result.RemovedSessions > 0 {
		agenthost.NotifyCommitted(ctx, p, agenthost.CanonicalDelta(result.CommitDelta))
	}
	return result, nil
}

func (p *ActivityProjection) PlanDeleteSessions(
	ctx context.Context,
	input agentactivitybiz.DeleteSessionsBatchInput,
) (agentactivitybiz.DeleteSessionsPlan, error) {
	if p == nil || p.repo == nil {
		return agentactivitybiz.DeleteSessionsPlan{}, nil
	}
	return p.repo.PlanDeleteSessions(ctx, input)
}

func (p *ActivityProjection) PlanClearSessions(ctx context.Context, workspaceID string) (agentactivitybiz.DeleteSessionsPlan, error) {
	if p == nil || p.repo == nil {
		return agentactivitybiz.DeleteSessionsPlan{}, nil
	}
	return p.repo.PlanClearSessions(ctx, strings.TrimSpace(workspaceID))
}

func (p *ActivityProjection) UpdateSessionPinned(ctx context.Context, workspaceID string, agentSessionID string, pinned bool) (PersistedSession, bool, error) {
	if p == nil || p.repo == nil {
		return PersistedSession{}, false, nil
	}
	workspaceID = strings.TrimSpace(workspaceID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	session, ok, err := p.repo.UpdateSessionPinned(ctx, workspaceID, agentSessionID, pinned)
	if err != nil {
		return PersistedSession{}, false, err
	}
	if !ok {
		return PersistedSession{}, false, nil
	}
	agenthost.NotifyCommitted(ctx, p, agenthost.CanonicalDelta(session.CommitDelta))
	persisted := persistedSessionFromActivity(session)
	return persisted, true, nil
}

func (p *ActivityProjection) UpdateSessionSettings(ctx context.Context, workspaceID string, agentSessionID string, settings ComposerSettings) (PersistedSession, bool, error) {
	if p == nil || p.repo == nil {
		return PersistedSession{}, false, nil
	}
	workspaceID = strings.TrimSpace(workspaceID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	session, ok, err := p.repo.UpdateSessionSettings(
		ctx,
		workspaceID,
		agentSessionID,
		settings.Model,
		ComposerSettingsToMap(settings),
	)
	if err != nil {
		return PersistedSession{}, false, err
	}
	if !ok {
		return PersistedSession{}, false, nil
	}
	agenthost.NotifyCommitted(ctx, p, agenthost.CanonicalDelta(session.CommitDelta))
	persisted := persistedSessionFromActivity(session)
	return persisted, true, nil
}

func (p *ActivityProjection) UpdateSessionTitle(ctx context.Context, workspaceID string, agentSessionID string, title string) (PersistedSession, bool, error) {
	if p == nil || p.repo == nil {
		return PersistedSession{}, false, nil
	}
	workspaceID = strings.TrimSpace(workspaceID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	session, ok, err := p.repo.UpdateSessionTitle(ctx, workspaceID, agentSessionID, strings.TrimSpace(title))
	if err != nil {
		return PersistedSession{}, false, err
	}
	if !ok {
		return PersistedSession{}, false, nil
	}
	agenthost.NotifyCommitted(ctx, p, agenthost.CanonicalDelta(session.CommitDelta))
	persisted := persistedSessionFromActivity(session)
	return persisted, true, nil
}

func (p *ActivityProjection) ListSessionMessages(
	input agentactivitybiz.ListSessionMessagesInput,
) (SessionMessagesPage, bool) {
	if p == nil || p.repo == nil {
		return SessionMessagesPage{}, false
	}
	page, ok, err := p.repo.ListSessionMessages(context.Background(), input)
	if err != nil {
		slog.Warn("list workspace agent session messages failed",
			"event", "workspace.agent_session.messages.list_failed",
			"workspace_id", input.WorkspaceID,
			"agent_session_id", input.AgentSessionID,
			"after_version", input.AfterVersion,
			"before_version", input.BeforeVersion,
			"order", input.Order,
			"limit", input.Limit,
			"error", err,
		)
		return SessionMessagesPage{}, false
	}
	if !ok {
		return SessionMessagesPage{}, false
	}
	return SessionMessagesPage{
		AgentSessionID: page.AgentSessionID,
		Messages:       sessionMessagesFromActivity(page.Messages),
		LatestVersion:  page.LatestVersion,
		HasMore:        page.HasMore,
	}, true
}

func (p *ActivityProjection) ListWorkspaceGeneratedFileTurns(
	ctx context.Context,
	input agentactivitybiz.ListWorkspaceGeneratedFileTurnsInput,
) (agentactivitybiz.GeneratedFileTurnList, bool) {
	if p == nil || p.repo == nil {
		return agentactivitybiz.GeneratedFileTurnList{}, false
	}
	list, ok, err := p.repo.ListWorkspaceGeneratedFileTurns(ctx, input)
	if err != nil {
		slog.Warn("list workspace agent generated file turns failed",
			"event", "workspace.agent_generated_files.list_failed",
			"workspace_id", input.WorkspaceID,
			"error", err,
		)
		return agentactivitybiz.GeneratedFileTurnList{}, false
	}
	if !ok {
		return agentactivitybiz.GeneratedFileTurnList{}, false
	}
	return list, true
}
