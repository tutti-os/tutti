package agent

import (
	"context"
	"strings"
	"time"

	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
)

const defaultWaitMessageLimit = 20

func (s *Service) Wait(ctx context.Context, input WaitInput) (WaitResult, error) {
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	agentSessionID := strings.TrimSpace(input.AgentSessionID)
	if workspaceID == "" || agentSessionID == "" {
		return WaitResult{}, ErrInvalidArgument
	}
	messageLimit := input.MessageLimit
	if messageLimit < 0 {
		return WaitResult{}, ErrInvalidArgument
	}
	if messageLimit == 0 {
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
					initialStop,
					initialStopped,
					progressedPastStaleStop,
				)
				if err != nil {
					return WaitResult{}, err
				}
				if done {
					reason, _ := waitReasonForSession(currentSession)
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
	initialStop waitStopState,
	initialStopped bool,
	progressedPastStaleStop bool,
) (Session, bool, bool, error) {
	currentStop, stopped := waitStopStateForSession(session)
	if !initialStopped {
		if stopped {
			return session, true, true, nil
		}
		return session, false, true, nil
	}
	if !stopped {
		return session, false, true, nil
	}
	latestVersion, err := s.latestSessionVersion(ctx, workspaceID, agentSessionID)
	if err != nil {
		return Session{}, false, progressedPastStaleStop, err
	}
	if progressedPastStaleStop || currentStop != initialStop || latestVersion > effectiveAfter {
		return session, true, true, nil
	}
	return session, false, false, nil
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
	if session.ActiveTurn != nil {
		if strings.TrimSpace(session.ActiveTurn.Phase) != agentactivitybiz.TurnPhaseWaiting {
			return "", false
		}
		for _, interaction := range session.PendingInteractions {
			if interaction.Status != agentactivitybiz.InteractionStatusPending {
				continue
			}
			switch interaction.Kind {
			case agentactivitybiz.InteractionKindApproval:
				return WaitReasonWaitingApproval, true
			case agentactivitybiz.InteractionKindQuestion, agentactivitybiz.InteractionKindPlan:
				return WaitReasonWaitingInput, true
			}
		}
		return WaitReasonWaiting, true
	}
	if session.LatestTurn != nil {
		if strings.TrimSpace(session.LatestTurn.Phase) != agentactivitybiz.TurnPhaseSettled {
			return "", false
		}
		switch strings.TrimSpace(session.LatestTurn.Outcome) {
		case agentactivitybiz.TurnOutcomeCompleted:
			return WaitReasonCompleted, true
		case agentactivitybiz.TurnOutcomeFailed:
			return WaitReasonFailed, true
		case agentactivitybiz.TurnOutcomeCanceled, agentactivitybiz.TurnOutcomeInterrupted:
			return WaitReasonCanceled, true
		default:
			return "", false
		}
	}
	return WaitReasonReady, true
}

type waitStopState struct {
	Reason       string
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
	}
	if session.ActiveTurn != nil {
		state.Phase = strings.TrimSpace(session.ActiveTurn.Phase)
		state.ActiveTurnID = strings.TrimSpace(session.ActiveTurn.TurnID)
		state.Outcome = strings.TrimSpace(session.ActiveTurn.Outcome)
	} else if session.LatestTurn != nil {
		state.Phase = strings.TrimSpace(session.LatestTurn.Phase)
		state.Outcome = strings.TrimSpace(session.LatestTurn.Outcome)
	}
	return state, true
}
