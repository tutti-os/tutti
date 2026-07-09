package agent

import (
	"context"
	"strings"
	"time"

	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
)

const defaultWaitMessageLimit = 20
const explicitCompletedWaitGrace = 750 * time.Millisecond

func (s *Service) Wait(ctx context.Context, input WaitInput) (WaitResult, error) {
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	agentSessionID := strings.TrimSpace(input.AgentSessionID)
	if workspaceID == "" || agentSessionID == "" {
		return WaitResult{}, ErrInvalidArgument
	}
	messageLimit := input.MessageLimit
	if messageLimit < 0 && !input.SkipMessages {
		return WaitResult{}, ErrInvalidArgument
	}
	if input.SkipMessages {
		messageLimit = -1
	} else if messageLimit == 0 {
		messageLimit = defaultWaitMessageLimit
	}
	timeout := input.Timeout
	if timeout <= 0 {
		timeout = 5 * time.Minute
	}

	var effectiveAfter uint64
	if input.AfterVersion != nil {
		effectiveAfter = *input.AfterVersion
	} else {
		latestVersion, err := s.latestSessionVersion(ctx, workspaceID, agentSessionID)
		if err != nil {
			return WaitResult{}, err
		}
		effectiveAfter = latestVersion
	}

	initialSession, err := s.Get(ctx, workspaceID, agentSessionID)
	if err != nil {
		return WaitResult{}, err
	}
	initialStop, initialStopped := waitStopStateForSession(initialSession)
	if input.AfterVersion == nil && initialStopped {
		return s.waitResult(ctx, workspaceID, agentSessionID, initialSession, WaitReason(initialStop.Reason), false, effectiveAfter, messageLimit)
	}

	stream, err := s.Subscribe(ctx, StreamInput{
		WorkspaceID:    workspaceID,
		AgentSessionID: agentSessionID,
	})
	if err != nil {
		return WaitResult{}, err
	}
	defer stream.Unsubscribe()

	currentSession, err := s.Get(ctx, workspaceID, agentSessionID)
	if err != nil {
		return WaitResult{}, err
	}
	progressedPastStaleStop := !initialStopped
	waitCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	currentSession, done, nextProgressed, err := s.evaluateWaitSession(
		waitCtx,
		workspaceID,
		agentSessionID,
		currentSession,
		effectiveAfter,
		input.AfterVersion != nil,
		initialStop,
		initialStopped,
		progressedPastStaleStop,
	)
	if err != nil {
		return WaitResult{}, err
	}
	progressedPastStaleStop = nextProgressed
	if done {
		reason, _ := waitReasonForSession(currentSession)
		confirmedSession, confirmed, err := s.confirmCompletedWaitResult(waitCtx, workspaceID, agentSessionID, currentSession, reason, effectiveAfter, input.AfterVersion != nil)
		if err != nil {
			return WaitResult{}, err
		}
		if !confirmed {
			currentSession = confirmedSession
			done = false
		}
	}
	if done {
		reason, _ := waitReasonForSession(currentSession)
		return s.waitResult(waitCtx, workspaceID, agentSessionID, currentSession, reason, false, effectiveAfter, messageLimit)
	}

	for {
		select {
		case <-waitCtx.Done():
			session, err := s.Get(ctx, workspaceID, agentSessionID)
			if err != nil {
				return WaitResult{}, err
			}
			return s.waitResult(ctx, workspaceID, agentSessionID, session, WaitReasonTimeout, true, effectiveAfter, messageLimit)
		case _, ok := <-stream.Events:
			if !ok {
				session, err := s.Get(ctx, workspaceID, agentSessionID)
				if err != nil {
					return WaitResult{}, err
				}
				currentSession, done, _, err := s.evaluateWaitSession(
					waitCtx,
					workspaceID,
					agentSessionID,
					session,
					effectiveAfter,
					input.AfterVersion != nil,
					initialStop,
					initialStopped,
					progressedPastStaleStop,
				)
				if err != nil {
					return WaitResult{}, err
				}
				if done {
					reason, _ := waitReasonForSession(currentSession)
					confirmedSession, confirmed, err := s.confirmCompletedWaitResult(waitCtx, workspaceID, agentSessionID, currentSession, reason, effectiveAfter, input.AfterVersion != nil)
					if err != nil {
						return WaitResult{}, err
					}
					if !confirmed {
						return s.waitResult(ctx, workspaceID, agentSessionID, confirmedSession, WaitReasonTimeout, true, effectiveAfter, messageLimit)
					}
					currentSession = confirmedSession
					return s.waitResult(waitCtx, workspaceID, agentSessionID, currentSession, reason, false, effectiveAfter, messageLimit)
				}
				return s.waitResult(ctx, workspaceID, agentSessionID, session, WaitReasonTimeout, true, effectiveAfter, messageLimit)
			}
			session, err := s.Get(ctx, workspaceID, agentSessionID)
			if err != nil {
				return WaitResult{}, err
			}
			currentSession, done, nextProgressed, err = s.evaluateWaitSession(
				waitCtx,
				workspaceID,
				agentSessionID,
				session,
				effectiveAfter,
				input.AfterVersion != nil,
				initialStop,
				initialStopped,
				progressedPastStaleStop,
			)
			if err != nil {
				return WaitResult{}, err
			}
			progressedPastStaleStop = nextProgressed
			if done {
				reason, _ := waitReasonForSession(currentSession)
				confirmedSession, confirmed, err := s.confirmCompletedWaitResult(waitCtx, workspaceID, agentSessionID, currentSession, reason, effectiveAfter, input.AfterVersion != nil)
				if err != nil {
					return WaitResult{}, err
				}
				if !confirmed {
					continue
				}
				currentSession = confirmedSession
				return s.waitResult(waitCtx, workspaceID, agentSessionID, currentSession, reason, false, effectiveAfter, messageLimit)
			}
		}
	}
}

