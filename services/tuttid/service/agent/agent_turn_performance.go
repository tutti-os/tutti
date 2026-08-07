package agent

import (
	"context"
	"sort"
	"strings"
	"sync"
	"time"

	agentactivitybiz "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	reporterservice "github.com/tutti-os/tutti/services/tuttid/service/reporter"
	turnperformance "github.com/tutti-os/tutti/services/tuttid/service/reporter/events/agent/turn_performance"
)

const (
	agentTurnLongIdleThresholdMS        int64 = 10_000
	agentTurnPerformanceStateTTL              = 6 * time.Hour
	agentTurnPerformancePruneInterval         = time.Minute
	agentTurnPerformanceStateMaxEntries       = 4_096
)

type agentTurnPerformanceProvenance struct {
	clientSubmittedAtUnixMS  int64
	model                    string
	provider                 string
	recordedAt               time.Time
	runtimeIdentityAvailable bool
	sessionState             string
	wasQueued                *bool
}

type agentTurnPerformanceState struct {
	mu           sync.Mutex
	lastPrunedAt time.Time
	provenance   map[string]agentTurnPerformanceProvenance
	// attempted is a bounded best-effort dedupe window, not a delivery ledger.
	// Reporter.Track does not expose transport acknowledgement.
	attempted map[string]time.Time
}

// TurnPerformanceProvenanceInput carries submit-time analytics facts that must
// remain process-local and must not enter canonical messages or provider metadata.
type TurnPerformanceProvenanceInput struct {
	WorkspaceID              string
	AgentSessionID           string
	TurnID                   string
	Metadata                 map[string]any
	Provider                 string
	Model                    string
	RuntimeIdentityAvailable bool
}

type agentTurnPerformanceSummary struct {
	firstProgressMS   *int64
	hadLongIdle       bool
	hadToolCall       bool
	maxIdleMS         int64
	outcome           string
	sessionState      string
	ttftMS            *int64
	timingStartSource string
	toolCallCount     int64
	totalDurationMS   int64
	wasQueued         *bool
}

func (p *ActivityProjection) scheduleAgentTurnPerformance(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
	turn agentactivitybiz.Turn,
) {
	p.scheduleAgentTurnPerformanceWithLauncher(
		ctx,
		workspaceID,
		agentSessionID,
		turn,
		func(report func()) { go report() },
	)
}

func (p *ActivityProjection) scheduleAgentTurnPerformanceWithLauncher(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
	turn agentactivitybiz.Turn,
	launch func(func()),
) {
	if p == nil || launch == nil || turn.Backfilled || turn.Phase != agentactivitybiz.TurnPhaseSettled {
		return
	}
	reporter := p.analyticsReporterSnapshot()
	if !agentTurnPerformanceReporterEnabled(reporter) {
		return
	}
	key := agentTurnPerformanceKey(workspaceID, agentSessionID, turn.TurnID)
	if key == "" {
		return
	}
	provenance, claimed := p.claimTurnPerformanceReport(key, time.Now())
	if !claimed {
		return
	}
	// Analytics reads, parameter normalization, and transport are detached from the
	// commit callback. They are observational and must never delay the Turn.
	launch(func() {
		p.runAgentTurnPerformanceReport(ctx, reporter, workspaceID, agentSessionID, turn, provenance)
	})
}

func (p *ActivityProjection) runAgentTurnPerformanceReport(
	ctx context.Context,
	reporter reporterservice.Reporter,
	workspaceID string,
	agentSessionID string,
	turn agentactivitybiz.Turn,
	provenance agentTurnPerformanceProvenance,
) {
	deferredCtx := context.WithoutCancel(ctx)
	deferredCtx, cancel := context.WithTimeout(deferredCtx, 3*time.Second)
	defer cancel()
	defer func() { _ = recover() }()
	p.reportAgentTurnPerformance(deferredCtx, reporter, workspaceID, agentSessionID, turn, provenance)
}

