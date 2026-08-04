package agent

import (
	"context"
	"sort"
	"strings"
	"sync"
	"time"

	agentactivitybiz "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	turnperformance "github.com/tutti-os/tutti/services/tuttid/service/reporter/events/agent/turn_performance"
)

const agentTurnLongIdleThresholdMS int64 = 10_000

type agentTurnPerformanceState struct {
	modelCatalog AgentModelCatalog
	mu           sync.Mutex
	reported     map[string]struct{}
}

func (p *ActivityProjection) SetTurnPerformanceModelCatalog(catalog AgentModelCatalog) {
	if p != nil {
		p.turnPerformanceState.modelCatalog = catalog
	}
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
	if p == nil || p.analyticsReporter == nil || turn.Backfilled || turn.Phase != agentactivitybiz.TurnPhaseSettled {
		return
	}
	key := strings.TrimSpace(workspaceID) + "\x00" + strings.TrimSpace(agentSessionID) + "\x00" + strings.TrimSpace(turn.TurnID)
	if key == "\x00\x00" || !p.claimTurnPerformanceReport(key) {
		return
	}
	// Analytics reads, catalog resolution, and transport are detached from the
	// commit callback. They are observational and must never delay the Turn.
	go func() {
		deferredCtx := context.WithoutCancel(ctx)
		deferredCtx, cancel := context.WithTimeout(deferredCtx, 3*time.Second)
		defer cancel()
		defer func() { _ = recover() }()
		p.reportAgentTurnPerformance(deferredCtx, workspaceID, agentSessionID, turn)
	}()
}

func (p *ActivityProjection) claimTurnPerformanceReport(key string) bool {
	p.turnPerformanceState.mu.Lock()
	defer p.turnPerformanceState.mu.Unlock()
	if p.turnPerformanceState.reported == nil {
		p.turnPerformanceState.reported = make(map[string]struct{})
	}
	if _, reported := p.turnPerformanceState.reported[key]; reported {
		return false
	}
	p.turnPerformanceState.reported[key] = struct{}{}
	return true
}

func (p *ActivityProjection) reportAgentTurnPerformance(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
	turn agentactivitybiz.Turn,
) {
	session, found, err := p.repo.GetSession(ctx, workspaceID, agentSessionID)
	if err != nil || !found {
		return
	}
	messages, err := p.agentTurnMessages(ctx, workspaceID, agentSessionID, turn.TurnID)
	if err != nil {
		return
	}
	summary := buildAgentTurnPerformanceSummary(turn, messages)
	model := resolveAgentTurnAnalyticsModel(ctx, p.turnPerformanceState.modelCatalog, session)
	provider := normalizeAgentTurnProvider(session.Provider)
	toolCallCount := summary.toolCallCount
	turnperformance.Track(ctx, p.analyticsReporter, turnperformance.BuildParams(turnperformance.Input{
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

func buildAgentTurnPerformanceSummary(turn agentactivitybiz.Turn, messages []agentactivitybiz.Message) agentTurnPerformanceSummary {
	start := firstNonZeroInt64(turn.StartedAtUnixMS, turn.CreatedAtUnixMS)
	end := firstNonZeroInt64(turn.SettledAtUnixMS, turn.UpdatedAtUnixMS, start)
	summary := agentTurnPerformanceSummary{
		outcome:           agentTurnAnalyticsOutcome(turn),
		sessionState:      "unknown",
		timingStartSource: "canonical_turn",
	}

	progressTimes := make([]int64, 0, len(messages)+2)
	toolCalls := make(map[string]struct{})
	var firstProgressAt int64
	var firstTextAt int64
	for _, message := range messages {
		at := agentTurnMessageTimestamp(message)
		if strings.EqualFold(strings.TrimSpace(message.Role), "user") {
			if submittedAt := metadataInt64(message.Payload, "clientSubmittedAtUnixMs"); submittedAt > 0 && (end <= 0 || submittedAt <= end) {
				start = submittedAt
				summary.timingStartSource = "client_submit"
			}
			if queued, ok := message.Payload["queued"].(bool); ok {
				queuedCopy := queued
				summary.wasQueued = &queuedCopy
			}
			if state, ok := message.Payload["sessionState"].(string); ok {
				switch strings.TrimSpace(state) {
				case "new", "existing":
					summary.sessionState = strings.TrimSpace(state)
				}
			}
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

func resolveAgentTurnAnalyticsModel(ctx context.Context, catalog AgentModelCatalog, session agentactivitybiz.Session) string {
	model := strings.TrimSpace(session.Model)
	if model == "" || catalog == nil {
		return "unknown"
	}
	result, err := catalog.ListModels(ctx, AgentModelCatalogInput{
		Provider: strings.TrimSpace(session.Provider),
		Cwd:      session.Cwd,
	})
	if err != nil {
		return "unknown"
	}
	if strings.EqualFold(strings.TrimSpace(result.Source), "codex-configured-model") || strings.HasPrefix(model, "~") {
		return "custom"
	}
	for _, option := range result.Models {
		if id := strings.TrimSpace(option.ID); id == model {
			if safeAgentTurnAnalyticsModelID(id) {
				return id
			}
			return "unknown"
		}
	}
	return "custom"
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