func (s *Service) evaluateWaitSession(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
	session Session,
	effectiveAfter uint64,
	explicitAfter bool,
	initialStop waitStopState,
	initialStopped bool,
	progressedPastStaleStop bool,
) (Session, bool, bool, error) {
	currentStop, stopped := waitStopStateForSession(session)
	if !initialStopped {
		if stopped {
			messageState, err := s.agentExecutionMessageStateAfter(ctx, workspaceID, agentSessionID, effectiveAfter)
			if err != nil {
				return Session{}, false, progressedPastStaleStop, err
			}
			if waitStopBlockedByExecutionMessages(currentStop, explicitAfter, messageState) {
				return session, false, true, nil
			}
			return session, true, true, nil
		}
		return session, false, true, nil
	}
	if !stopped {
		return session, false, true, nil
	}
	if progressedPastStaleStop || currentStop != initialStop || effectiveAfter == 0 {
		messageState, err := s.agentExecutionMessageStateAfter(ctx, workspaceID, agentSessionID, effectiveAfter)
		if err != nil {
			return Session{}, false, progressedPastStaleStop, err
		}
		if waitStopBlockedByExecutionMessages(currentStop, explicitAfter, messageState) {
			return session, false, progressedPastStaleStop, nil
		}
		return session, true, true, nil
	}
	if explicitAfter && currentStop.Reason == string(WaitReasonCompleted) {
		messageState, err := s.agentExecutionMessageStateAfter(ctx, workspaceID, agentSessionID, effectiveAfter)
		if err != nil {
			return Session{}, false, progressedPastStaleStop, err
		}
		if waitStopBlockedByExecutionMessages(currentStop, explicitAfter, messageState) {
			return session, false, progressedPastStaleStop, nil
		}
		if messageState.HasExecution {
			return session, true, true, nil
		}
	}
	return session, false, false, nil
}