// RecordTurnPerformanceProvenance keeps the privacy-reviewed submit facts and
// runtime identity in process memory only. Terminal reporting consumes the
// entry; daemon restart deliberately loses it and falls back to canonical state.
func (p *ActivityProjection) RecordTurnPerformanceProvenance(
	input TurnPerformanceProvenanceInput,
) {
	if p == nil {
		return
	}
	key := agentTurnPerformanceKey(input.WorkspaceID, input.AgentSessionID, input.TurnID)
	if key == "" {
		return
	}
	provenance := agentTurnPerformanceProvenance{
		clientSubmittedAtUnixMS:  metadataInt64(input.Metadata, "clientSubmittedAtUnixMs"),
		model:                    strings.TrimSpace(input.Model),
		provider:                 strings.TrimSpace(input.Provider),
		recordedAt:               time.Now(),
		runtimeIdentityAvailable: input.RuntimeIdentityAvailable,
	}
	if sessionState, ok := input.Metadata["sessionState"].(string); ok {
		provenance.sessionState = normalizedAgentTurnSessionState(sessionState)
	} else {
		provenance.sessionState = "unknown"
	}
	if queued, ok := input.Metadata["queued"].(bool); ok {
		queuedCopy := queued
		provenance.wasQueued = &queuedCopy
	}
	if provenance.clientSubmittedAtUnixMS <= 0 && !provenance.runtimeIdentityAvailable &&
		provenance.sessionState == "unknown" && provenance.wasQueued == nil {
		return
	}
	p.turnPerformanceState.record(key, provenance)
}

func (s *agentTurnPerformanceState) record(key string, provenance agentTurnPerformanceProvenance) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pruneIfDueLocked(provenance.recordedAt)
	if s.provenance == nil {
		s.provenance = make(map[string]agentTurnPerformanceProvenance)
	}
	if _, exists := s.provenance[key]; !exists && len(s.provenance) >= agentTurnPerformanceStateMaxEntries {
		s.evictOldestProvenanceLocked()
	}
	s.provenance[key] = provenance
}

func (p *ActivityProjection) claimTurnPerformanceReport(
	key string,
	now time.Time,
) (agentTurnPerformanceProvenance, bool) {
	p.turnPerformanceState.mu.Lock()
	defer p.turnPerformanceState.mu.Unlock()
	p.turnPerformanceState.pruneIfDueLocked(now)
	if p.turnPerformanceState.attempted == nil {
		p.turnPerformanceState.attempted = make(map[string]time.Time)
	}
	if _, attempted := p.turnPerformanceState.attempted[key]; attempted {
		return agentTurnPerformanceProvenance{}, false
	}
	if len(p.turnPerformanceState.attempted) >= agentTurnPerformanceStateMaxEntries {
		p.turnPerformanceState.evictOldestAttemptedLocked()
	}
	p.turnPerformanceState.attempted[key] = now
	provenance := p.turnPerformanceState.provenance[key]
	delete(p.turnPerformanceState.provenance, key)
	return provenance, true
}

func (s *agentTurnPerformanceState) pruneIfDueLocked(now time.Time) {
	if !s.lastPrunedAt.IsZero() && now.Sub(s.lastPrunedAt) < agentTurnPerformancePruneInterval {
		return
	}
	s.lastPrunedAt = now
	cutoff := now.Add(-agentTurnPerformanceStateTTL)
	for key, provenance := range s.provenance {
		if provenance.recordedAt.Before(cutoff) {
			delete(s.provenance, key)
		}
	}
	for key, attemptedAt := range s.attempted {
		if attemptedAt.Before(cutoff) {
			delete(s.attempted, key)
		}
	}
}

func (s *agentTurnPerformanceState) evictOldestProvenanceLocked() {
	var oldestKey string
	var oldestAt time.Time
	for key, provenance := range s.provenance {
		if oldestKey == "" || provenance.recordedAt.Before(oldestAt) {
			oldestKey = key
			oldestAt = provenance.recordedAt
		}
	}
	if oldestKey != "" {
		delete(s.provenance, oldestKey)
	}
}

func (s *agentTurnPerformanceState) evictOldestAttemptedLocked() {
	var oldestKey string
	var oldestAt time.Time
	for key, attemptedAt := range s.attempted {
		if oldestKey == "" || attemptedAt.Before(oldestAt) {
			oldestKey = key
			oldestAt = attemptedAt
		}
	}
	if oldestKey != "" {
		delete(s.attempted, oldestKey)
	}
}

func agentTurnPerformanceReporterEnabled(reporter reporterservice.Reporter) bool {
	// Analytics-disabled production wiring installs a non-nil NoopReporter.
	// Do not consume provenance or allocate a dedupe attempt for dropped events.
	if analyticsReporterIsNil(reporter) {
		return false
	}
	switch reporter.(type) {
	case reporterservice.NoopReporter, *reporterservice.NoopReporter:
		return false
	default:
		return true
	}
}

