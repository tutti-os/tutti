package agent

import (
	"context"
	"log/slog"
	"strings"
	"time"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
	reporterservice "github.com/tutti-os/tutti/services/tuttid/service/reporter"
	agentnoderesult "github.com/tutti-os/tutti/services/tuttid/service/reporter/events/agent/node_result"
)

type ActivityProjection struct {
	repo                   agentactivitybiz.Repository
	analyticsReporter      reporterservice.Reporter
	publisher              ActivityUpdatePublisher
	sessionMessageObserver SessionMessageObserver
	sessionStateObserver   SessionStateObserver
	goalReconcileInbox     GoalReconcileInboxWriter
	goalProvenanceLedger   GoalProvenanceLedgerStore
	agentTargetResolver    AgentTargetResolver
	rootTurnObserver       RootTurnObserver
}

var (
	_ SessionReader         = (*ActivityProjection)(nil)
	_ SessionSectionsReader = (*ActivityProjection)(nil)
)

func NewActivityProjection(repo agentactivitybiz.Repository) *ActivityProjection {
	return &ActivityProjection{repo: repo}
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
	ObserveAgentSessionState(context.Context, agentsessionstore.ReportSessionStateInput, agentsessionstore.ReportSessionStateReply)
}

type SessionMessageObserver interface {
	ObserveAgentSessionMessages(context.Context, agentsessionstore.ReportSessionMessagesInput, agentsessionstore.ReportSessionMessagesReply)
}

type RootTurnObserver interface {
	ObserveRootTurnSettled(context.Context, string, string, agentactivitybiz.Turn)
}

type GoalReconcileRequiredInput struct {
	WorkspaceID         string
	AgentSessionID      string
	RequestID           string
	ProviderTurnID      string
	Reason              string
	FenceMode           string
	ExpectedOperationID string
	ExpectedRevision    int64
	ExpectedRepairEpoch int64
	QuiesceSucceeded    bool
	QuiesceError        string
}

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