func (s *Service) confirmCompletedWaitResult(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
	session Session,
	reason WaitReason,
	effectiveAfter uint64,
	explicitAfter bool,
) (Session, bool, error) {
	if !explicitAfter || reason != WaitReasonCompleted {
		return session, true, nil
	}
	timer := time.NewTimer(explicitCompletedWaitGrace)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return session, false, nil
	case <-timer.C:
	}
	latestSession, err := s.Get(ctx, workspaceID, agentSessionID)
	if err != nil {
		return Session{}, false, err
	}
	currentStop, stopped := waitStopStateForSession(latestSession)
	if !stopped || currentStop.Reason != string(WaitReasonCompleted) {
		return latestSession, false, nil
	}
	messageState, err := s.agentExecutionMessageStateAfter(ctx, workspaceID, agentSessionID, effectiveAfter)
	if err != nil {
		return Session{}, false, err
	}
	if waitStopBlockedByExecutionMessages(currentStop, explicitAfter, messageState) {
		return latestSession, false, nil
	}
	return latestSession, true, nil
}

func (s *Service) waitResult(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
	session Session,
	reason WaitReason,
	timedOut bool,
	effectiveAfter uint64,
	messageLimit int,
) (WaitResult, error) {
	if messageLimit < 0 {
		latestVersion, err := s.latestSessionVersion(ctx, workspaceID, agentSessionID)
		if err != nil {
			return WaitResult{}, err
		}
		return WaitResult{
			Session:        cloneSession(session),
			LatestVersion:  latestVersion,
			Reason:         reason,
			TimedOut:       timedOut,
			EffectiveAfter: effectiveAfter,
		}, nil
	}
	messages, latestVersion, hasMore, err := s.recentAgentExecutionMessages(ctx, workspaceID, agentSessionID, effectiveAfter, messageLimit)
	if err != nil {
		return WaitResult{}, err
	}
	return WaitResult{
		Session:        cloneSession(session),
		Messages:       messages,
		LatestVersion:  latestVersion,
		HasMore:        hasMore,
		Reason:         reason,
		TimedOut:       timedOut,
		EffectiveAfter: effectiveAfter,
	}, nil
}

func (s *Service) latestSessionVersion(ctx context.Context, workspaceID string, agentSessionID string) (uint64, error) {
	page, err := s.ListMessages(ctx, workspaceID, agentSessionID, ListMessagesInput{
		Limit: 1,
		Order: agentactivitybiz.MessageOrderDesc,
	})
	if err != nil {
		return 0, err
	}
	return page.LatestVersion, nil
}

type waitExecutionMessageState struct {
	HasExecution bool
	HasLive      bool
}

func (s *Service) agentExecutionMessageStateAfter(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
	afterVersion uint64,
) (waitExecutionMessageState, error) {
	var state waitExecutionMessageState
	for {
		page, err := s.ListMessages(ctx, workspaceID, agentSessionID, ListMessagesInput{
			AfterVersion: afterVersion,
			Limit:        100,
			Order:        agentactivitybiz.MessageOrderAsc,
		})
		if err != nil {
			return waitExecutionMessageState{}, err
		}
		for _, message := range page.Messages {
			if message.Version <= afterVersion {
				continue
			}
			if !isAgentExecutionRole(message.Role) {
				continue
			}
			state.HasExecution = true
			if sessionMessageStatusIsLive(message.Status) {
				state.HasLive = true
				return state, nil
			}
		}
		if !page.HasMore || len(page.Messages) == 0 {
			return state, nil
		}
		nextAfterVersion := page.Messages[len(page.Messages)-1].Version
		if nextAfterVersion <= afterVersion {
			return state, nil
		}
		afterVersion = nextAfterVersion
	}
}

func waitStopBlockedByExecutionMessages(stop waitStopState, explicitAfter bool, messageState waitExecutionMessageState) bool {
	if messageState.HasLive {
		return true
	}
	if explicitAfter && stop.Reason == string(WaitReasonCompleted) && !messageState.HasExecution {
		return true
	}
	return false
}

func isAgentExecutionRole(role string) bool {
	return strings.TrimSpace(role) != "" && strings.TrimSpace(role) != "user"
}

func sessionMessageStatusIsLive(status string) bool {
	switch strings.TrimSpace(status) {
	case "running", "streaming", "in_progress", "pending", "submitted", "working":
		return true
	default:
		return false
	}
}

