package agentruntime

import "fmt"

type scriptedTurnState struct {
	emitPlanItem            bool
	turnStatus              string
	turnError               map[string]any
	holdTurn                bool
	steeredTurnStart        bool
	ignoreInterrupt         bool
	hangInterrupt           bool
	interruptTurnIDMismatch string
	interruptAttempts       []string
	turnStartEntered        chan struct{}
	turnStartRelease        chan struct{}
	hangTurnStart           bool
	closeOnTurnStart        bool
	turnStartError          bool
	hangSteer               bool
	commandApproval         bool
	userInputRequest        bool
	compactSilent           bool
	foreignThreadNoise      bool
	approvalResponse        map[string]any
}

func (s *fakeCodexAppServer) handleTurnRPC(message scriptedAppServerMessage) bool {
	switch message.Method {
	case appServerMethodTurnStart:
		s.mu.Lock()
		hold := s.holdTurn
		steered := s.steeredTurnStart
		approval := s.commandApproval
		userInput := s.userInputRequest
		emitPlan := s.emitPlanItem
		foreignThreadNoise := s.foreignThreadNoise
		turnStartEntered := s.turnStartEntered
		turnStartRelease := s.turnStartRelease
		hangTurnStart := s.hangTurnStart
		closeOnTurnStart := s.closeOnTurnStart
		turnStartError := s.turnStartError
		s.mu.Unlock()
		threadID := firstNonEmpty(
			asString(message.Params["threadId"]),
			"codex-thread-1",
		)
		if turnStartEntered != nil {
			close(turnStartEntered)
		}
		if turnStartRelease != nil {
			<-turnStartRelease
		}
		if hangTurnStart {
			return true
		}
		if closeOnTurnStart {
			_ = s.Close()
			return true
		}
		if turnStartError {
			s.sendJSON(map[string]any{
				"id": message.ID,
				"error": map[string]any{
					"code":    -32000,
					"message": "turn/start rejected by test",
				},
			})
			return true
		}
		if steered {
			// Mirror real codex steering (live-verified against codex
			// 0.142.5, TestLiveProtocolTurnStartDuringActiveTurn):
			// turn/start while a turn is already running responds
			// immediately with a NEW turn id in status inProgress, but
			// the input is absorbed by the running turn ("turn-1") — no
			// turn/started ever fires for the stub id and the only
			// terminal notification is the running turn's turn/completed
			// (sent by the test via completePendingTurn).
			turnStartResponse := map[string]any{
				"id": message.ID,
				"result": map[string]any{
					"turn": map[string]any{"id": "turn-steer-stub", "status": "inProgress", "items": []any{}},
				},
			}
			if approval {
				s.sendJSONBatch(
					turnStartResponse,
					map[string]any{
						"id":     "approval-1",
						"method": appServerMethodCommandApproval,
						"params": map[string]any{
							"threadId":    threadID,
							"turnId":      "turn-1",
							"itemId":      "item-cmd",
							"command":     "rm -rf build",
							"cwd":         "/workspace",
							"reason":      "cleanup",
							"startedAtMs": 1750000000000,
						},
					},
				)
				return true
			}
			s.sendJSON(turnStartResponse)
			return true
		}
		turnStartResponse := map[string]any{
			"id": message.ID,
			"result": map[string]any{
				"turn": map[string]any{"id": "turn-1", "status": "inProgress", "items": []any{}},
			},
		}
		turnStartedNotification := map[string]any{
			"method": appServerNotifyTurnStarted,
			"params": map[string]any{
				"threadId": threadID,
				"turn":     map[string]any{"id": "turn-1", "status": "inProgress", "items": []any{}},
			},
		}
		if approval {
			s.sendJSONBatch(
				turnStartResponse,
				turnStartedNotification,
				map[string]any{
					"id":     "approval-1",
					"method": appServerMethodCommandApproval,
					"params": map[string]any{
						"threadId":    threadID,
						"turnId":      "turn-1",
						"itemId":      "item-cmd",
						"command":     "rm -rf build",
						"cwd":         "/workspace",
						"reason":      "cleanup",
						"startedAtMs": 1750000000000,
					},
				},
			)
			return true
		}
		if userInput {
			s.sendJSONBatch(
				turnStartResponse,
				turnStartedNotification,
				map[string]any{
					"id":     "question-1",
					"method": appServerMethodRequestUserInput,
					"params": map[string]any{
						"threadId": threadID,
						"turnId":   "turn-1",
						"itemId":   "item-question",
						"questions": []any{
							map[string]any{"id": "q1", "question": "Which database?"},
						},
					},
				},
			)
			return true
		}
		// Mirror the real app-server: the RPC responds immediately with
		// the inProgress turn; output streams as notifications.
		s.sendJSON(turnStartResponse)
		s.sendJSON(turnStartedNotification)
		if foreignThreadNoise {
			s.notify(appServerNotifyAgentMessageDelta, map[string]any{
				"threadId": "foreign-thread-1", "turnId": "foreign-turn-1", "itemId": "foreign-msg",
				"delta": `{"n":7}`,
			})
			s.notify(appServerNotifyItemCompleted, map[string]any{
				"threadId": "foreign-thread-1", "turnId": "foreign-turn-1",
				"item": map[string]any{
					"type": "agentMessage", "id": "foreign-msg", "text": `{"n":7}`,
				},
			})
			s.notify(appServerNotifyTurnCompleted, map[string]any{
				"threadId": "foreign-thread-1",
				"turn": map[string]any{
					"id":     "foreign-turn-1",
					"status": "completed",
					"items": []any{
						map[string]any{"type": "agentMessage", "id": "foreign-msg", "text": `{"n":7}`},
					},
				},
			})
		}
		if emitPlan {
			s.notify(appServerNotifyItemCompleted, map[string]any{
				"threadId": threadID,
				"turnId":   "turn-1",
				"item": map[string]any{
					"type": "plan",
					"id":   "item-plan-1",
					"text": "# Plan\n1. inspect\n2. fix",
				},
			})
		}
		s.notify(appServerNotifyReasoningDelta, map[string]any{
			"threadId": threadID, "turnId": "turn-1", "itemId": "item-think",
			"contentIndex": 0, "delta": "Need ",
		})
		s.notify(appServerNotifyReasoningDelta, map[string]any{
			"threadId": threadID, "turnId": "turn-1", "itemId": "item-think",
			"contentIndex": 0, "delta": "context.",
		})
		s.notify(appServerNotifyAgentMessageDelta, map[string]any{
			"threadId": threadID, "turnId": "turn-1", "itemId": "item-msg", "delta": "I'll ",
		})
		s.notify(appServerNotifyAgentMessageDelta, map[string]any{
			"threadId": threadID, "turnId": "turn-1", "itemId": "item-msg", "delta": "check ",
		})
		s.notify(appServerNotifyAgentMessageDelta, map[string]any{
			"threadId": threadID, "turnId": "turn-1", "itemId": "item-msg", "delta": "the repo.",
		})
		s.notify(appServerNotifyItemStarted, map[string]any{
			"threadId": threadID, "turnId": "turn-1", "startedAtMs": 1750000000000,
			"item": map[string]any{
				"type": "commandExecution", "id": "item-cmd",
				"command": "ls -la", "cwd": "/workspace", "status": "inProgress",
			},
		})
		s.notify(appServerNotifyItemCompleted, map[string]any{
			"threadId": threadID, "turnId": "turn-1", "completedAtMs": 1750000001000,
			"item": map[string]any{
				"type": "commandExecution", "id": "item-cmd",
				"command": "ls -la", "cwd": "/workspace", "status": "completed",
				"aggregatedOutput": "README.md\n", "exitCode": 0,
			},
		})
		s.notify(appServerNotifyTokenUsage, map[string]any{
			"threadId": threadID, "turnId": "turn-1",
			"tokenUsage": map[string]any{
				"last":               map[string]any{"totalTokens": 1200, "inputTokens": 1000, "cachedInputTokens": 0, "outputTokens": 200, "reasoningOutputTokens": 50},
				"total":              map[string]any{"totalTokens": 1200, "inputTokens": 1000, "cachedInputTokens": 0, "outputTokens": 200, "reasoningOutputTokens": 50},
				"modelContextWindow": 272000,
			},
		})
		s.notify(appServerNotifyPlanUpdated, map[string]any{
			"threadId": threadID, "turnId": "turn-1",
			"plan": []any{
				map[string]any{"step": "Inspect repo", "status": "completed"},
				map[string]any{"step": "Run tests", "status": "inProgress"},
			},
		})
		s.mu.Lock()
		threadName := s.threadName
		s.mu.Unlock()
		if threadName == "" {
			threadName = "Inspect repository structure"
		}
		s.notify(appServerNotifyThreadNameUpdated, map[string]any{
			"threadId": threadID, "threadName": threadName,
		})
		if hold {
			return true
		}
		s.completePendingTurn(threadID)
	case appServerMethodTurnInterrupt:
		s.mu.Lock()
		threadID := asString(message.Params["threadId"])
		if threadID == "codex-thread-1" {
			s.turnStatus = "interrupted"
		}
		ignore := s.ignoreInterrupt
		hang := s.hangInterrupt
		mismatchTurnID := s.interruptTurnIDMismatch
		requestedTurnID := asString(message.Params["turnId"])
		s.interruptAttempts = append(s.interruptAttempts, requestedTurnID)
		s.mu.Unlock()
		if hang {
			// Fully wedged codex: never even acknowledge the interrupt RPC.
			return true
		}
		if mismatchTurnID != "" && requestedTurnID != mismatchTurnID {
			// Mirror codex rejecting a stale expected turn id (live
			// -32600 "invalid request" shape): the client's own turn
			// bookkeeping raced ahead of what codex still considers
			// active (e.g. a slow-to-terminate wait_agent call kept the
			// real turn alive past our local cancel). Only the retry
			// against the reported id (mismatchTurnID) is honored.
			s.sendJSON(map[string]any{
				"id": message.ID,
				"error": map[string]any{
					"code": -32600,
					"message": fmt.Sprintf(
						"expected active turn id %s but found %s", requestedTurnID, mismatchTurnID,
					),
				},
			})
			return true
		}
		s.sendJSON(map[string]any{"id": message.ID, "result": map[string]any{}})
		if ignore {
			// Wedged codex: it acks the interrupt but never completes the turn.
			return true
		}
		s.completePendingTurn(threadID)
	case appServerMethodTurnSteer:
		s.mu.Lock()
		hang := s.hangSteer
		s.mu.Unlock()
		if hang {
			return true
		}
		s.sendJSON(map[string]any{"id": message.ID, "result": map[string]any{"turnId": "turn-1"}})
	case appServerMethodThreadCompact:
		s.sendJSON(map[string]any{"id": message.ID, "result": map[string]any{}})
		// The real app-server runs compaction as a full turn and streams
		// turn/started → item/started → item/completed → turn/completed.
		s.notify(appServerNotifyTurnStarted, map[string]any{
			"threadId": "codex-thread-1",
			"turn":     map[string]any{"id": "turn-compact", "status": "inProgress", "items": []any{}},
		})
		if !s.compactSilent {
			s.notify(appServerNotifyItemStarted, map[string]any{
				"threadId": "codex-thread-1", "turnId": "turn-compact",
				"item": map[string]any{"type": "contextCompaction", "id": "item-compact", "status": "inProgress"},
			})
			s.notify(appServerNotifyItemCompleted, map[string]any{
				"threadId": "codex-thread-1", "turnId": "turn-compact",
				"item": map[string]any{"type": "contextCompaction", "id": "item-compact", "status": "completed"},
			})
		}
		s.notify(appServerNotifyTurnCompleted, map[string]any{
			"threadId": "codex-thread-1",
			"turn":     map[string]any{"id": "turn-compact", "status": "completed", "items": []any{}},
		})
	default:
		return false
	}
	return true
}

// completePendingTurn finishes the in-flight turn the way the real
// app-server does: with a turn/completed notification carrying the final
// turn payload (the turn/start RPC already responded immediately).
func (s *fakeCodexAppServer) completePendingTurn(threadIDs ...string) {
	s.mu.Lock()
	status := firstNonEmpty(s.turnStatus, "completed")
	turnError := s.turnError
	s.mu.Unlock()
	threadID := "codex-thread-1"
	if len(threadIDs) > 0 {
		threadID = firstNonEmpty(threadIDs[0], threadID)
	}
	turn := map[string]any{
		"id":     "turn-1",
		"status": status,
		"items": []any{
			map[string]any{"type": "agentMessage", "id": "item-msg", "text": "I'll check the repo."},
		},
	}
	if turnError != nil {
		turn["error"] = turnError
	}
	s.notify(appServerNotifyTurnCompleted, map[string]any{
		"threadId": threadID,
		"turn":     turn,
	})
}