func (p *ActivityProjection) SetSessionStateObserver(observer SessionStateObserver) {
	if p == nil {
		return
	}
	p.sessionStateObserver = observer
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
	source agentsessionstore.EventSource,
) (string, agentsessionstore.EventSource, error) {
	normalizedSessionOrigin := agentsessionstore.NormalizeSessionOrigin(sessionOrigin)
	if normalizedSessionOrigin == "" {
		return "", agentsessionstore.EventSource{}, ErrInvalidArgument
	}
	sourceOrigin := strings.TrimSpace(source.SessionOrigin)
	if sourceOrigin == "" {
		source.SessionOrigin = normalizedSessionOrigin
		return normalizedSessionOrigin, source, nil
	}
	normalizedSourceOrigin := agentsessionstore.NormalizeSessionOrigin(sourceOrigin)
	if normalizedSourceOrigin == "" {
		return "", agentsessionstore.EventSource{}, ErrInvalidArgument
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
	input agentsessionstore.ReportSessionStateInput,
) (agentsessionstore.ReportSessionStateReply, error) {
	if p == nil || p.repo == nil {
		return agentsessionstore.ReportSessionStateReply{}, nil
	}
	sessionOrigin, source, err := normalizeReportSessionOrigins(input.SessionOrigin, input.Source)
	if err != nil {
		return agentsessionstore.ReportSessionStateReply{}, err
	}
	input.SessionOrigin = sessionOrigin
	input.Source = source
	canonicalTargetID, runtimeContext := p.canonicalizeAgentTargetID(
		ctx,
		firstNonEmptyString(input.State.AgentTargetID, input.Source.AgentTargetID),
		input.State.RuntimeContext,
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
		UserID:            strings.TrimSpace(input.Source.UserID),
		AgentTargetID:     canonicalTargetID,
		Provider:          strings.TrimSpace(firstNonEmptyString(input.State.Provider, input.Source.Provider)),
		ProviderSessionID: strings.TrimSpace(firstNonEmptyString(input.State.ProviderSessionID, input.Source.ProviderSessionID)),
		Model:             strings.TrimSpace(input.State.Model),
		Settings:          clonePayload(input.State.Settings),
		RuntimeContext:    clonePayload(runtimeContext),
		Cwd:               strings.TrimSpace(input.State.CWD),
		Title:             strings.TrimSpace(sessionStateTitle(input.State)),
		Status:            strings.TrimSpace(input.State.LifecycleStatus),
		CurrentPhase:      strings.TrimSpace(input.State.CurrentPhase),
		LastError:         strings.TrimSpace(input.State.LastError),
		OccurredAtUnixMS:  input.State.OccurredAtUnixMS,
		StartedAtUnixMS:   input.State.StartedAtUnixMS,
		EndedAtUnixMS:     input.State.EndedAtUnixMS,
		CreatedAtUnixMS:   input.Source.SessionCreatedAtUnixMS,
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
		return agentsessionstore.ReportSessionStateReply{}, err
	}
	activityReport.Interaction = interaction
	activityResult, err := p.repo.ReportActivityState(ctx, activityReport)
	if err != nil {
		return agentsessionstore.ReportSessionStateReply{}, err
	}
	result := activityResult.State
	reply := agentsessionstore.ReportSessionStateReply{
		Accepted:          result.Accepted,
		StateApplied:      result.StateApplied,
		LastEventAtUnixMS: result.LastEventUnixMS,
		RequestBodyBytes:  result.RequestBodyBytes,
	}
	p.publishPersistedTurnState(ctx, input, activityResult)
	if result.Accepted {
		p.publishActivityUpdated(
			ctx,
			input.WorkspaceID,
			input.AgentSessionID,
			"session_reconcile_required",
			activitySessionUpdateEventPayload(
				input.WorkspaceID,
				input.AgentSessionID,
				result.LastEventUnixMS,
				canonicalTargetID,
			),
		)
		if result.StateApplied {
			p.reportFailedRuntimeNodeResult(ctx, input)
		}
	}
	p.observeSessionState(ctx, input, reply)
	return reply, nil
}

func (p *ActivityProjection) reportFailedRuntimeNodeResult(ctx context.Context, input agentsessionstore.ReportSessionStateInput) {
	if p == nil || p.analyticsReporter == nil {
		return
	}
	if !isFailedAgentLifecycleStatus(input.State.LifecycleStatus) {
		return
	}
	errorMessage := strings.TrimSpace(input.State.LastError)
	if errorMessage == "" {
		errorMessage = "Agent runtime session failed."
	}
	agentnoderesult.Track(ctx, p.analyticsReporter, agentnoderesult.BuildParams(agentnoderesult.NodeResultInput{
		AgentSessionID: input.AgentSessionID,
		ErrorCode:      classifyRuntimeNodeErrorCode(errorMessage),
		ErrorMessage:   errorMessage,
		Flow:           "runtime_activity",
		Node:           "runtime_exec",
		Provider:       firstNonEmptyString(input.State.Provider, input.Source.Provider),
		Status:         "failure",
	}))
}

func sessionStateTitle(state agentsessionstore.WorkspaceAgentSessionStateUpdate) string {
	return firstNonEmptyString(
		state.Title,
		payloadString(state.RuntimeContext, "title"),
	)
}

func activitySessionUpdateEventPayload(workspaceID string, agentSessionID string, lastEventUnixMS int64, agentTargetID ...string) map[string]any {
	if lastEventUnixMS <= 0 {
		lastEventUnixMS = time.Now().UnixMilli()
	}
	payload := map[string]any{
		"agentSessionId":  strings.TrimSpace(agentSessionID),
		"eventType":       "session_reconcile_required",
		"lastEventUnixMs": lastEventUnixMS,
		"workspaceId":     strings.TrimSpace(workspaceID),
	}
	if len(agentTargetID) > 0 {
		if value := strings.TrimSpace(agentTargetID[0]); value != "" {
			payload["agentTargetId"] = value
		}
	}
	return payload
}

func activitySessionDeletedEventPayload(workspaceID string, agentSessionID string) map[string]any {
	return map[string]any{
		"agentSessionId":  strings.TrimSpace(agentSessionID),
		"deletedAtUnixMs": time.Now().UnixMilli(),
		"eventType":       "session_deleted",
		"workspaceId":     strings.TrimSpace(workspaceID),
	}
}

func isFailedAgentLifecycleStatus(status string) bool {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "failed", "failure", "error", "errored":
		return true
	default:
		return false
	}
}

func classifyRuntimeNodeErrorCode(message string) string {
	normalized := strings.ToLower(strings.TrimSpace(message))
	if strings.Contains(normalized, "network") ||
		strings.Contains(normalized, "connection") ||
		strings.Contains(normalized, "disconnected") ||
		strings.Contains(normalized, "econnreset") ||
		strings.Contains(normalized, "socket") {
		return agentnoderesult.ErrorCodeRuntimeNetworkDisconnected
	}
	if strings.Contains(normalized, "process") ||
		strings.Contains(normalized, "exit") ||
		strings.Contains(normalized, "exited") {
		return agentnoderesult.ErrorCodeRuntimeProcessExited
	}
	return agentnoderesult.ErrorCodeRuntimeExecFailed
}

