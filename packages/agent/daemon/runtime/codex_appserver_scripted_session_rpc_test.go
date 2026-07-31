package agentruntime

import "slices"

type scriptedSessionState struct {
	modelList                    []any
	userAgent                    string
	forkChildThreadID            string
	forkedFromThreadID           string
	omitForkedFromThreadID       bool
	emptyForkedFromThreadID      bool
	forkResponseLastTurnID       string
	forkResponseTurnIDs          []string
	threadReadTurnIDs            []string
	forkRPCError                 bool
	requiresAuth                 bool
	collaborationModeUnsupported bool
	accountReadError             bool
	accountReadErrorCode         int
	accountReadErrorMessage      string
	childNicknames               map[string]string
	historyTurns                 []any
	rollbackHistoryTurns         []any
	rollbackUnsupported          bool
	threadName                   string
	replayTokenUsageOnResume     bool
	threadResumeError            bool
}

func (s *fakeCodexAppServer) handleSessionRPC(message scriptedAppServerMessage) bool {
	switch message.Method {
	case appServerMethodInitialize:
		s.sendJSON(map[string]any{
			"id": message.ID,
			"result": map[string]any{
				"userAgent":      firstNonEmpty(s.userAgent, "codex/0.137.0"),
				"codexHome":      "/home/user/.codex",
				"platformOs":     "macos",
				"platformFamily": "unix",
			},
		})
	case appServerMethodInitialized:
		// notification, no response
	case appServerMethodAccountRead:
		if s.accountReadError {
			errorMessage := s.accountReadErrorMessage
			if errorMessage == "" {
				errorMessage = "account backend unavailable"
			}
			errorCode := s.accountReadErrorCode
			if errorCode == 0 {
				errorCode = -32000
			}
			s.sendJSON(map[string]any{
				"id":    message.ID,
				"error": map[string]any{"code": errorCode, "message": errorMessage},
			})
			return true
		}
		if s.requiresAuth {
			s.sendJSON(map[string]any{
				"id": message.ID,
				"result": map[string]any{
					"account":            nil,
					"requiresOpenaiAuth": true,
				},
			})
			return true
		}
		s.sendJSON(map[string]any{
			"id": message.ID,
			"result": map[string]any{
				"account": map[string]any{
					"type":     "chatgpt",
					"email":    "dev@example.com",
					"planType": "pro",
				},
				"requiresOpenaiAuth": false,
			},
		})
	case appServerMethodCollaborationModeList:
		if s.collaborationModeUnsupported {
			s.sendJSON(map[string]any{
				"id":    message.ID,
				"error": map[string]any{"code": -32601, "message": "method not found"},
			})
			return true
		}
		s.sendJSON(map[string]any{
			"id": message.ID,
			"result": map[string]any{
				"data": []any{
					map[string]any{
						"name":                   "Plan",
						"mode":                   "plan",
						"model":                  nil,
						"reasoning_effort":       "medium",
						"developer_instructions": testAppServerPlanCollaborationInstructions,
					},
					map[string]any{
						"name":                   "Pair",
						"mode":                   "default",
						"model":                  nil,
						"reasoning_effort":       nil,
						"developer_instructions": testAppServerDefaultCollaborationInstructions,
					},
				},
			},
		})
	case appServerMethodModelList:
		s.mu.Lock()
		models := s.modelList
		s.mu.Unlock()
		if models == nil {
			models = []any{
				map[string]any{
					"id":                     "gpt-5.1-codex",
					"model":                  "gpt-5.1-codex",
					"displayName":            "GPT-5.1 Codex",
					"description":            "",
					"isDefault":              true,
					"hidden":                 false,
					"defaultReasoningEffort": "medium",
					"supportedReasoningEfforts": []any{
						map[string]any{"reasoningEffort": "low", "description": ""},
						map[string]any{"reasoningEffort": "medium", "description": ""},
						map[string]any{"reasoningEffort": "high", "description": ""},
					},
				},
				map[string]any{
					"id":                     "gpt-5.1-codex-mini",
					"model":                  "gpt-5.1-codex-mini",
					"displayName":            "GPT-5.1 Codex Mini",
					"description":            "",
					"isDefault":              false,
					"hidden":                 true,
					"defaultReasoningEffort": "medium",
					"supportedReasoningEfforts": []any{
						map[string]any{"reasoningEffort": "low", "description": ""},
						map[string]any{"reasoningEffort": "medium", "description": ""},
					},
				},
			}
		}
		s.sendJSON(map[string]any{
			"id": message.ID,
			"result": map[string]any{
				"data": models,
			},
		})
	case appServerMethodRateLimitsRead:
		s.sendJSON(map[string]any{
			"id": message.ID,
			"result": map[string]any{
				"rateLimits": map[string]any{
					"primary":   map[string]any{"usedPercent": 25, "resetsAt": 1750000000},
					"secondary": map[string]any{"usedPercent": 10},
				},
			},
		})
	case appServerMethodThreadStart, appServerMethodThreadResume:
		s.mu.Lock()
		threadResumeError := s.threadResumeError && message.Method == appServerMethodThreadResume
		replayTokenUsage := s.replayTokenUsageOnResume && message.Method == appServerMethodThreadResume
		s.mu.Unlock()
		if threadResumeError {
			s.sendJSON(map[string]any{
				"id":    message.ID,
				"error": map[string]any{"code": -32000, "message": "resume rejected by test"},
			})
			return true
		}
		s.notify(appServerNotifyThreadStarted, map[string]any{
			"thread": map[string]any{"id": "codex-thread-1"},
		})
		if replayTokenUsage {
			// Real codex 0.140.0 replays thread/tokenUsage/updated during
			// thread/resume so the GUI can show context fill before a new
			// turn runs (modelContextWindow at top level, last.inputTokens).
			s.notify(appServerNotifyTokenUsage, map[string]any{
				"tokenUsage": map[string]any{
					"modelContextWindow": 258400,
					"last":               map[string]any{"inputTokens": 20453, "totalTokens": 20473},
					"total":              map[string]any{"totalTokens": 20473},
				},
			})
		}
		s.sendJSON(map[string]any{
			"id": message.ID,
			"result": map[string]any{
				"thread":          map[string]any{"id": "codex-thread-1"},
				"model":           "gpt-5.1-codex",
				"reasoningEffort": "medium",
				"cwd":             "/workspace",
				"approvalPolicy":  "on-request",
				"sandbox":         map[string]any{"type": "workspaceWrite"},
				"modelProvider":   "openai",
			},
		})
	case appServerMethodThreadFork:
		if s.forkRPCError {
			s.sendJSON(map[string]any{
				"id": message.ID,
				"error": map[string]any{
					"code":    -32602,
					"message": "invalid lastTurnId",
				},
			})
			return true
		}
		childThreadID := firstNonEmpty(s.forkChildThreadID, "codex-thread-fork")
		forkedFromThreadID := firstNonEmpty(
			s.forkedFromThreadID,
			asString(message.Params["threadId"]),
		)
		lastTurnID := firstNonEmpty(
			s.forkResponseLastTurnID,
			asString(message.Params["lastTurnId"]),
		)
		turnIDs := append([]string(nil), s.forkResponseTurnIDs...)
		if len(turnIDs) == 0 {
			turnIDs = []string{lastTurnID}
		}
		turns := make([]any, 0, len(turnIDs))
		for _, turnID := range turnIDs {
			turns = append(turns, map[string]any{
				"id": turnID, "status": "completed",
			})
		}
		thread := map[string]any{
			"id":    childThreadID,
			"turns": turns,
		}
		if !s.omitForkedFromThreadID {
			if s.emptyForkedFromThreadID {
				thread["forkedFromId"] = ""
			} else {
				thread["forkedFromId"] = forkedFromThreadID
			}
		}
		s.sendJSON(map[string]any{
			"id": message.ID,
			"result": map[string]any{
				"thread": thread,
			},
		})
	case appServerMethodThreadRead:
		s.mu.Lock()
		nickname := s.childNicknames[asString(message.Params["threadId"])]
		turnIDs := append([]string(nil), s.threadReadTurnIDs...)
		historyTurns := slices.Clone(s.historyTurns)
		s.mu.Unlock()
		thread := map[string]any{"id": message.Params["threadId"]}
		if nickname != "" {
			thread["agentNickname"] = nickname
		}
		includeTurns, _ := message.Params["includeTurns"].(bool)
		if includeTurns {
			if len(historyTurns) > 0 {
				thread["turns"] = historyTurns
			} else {
				if len(turnIDs) == 0 {
					turnIDs = []string{"provider-turn-1", "provider-turn-2"}
				}
				turns := make([]any, 0, len(turnIDs))
				for _, turnID := range turnIDs {
					turns = append(turns, map[string]any{
						"id": turnID, "status": "completed",
					})
				}
				thread["turns"] = turns
			}
		}
		s.sendJSON(map[string]any{"id": message.ID, "result": map[string]any{"thread": thread}})
	case appServerMethodThreadRollback:
		s.mu.Lock()
		rollbackUnsupported := s.rollbackUnsupported
		rollbackHistoryTurns := slices.Clone(s.rollbackHistoryTurns)
		s.mu.Unlock()
		if rollbackUnsupported {
			s.sendJSON(map[string]any{
				"id": message.ID,
				"error": map[string]any{
					"code":    -32601,
					"message": "method not found: thread/rollback",
				},
			})
			return true
		}
		s.sendJSON(map[string]any{
			"id": message.ID,
			"result": map[string]any{"thread": map[string]any{
				"id":    "codex-thread-1",
				"turns": rollbackHistoryTurns,
			}},
		})
	default:
		return false
	}
	return true
}