func (s *Service) recentAgentExecutionMessages(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
	afterVersion uint64,
	limit int,
) ([]SessionMessage, uint64, bool, error) {
	pageSize := limit
	if pageSize < defaultWaitMessageLimit {
		pageSize = defaultWaitMessageLimit
	}
	collected := make([]SessionMessage, 0, limit+1)
	var beforeVersion uint64
	var latestVersion uint64
	for {
		page, err := s.ListMessages(ctx, workspaceID, agentSessionID, ListMessagesInput{
			BeforeVersion: beforeVersion,
			Limit:         pageSize,
			Order:         agentactivitybiz.MessageOrderDesc,
		})
		if err != nil {
			return nil, 0, false, err
		}
		if latestVersion == 0 || beforeVersion == 0 {
			latestVersion = page.LatestVersion
		}
		for _, message := range page.Messages {
			if message.Version <= afterVersion {
				reverseSessionMessages(collected)
				return cloneSessionMessages(collected), latestVersion, false, nil
			}
			if strings.TrimSpace(message.Role) == "user" {
				continue
			}
			collected = append(collected, message)
			if len(collected) > limit {
				reverseSessionMessages(collected[:limit])
				return cloneSessionMessages(collected[:limit]), latestVersion, true, nil
			}
		}
		if !page.HasMore || len(page.Messages) == 0 {
			break
		}
		beforeVersion = page.Messages[len(page.Messages)-1].Version
		if beforeVersion == 0 {
			break
		}
	}
	reverseSessionMessages(collected)
	return cloneSessionMessages(collected), latestVersion, false, nil
}

func reverseSessionMessages(messages []SessionMessage) {
	for left, right := 0, len(messages)-1; left < right; left, right = left+1, right-1 {
		messages[left], messages[right] = messages[right], messages[left]
	}
}

func waitReasonForSession(session Session) (WaitReason, bool) {
	if session.TurnLifecycle != nil {
		if strings.TrimSpace(session.TurnLifecycle.Phase) == "settled" {
			if reason, ok := waitReasonForOutcome(session.TurnLifecycle.Outcome); ok {
				return reason, true
			}
		}
		if reason, ok := waitReasonForPhase(session.TurnLifecycle.Phase); ok {
			return reason, true
		}
	}
	switch strings.TrimSpace(session.Status) {
	case "ready", "created":
		return WaitReasonReady, true
	case "waiting":
		return WaitReasonWaiting, true
	case "completed":
		return WaitReasonCompleted, true
	case "failed":
		return WaitReasonFailed, true
	case "canceled":
		return WaitReasonCanceled, true
	default:
		return "", false
	}
}

func waitReasonForOutcome(outcome *string) (WaitReason, bool) {
	if outcome == nil {
		return "", false
	}
	switch strings.TrimSpace(*outcome) {
	case "completed", "done", "success", "succeeded":
		return WaitReasonCompleted, true
	case "failed", "error":
		return WaitReasonFailed, true
	case "canceled", "cancelled", "interrupted":
		return WaitReasonCanceled, true
	default:
		return "", false
	}
}

func waitReasonForPhase(phase string) (WaitReason, bool) {
	switch strings.TrimSpace(phase) {
	case "waiting_approval":
		return WaitReasonWaitingApproval, true
	case "waiting_input":
		return WaitReasonWaitingInput, true
	case "running", "preparing":
		return "", false
	default:
		return "", false
	}
}

type waitStopState struct {
	Reason       string
	Status       string
	Phase        string
	ActiveTurnID string
	Outcome      string
}

func waitStopStateForSession(session Session) (waitStopState, bool) {
	reason, ok := waitReasonForSession(session)
	if !ok {
		return waitStopState{}, false
	}
	state := waitStopState{
		Reason: string(reason),
		Status: strings.TrimSpace(session.Status),
	}
	if session.TurnLifecycle != nil {
		state.Phase = strings.TrimSpace(session.TurnLifecycle.Phase)
		if session.TurnLifecycle.ActiveTurnID != nil {
			state.ActiveTurnID = strings.TrimSpace(*session.TurnLifecycle.ActiveTurnID)
		}
		if session.TurnLifecycle.Outcome != nil {
			state.Outcome = strings.TrimSpace(*session.TurnLifecycle.Outcome)
		}
	}
	return state, true
}
