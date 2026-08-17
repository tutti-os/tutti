package agentruntime

import (
	"fmt"
	"strings"
)

type scriptedGoalState struct {
	goal                            map[string]any
	goalGetAfterSnapshot            func()
	goalStartsTurn                  bool
	goalNotificationsBeforeResponse bool
	goalUpdatedOmitsTurnID          bool
	goalTurnsStarted                int
	goalCompletionAfterTurns        int
	goalTurnFailAtTurn              int
	goalCleared                     bool
	goalOmitUpdatedAt               bool
	goalEmptyResponse               bool
}

type scriptedReviewState struct {
	reviewInline             bool
	reviewInlineSummaryDelta bool
	reviewHang               bool
	reviewStartEntered       chan struct{}
}

func (s *fakeCodexAppServer) handleGoalReviewRPC(message scriptedAppServerMessage) bool {
	switch message.Method {
	case appServerMethodThreadGoalSet:
		s.mu.Lock()
		previousGoal := clonePayload(s.goal)
		goalStartsTurn := s.goalStartsTurn
		goalTurnNumber := s.goalTurnsStarted
		objective := firstNonEmpty(asString(message.Params["objective"]), asString(previousGoal["objective"]))
		// Continuations may be status-only (active, no objective). Still start
		// the next Goal turn when a prior objective exists.
		if goalStartsTurn && strings.TrimSpace(objective) != "" &&
			(strings.TrimSpace(asString(message.Params["objective"])) != "" ||
				asString(message.Params["status"]) == "active") {
			s.goalTurnsStarted++
			goalTurnNumber = s.goalTurnsStarted
		}
		goalStatus := firstNonEmpty(asString(message.Params["status"]), "active")
		if goalStartsTurn &&
			goalTurnNumber > 0 &&
			s.goalCompletionAfterTurns > 0 &&
			goalTurnNumber >= s.goalCompletionAfterTurns {
			goalStatus = "complete"
		}
		goal := map[string]any{
			"threadId":        "codex-thread-1",
			"objective":       objective,
			"status":          goalStatus,
			"tokensUsed":      int64(0),
			"timeUsedSeconds": int64(0),
			"createdAt":       int64(1750000000),
			"updatedAt":       int64(1750000001),
		}
		if s.goalOmitUpdatedAt {
			delete(goal, "updatedAt")
		}
		if tokenBudget, ok := int64Value(message.Params["tokenBudget"]); ok {
			goal["tokenBudget"] = tokenBudget
		}
		s.goal = clonePayload(goal)
		notificationsBeforeResponse := s.goalNotificationsBeforeResponse
		responseGoal := goal
		if s.goalEmptyResponse {
			responseGoal = map[string]any{}
		}
		s.mu.Unlock()
		sendResponse := func() {
			s.sendJSON(map[string]any{
				"id":     message.ID,
				"result": map[string]any{"goal": responseGoal},
			})
		}
		sendTurnNotifications := func() {
			if !goalStartsTurn || goalTurnNumber <= 0 {
				return
			}
			turnID := fmt.Sprintf("turn-goal-%d", goalTurnNumber)
			itemID := fmt.Sprintf("item-goal-%d", goalTurnNumber)
			s.mu.Lock()
			failThisTurn := s.goalTurnFailAtTurn > 0 && goalTurnNumber == s.goalTurnFailAtTurn
			s.mu.Unlock()
			messageText := "I'll work on the goal."
			if goalStatus == "complete" && goalTurnNumber > 1 {
				messageText = "Goal complete."
			}
			goalUpdate := map[string]any{
				"threadId": "codex-thread-1",
				"goal":     goal,
			}
			s.mu.Lock()
			omitTurnID := s.goalUpdatedOmitsTurnID
			s.mu.Unlock()
			if !omitTurnID {
				goalUpdate["turnId"] = turnID
			}
			s.notify(appServerNotifyThreadGoalUpdated, goalUpdate)
			s.notify(appServerNotifyTurnStarted, map[string]any{
				"threadId": "codex-thread-1",
				"turn":     map[string]any{"id": turnID, "status": "inProgress", "items": []any{}},
			})
			if failThisTurn {
				// Simulate a mid-goal turn ending in a transient failure
				// (a tool or model error) while the goal itself remains
				// "active" per codex's own thread state: the turn
				// settles failed but the goal is not paused/completed.
				s.notify(appServerNotifyTurnCompleted, map[string]any{
					"threadId": "codex-thread-1",
					"turn": map[string]any{
						"id":     turnID,
						"status": "failed",
						"items":  []any{},
						"error":  map[string]any{"message": "transient tool failure"},
					},
				})
				return
			}
			s.notify(appServerNotifyAgentMessageDelta, map[string]any{
				"threadId": "codex-thread-1", "turnId": turnID, "itemId": itemID, "delta": messageText,
			})
			s.notify(appServerNotifyTurnCompleted, map[string]any{
				"threadId": "codex-thread-1",
				"turn": map[string]any{
					"id":     turnID,
					"status": "completed",
					"items": []any{
						map[string]any{"type": "agentMessage", "id": itemID, "text": messageText},
					},
				},
			})
		}
		if notificationsBeforeResponse {
			sendTurnNotifications()
			sendResponse()
		} else {
			sendResponse()
			sendTurnNotifications()
		}
	case appServerMethodThreadGoalGet:
		s.mu.Lock()
		goal := clonePayload(s.goal)
		afterSnapshot := s.goalGetAfterSnapshot
		s.mu.Unlock()
		if afterSnapshot != nil {
			afterSnapshot()
		}
		s.sendJSON(map[string]any{
			"id":     message.ID,
			"result": map[string]any{"goal": goal},
		})
	case appServerMethodThreadGoalClear:
		s.mu.Lock()
		s.goal = nil
		s.goalCleared = true
		s.mu.Unlock()
		s.sendJSON(map[string]any{
			"id":     message.ID,
			"result": map[string]any{"cleared": true},
		})
	case appServerMethodReviewStart:
		s.mu.Lock()
		reviewInline := s.reviewInline
		reviewInlineSummaryDelta := s.reviewInlineSummaryDelta
		reviewHang := s.reviewHang
		reviewStartEntered := s.reviewStartEntered
		s.mu.Unlock()
		s.sendJSON(map[string]any{
			"id": message.ID,
			"result": map[string]any{
				"reviewThreadId": "codex-thread-1",
				"turn":           map[string]any{"id": "turn-review", "status": "inProgress", "items": []any{}},
			},
		})
		if reviewStartEntered != nil {
			close(reviewStartEntered)
		}
		if reviewHang {
			// Leave the review turn in flight so the caller can cancel it.
			return true
		}
		if reviewInline {
			// Inline delivery: reasoning and command output arrive as
			// item/started + item/completed (no agentMessageDelta), the
			// way a real /review turn streams.
			s.notify(appServerNotifyItemStarted, map[string]any{
				"threadId": "codex-thread-1", "turnId": "turn-review",
				"item": map[string]any{"type": "reasoning", "id": "item-think", "status": "inProgress", "summary": []any{}, "content": []any{}},
			})
			if reviewInlineSummaryDelta {
				for _, delta := range []string{"Inspecting", "the", "auth", "flow."} {
					s.notify(appServerNotifyReasoningSummary, map[string]any{
						"threadId": "codex-thread-1", "turnId": "turn-review",
						"itemId": "item-think", "summaryIndex": 0, "delta": delta,
					})
				}
				s.notify(appServerNotifyItemCompleted, map[string]any{
					"threadId": "codex-thread-1", "turnId": "turn-review",
					"item": map[string]any{"type": "reasoning", "id": "item-think", "status": "completed", "summary": []any{"Inspecting the auth flow."}, "content": []any{}},
				})
			} else {
				s.notify(appServerNotifyItemCompleted, map[string]any{
					"threadId": "codex-thread-1", "turnId": "turn-review",
					"item": map[string]any{"type": "reasoning", "id": "item-think", "status": "completed", "summary": []any{"Inspecting the auth flow."}, "content": []any{}},
				})
			}
			s.notify(appServerNotifyItemStarted, map[string]any{
				"threadId": "codex-thread-1", "turnId": "turn-review",
				"item": map[string]any{"type": "commandExecution", "id": "item-cmd", "command": "rg verifyToken", "cwd": "/workspace", "status": "inProgress"},
			})
			s.notify(appServerNotifyItemCompleted, map[string]any{
				"threadId": "codex-thread-1", "turnId": "turn-review",
				"item": map[string]any{"type": "commandExecution", "id": "item-cmd", "command": "rg verifyToken", "cwd": "/workspace", "status": "completed", "aggregatedOutput": "auth.go:42", "exitCode": 0},
			})
			s.notify(appServerNotifyTurnCompleted, map[string]any{
				"threadId": "codex-thread-1",
				"turn": map[string]any{
					"id": "turn-review", "status": "completed",
					"items": []any{
						map[string]any{"type": "reasoning", "id": "item-think", "summary": []any{"Inspecting the auth flow."}, "content": []any{}},
						map[string]any{"type": "commandExecution", "id": "item-cmd", "command": "rg verifyToken", "status": "completed", "exitCode": 0},
						map[string]any{"type": "agentMessage", "id": "item-review", "text": "Found one issue."},
					},
				},
			})
			return true
		}
		s.notify(appServerNotifyAgentMessageDelta, map[string]any{
			"threadId": "codex-thread-1", "turnId": "turn-review", "itemId": "item-review", "delta": "Found one issue.",
		})
		s.notify(appServerNotifyTurnCompleted, map[string]any{
			"threadId": "codex-thread-1",
			"turn": map[string]any{
				"id": "turn-review", "status": "completed",
				"items": []any{map[string]any{"type": "agentMessage", "id": "item-review", "text": "Found one issue."}},
			},
		})
	default:
		return false
	}
	return true
}