func (p *ActivityProjection) ReportSessionMessages(
	ctx context.Context,
	input agentsessionstore.ReportSessionMessagesInput,
) (agentsessionstore.ReportSessionMessagesReply, error) {
	if p == nil || p.repo == nil {
		return agentsessionstore.ReportSessionMessagesReply{}, nil
	}
	sessionOrigin, source, err := normalizeReportSessionOrigins(input.SessionOrigin, input.Source)
	if err != nil {
		return agentsessionstore.ReportSessionMessagesReply{}, err
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
		return agentsessionstore.ReportSessionMessagesReply{}, err
	}
	if result.AcceptedCount > 0 {
		publishedAgentSessionID := canonicalMessageUpdateSessionID(input.AgentSessionID, result.Messages)
		for start := 0; start < len(result.Messages); {
			if strings.TrimSpace(result.Messages[start].Kind) == "session_audit" {
				p.publishActivityUpdated(ctx, input.WorkspaceID, publishedAgentSessionID, "session_audit", activitySessionAuditEventPayload(input.WorkspaceID, publishedAgentSessionID, result.Messages[start]))
				start++
				continue
			}
			end := start + 1
			for end < len(result.Messages) && strings.TrimSpace(result.Messages[end].Kind) != "session_audit" {
				end++
			}
			run := result.Messages[start:end]
			p.publishActivityUpdated(ctx, input.WorkspaceID, publishedAgentSessionID, "message_update", map[string]any{
				"acceptedCount": len(run), "agentSessionId": publishedAgentSessionID,
				"eventType": "message_update", "latestVersion": run[len(run)-1].Version,
				"messages": activityMessagesEventPayload(run), "workspaceId": strings.TrimSpace(input.WorkspaceID),
			})
			start = end
		}
	}
	reply := agentsessionstore.ReportSessionMessagesReply{
		AcceptedCount:    result.AcceptedCount,
		LatestVersion:    result.LatestVersion,
		RequestBodyBytes: result.RequestBodyBytes,
	}
	p.observeSessionMessages(ctx, input, reply)
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

func (p *ActivityProjection) SessionDeleted(ctx context.Context, workspaceID string, agentSessionID string) (bool, error) {
	if p == nil || p.repo == nil {
		return false, nil
	}
	return p.repo.SessionDeleted(ctx, workspaceID, agentSessionID)
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

func (p *ActivityProjection) DeleteSession(ctx context.Context, workspaceID string, agentSessionID string) (bool, error) {
	if p == nil || p.repo == nil {
		return false, nil
	}
	workspaceID = strings.TrimSpace(workspaceID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	removed, err := p.repo.DeleteSession(ctx, workspaceID, agentSessionID)
	if err != nil {
		return false, err
	}
	if removed {
		p.publishActivityUpdated(ctx, workspaceID, agentSessionID, "session_deleted", activitySessionDeletedEventPayload(workspaceID, agentSessionID))
	}
	return removed, nil
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
	for _, agentSessionID := range result.RemovedSessionIDs {
		agentSessionID = strings.TrimSpace(agentSessionID)
		if agentSessionID == "" {
			continue
		}
		p.publishActivityUpdated(ctx, input.WorkspaceID, agentSessionID, "session_deleted", activitySessionDeletedEventPayload(input.WorkspaceID, agentSessionID))
	}
	return result, nil
}

func (p *ActivityProjection) ClearSessions(ctx context.Context, workspaceID string) (ClearSessionsResult, error) {
	if p == nil || p.repo == nil {
		return ClearSessionsResult{}, nil
	}
	workspaceID = strings.TrimSpace(workspaceID)
	result, err := p.repo.ClearSessions(ctx, workspaceID)
	if err != nil {
		return ClearSessionsResult{}, err
	}
	for _, agentSessionID := range result.RemovedSessionIDs {
		agentSessionID = strings.TrimSpace(agentSessionID)
		if agentSessionID == "" {
			continue
		}
		p.publishActivityUpdated(ctx, workspaceID, agentSessionID, "session_deleted", activitySessionDeletedEventPayload(workspaceID, agentSessionID))
	}
	return ClearSessionsResult{
		RemovedMessages:   result.RemovedMessages,
		RemovedSessions:   result.RemovedSessions,
		RemovedSessionIDs: result.RemovedSessionIDs,
	}, nil
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
	persisted := persistedSessionFromActivity(session)
	p.publishActivityUpdated(ctx, workspaceID, agentSessionID, "session_reconcile_required", activitySessionUpdateEventPayload(workspaceID, agentSessionID, persisted.UpdatedAtUnixMS))
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
	persisted := persistedSessionFromActivity(session)
	p.publishActivityUpdated(ctx, workspaceID, agentSessionID, "session_reconcile_required", activitySessionUpdateEventPayload(workspaceID, agentSessionID, persisted.UpdatedAtUnixMS))
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
	persisted := persistedSessionFromActivity(session)
	p.publishActivityUpdated(ctx, workspaceID, agentSessionID, "session_reconcile_required", activitySessionUpdateEventPayload(workspaceID, agentSessionID, persisted.UpdatedAtUnixMS))
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