func agentTurnPerformanceKey(workspaceID string, agentSessionID string, turnID string) string {
	workspaceID = strings.TrimSpace(workspaceID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	turnID = strings.TrimSpace(turnID)
	if workspaceID == "" || agentSessionID == "" || turnID == "" {
		return ""
	}
	return workspaceID + "\x00" + agentSessionID + "\x00" + turnID
}

func (p *ActivityProjection) reportAgentTurnPerformance(
	ctx context.Context,
	reporter reporterservice.Reporter,
	workspaceID string,
	agentSessionID string,
	turn agentactivitybiz.Turn,
	provenance agentTurnPerformanceProvenance,
) {
	session, found, err := p.repo.GetSession(ctx, workspaceID, agentSessionID)
	if err != nil || !found {
		return
	}
	messages, err := p.agentTurnMessages(ctx, workspaceID, agentSessionID, turn.TurnID)
	if err != nil {
		return
	}
	summary := buildAgentTurnPerformanceSummary(turn, messages, provenance)
	provider, model := agentTurnAnalyticsRuntimeIdentity(provenance, session)
	toolCallCount := summary.toolCallCount
	turnperformance.Track(ctx, reporter, turnperformance.BuildParams(turnperformance.Input{
		FirstProgressMS:     summary.firstProgressMS,
		HadLongIdle:         summary.hadLongIdle,
		HadReconnect:        nil,
		HadRetry:            nil,
		HadToolCall:         summary.hadToolCall,
		MaxIdleMS:           summary.maxIdleMS,
		Model:               model,
		Outcome:             summary.outcome,
		Provider:            provider,
		ReconnectCount:      nil,
		RetryCount:          nil,
		SessionState:        summary.sessionState,
		TTFTMS:              summary.ttftMS,
		TimingStartSource:   summary.timingStartSource,
		TokenUsageAvailable: false,
		ToolCallCount:       &toolCallCount,
		TotalDurationMS:     summary.totalDurationMS,
		WasQueued:           summary.wasQueued,
	}))
}

func (p *ActivityProjection) agentTurnMessages(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
	turnID string,
) ([]agentactivitybiz.Message, error) {
	const pageSize = 500
	var messages []agentactivitybiz.Message
	var afterVersion uint64
	for {
		page, found, err := p.repo.ListSessionMessages(ctx, agentactivitybiz.ListSessionMessagesInput{
			WorkspaceID: workspaceID, AgentSessionID: agentSessionID, TurnID: turnID,
			AfterVersion: afterVersion, Limit: pageSize, Order: agentactivitybiz.MessageOrderAsc,
		})
		if err != nil {
			return nil, err
		}
		if !found {
			return messages, nil
		}
		messages = append(messages, page.Messages...)
		if !page.HasMore || page.LatestVersion <= afterVersion {
			return messages, nil
		}
		afterVersion = page.LatestVersion
	}
}

func buildAgentTurnPerformanceSummary(
	turn agentactivitybiz.Turn,
	messages []agentactivitybiz.Message,
	provenance agentTurnPerformanceProvenance,
) agentTurnPerformanceSummary {
	start := firstNonZeroInt64(turn.StartedAtUnixMS, turn.CreatedAtUnixMS)
	end := firstNonZeroInt64(turn.SettledAtUnixMS, turn.UpdatedAtUnixMS, start)
	summary := agentTurnPerformanceSummary{
		outcome:           agentTurnAnalyticsOutcome(turn),
		sessionState:      normalizedAgentTurnSessionState(provenance.sessionState),
		timingStartSource: "canonical_turn",
		wasQueued:         cloneBoolPointer(provenance.wasQueued),
	}
	if submittedAt := provenance.clientSubmittedAtUnixMS; submittedAt > 0 && (end <= 0 || submittedAt <= end) {
		start = submittedAt
		summary.timingStartSource = "client_submit"
	}

	progressTimes := make([]int64, 0, len(messages)+2)
	toolCalls := make(map[string]struct{})
	var firstProgressAt int64
	var firstTextAt int64
	for _, message := range messages {
		at := agentTurnMessageTimestamp(message)
		if strings.EqualFold(strings.TrimSpace(message.Role), "user") {
			continue
		}
		if !strings.EqualFold(strings.TrimSpace(message.Role), "assistant") || at <= 0 {
			continue
		}
		kind := strings.ToLower(strings.TrimSpace(message.Kind))
		displayable := false
		switch kind {
		case "text":
			if _, ok := assistantMessageText(message.Payload); ok {
				displayable = true
				if agentTurnMessageIsAnswerText(message) && (firstTextAt == 0 || at < firstTextAt) {
					firstTextAt = at
				}
			}
		case "reasoning":
			_, displayable = assistantMessageText(message.Payload)
		case "tool_call":
			displayable = true
			if id := strings.TrimSpace(message.MessageID); id != "" {
				toolCalls[id] = struct{}{}
			}
		}
		if displayable {
			progressTimes = append(progressTimes, at)
			if firstProgressAt == 0 || at < firstProgressAt {
				firstProgressAt = at
			}
		}
	}
	if start > 0 {
		progressTimes = append(progressTimes, start)
	}
	if end > 0 {
		progressTimes = append(progressTimes, end)
	}
	summary.toolCallCount = int64(len(toolCalls))
	summary.hadToolCall = summary.toolCallCount > 0
	summary.totalDurationMS = elapsedAgentTurnMS(start, end)
	if firstProgressAt > 0 {
		value := elapsedAgentTurnMS(start, firstProgressAt)
		summary.firstProgressMS = &value
	}
	if firstTextAt > 0 {
		value := elapsedAgentTurnMS(start, firstTextAt)
		summary.ttftMS = &value
	}
	sort.Slice(progressTimes, func(i, j int) bool { return progressTimes[i] < progressTimes[j] })
	for index := 1; index < len(progressTimes); index++ {
		if gap := progressTimes[index] - progressTimes[index-1]; gap > summary.maxIdleMS {
			summary.maxIdleMS = gap
		}
	}
	summary.hadLongIdle = summary.maxIdleMS >= agentTurnLongIdleThresholdMS
	return summary
}

func normalizedAgentTurnSessionState(value string) string {
	switch strings.TrimSpace(value) {
	case "new", "existing":
		return strings.TrimSpace(value)
	default:
		return "unknown"
	}
}

func agentTurnMessageIsAnswerText(message agentactivitybiz.Message) bool {
	if message.Semantics != nil && strings.TrimSpace(message.Semantics.NoticeCommand) != "" {
		return false
	}
	return !strings.EqualFold(strings.TrimSpace(payloadString(message.Payload, "kind")), "agent_system_notice")
}

func agentTurnMessageTimestamp(message agentactivitybiz.Message) int64 {
	return firstNonZeroInt64(message.StartedAtUnixMS, message.OccurredAtUnixMS, message.CreatedAtUnixMS)
}

func elapsedAgentTurnMS(start int64, end int64) int64 {
	if start <= 0 || end <= start {
		return 0
	}
	return end - start
}

func agentTurnAnalyticsOutcome(turn agentactivitybiz.Turn) string {
	switch strings.TrimSpace(turn.Outcome) {
	case agentactivitybiz.TurnOutcomeCompleted:
		return "success"
	case agentactivitybiz.TurnOutcomeCanceled:
		return "canceled"
	case agentactivitybiz.TurnOutcomeFailed:
		code := strings.ToLower(strings.TrimSpace(turn.ErrorCode))
		if strings.Contains(code, "timeout") || strings.Contains(code, "deadline") {
			return "timeout"
		}
		return "failure"
	case agentactivitybiz.TurnOutcomeInterrupted:
		return "failure"
	default:
		return "failure"
	}
}

func normalizeAgentTurnProvider(provider string) string {
	provider = strings.ToLower(strings.TrimSpace(provider))
	if provider == "" || len(provider) > 64 {
		return "unknown"
	}
	for _, char := range provider {
		if (char < 'a' || char > 'z') && (char < '0' || char > '9') && char != '.' && char != '_' && char != '-' && char != ':' {
			return "unknown"
		}
	}
	return provider
}

func agentTurnAnalyticsRuntimeIdentity(
	provenance agentTurnPerformanceProvenance,
	session agentactivitybiz.Session,
) (string, string) {
	provider := session.Provider
	model := session.Model
	if provenance.runtimeIdentityAvailable {
		provider = provenance.provider
		model = provenance.model
	}
	return normalizeAgentTurnProvider(provider), normalizeAgentTurnModel(model)
}

func normalizeAgentTurnModel(model string) string {
	model = strings.TrimSpace(model)
	if strings.HasPrefix(model, "~") {
		return "custom"
	}
	if !safeAgentTurnAnalyticsModelID(model) {
		return "unknown"
	}
	return model
}

func safeAgentTurnAnalyticsModelID(model string) bool {
	model = strings.TrimSpace(model)
	if model == "" || len(model) > 128 || strings.Contains(model, "://") {
		return false
	}
	for _, char := range model {
		if (char < 'a' || char > 'z') && (char < 'A' || char > 'Z') &&
			(char < '0' || char > '9') && !strings.ContainsRune("._~:/-", char) {
			return false
		}
	}
	return true
}
