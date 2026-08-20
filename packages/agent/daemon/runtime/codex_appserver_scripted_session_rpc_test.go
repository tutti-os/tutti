package agentruntime

import (
	"slices"
	"time"
)

type scriptedSessionState struct {
	modelList                       []any
	userAgent                       string
	forkChildThreadID               string
	forkedFromThreadID              string
	omitForkedFromThreadID          bool
	emptyForkedFromThreadID         bool
	forkResponseLastTurnID          string
	forkResponseTurnIDs             []string
	forkNotificationBeforeResponse  bool
	forkResponseDelay               time.Duration
	threadReadTurnIDs               []string
	forkRPCError                    bool
	requiresAuth                    bool
	collaborationModeUnsupported    bool
	accountReadError                bool
	accountReadErrorCode            int
	accountReadErrorMessage         string
	rateLimitsReadError             bool
	rateLimitsReadErrorCode         int
	rateLimitsReadErrorMessage      string
	childNicknames                  map[string]string
	historyTurns                    []any
	rollbackHistoryTurns            []any
	rollbackUnsupported             bool
	threadName                      string
	replayTokenUsageOnResume        bool
	threadResumeError               bool
	mcpAuthStderrOnStart            bool
	mcpAuthStderrOnResume           bool
	mcpAuthStderrStartResponse      bool
	mcpAuthStderrResumeResponse     bool
	mcpFailureResponseDelay         time.Duration
	mcpStartupStatusFailedOnStart   bool
	mcpStartupStatusFailedOnResume  bool
	mcpStartupStatusFailureResponse bool
	threadStartedOnStart            bool
	threadStartedOnResume           bool
	threadStartedResponse           bool
	extraRootsError                 bool
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
	case appServerMethodSkillsExtraRootsSet:
		if s.extraRootsError {
			s.sendJSON(map[string]any{
				"id":    message.ID,
				"error": map[string]any{"code": -32601, "message": "method not found"},
			})
			return true
		}
		s.sendJSON(map[string]any{
			"id":     message.ID,
			"result": map[string]any{},
		})
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
		if s.rateLimitsReadError {
			errorMessage := s.rateLimitsReadErrorMessage
			if errorMessage == "" {
				errorMessage = "rate limits backend unavailable"
			}
			errorCode := s.rateLimitsReadErrorCode
			if errorCode == 0 {
				errorCode = -32000
			}
			s.sendJSON(map[string]any{
				"id":    message.ID,
				"error": map[string]any{"code": errorCode, "message": errorMessage},
			})
			return true
		}
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
		mcpAuthStderrOnStart := s.mcpAuthStderrOnStart && message.Method == appServerMethodThreadStart
		mcpAuthStderrOnResume := s.mcpAuthStderrOnResume && message.Method == appServerMethodThreadResume
		mcpAuthStderrStartResponse := s.mcpAuthStderrStartResponse && message.Method == appServerMethodThreadStart
		mcpAuthStderrResumeResponse := s.mcpAuthStderrResumeResponse && message.Method == appServerMethodThreadResume
		mcpFailureResponseDelay := s.mcpFailureResponseDelay
		mcpStartupStatusFailed := (s.mcpStartupStatusFailedOnStart && message.Method == appServerMethodThreadStart) ||
			(s.mcpStartupStatusFailedOnResume && message.Method == appServerMethodThreadResume)
		mcpStartupStatusFailureResponse := s.mcpStartupStatusFailureResponse
		threadStarted := (s.threadStartedOnStart && message.Method == appServerMethodThreadStart) ||
			(s.threadStartedOnResume && message.Method == appServerMethodThreadResume)
		threadStartedResponse := s.threadStartedResponse
		replayTokenUsage := s.replayTokenUsageOnResume && message.Method == appServerMethodThreadResume
		s.mu.Unlock()
		mcpAuthStderr := mcpAuthStderrOnStart || mcpAuthStderrOnResume
		mcpAuthStderrResponse := (mcpAuthStderrOnStart && mcpAuthStderrStartResponse) ||
			(mcpAuthStderrOnResume && mcpAuthStderrResumeResponse)
		if mcpAuthStderr {
			s.sendStderr([]byte(`rmcp::transport::worker: worker quit with fatal: Transport channel closed, when AuthRequired(AuthRequiredError { www_authenticate_header: "Bearer resource_metadata=\"https://mcp.figma.com/.well-known/oauth-protected-resource\",scope=\"mcp:connect\"" })`))
			if !mcpAuthStderrResponse {
				return true
			}
		}
		if mcpStartupStatusFailed {
			s.notify(appServerNotifyMCPServerStartupStatusUpdated, map[string]any{
				"threadId":      "codex-thread-1",
				"name":          "figma",
				"status":        "failed",
				"failureReason": "reauthenticationRequired",
				"error":         "MCP server requires authentication",
			})
			if !mcpStartupStatusFailureResponse {
				return true
			}
		}
		if threadResumeError {
			s.sendJSON(map[string]any{
				"id":    message.ID,
				"error": map[string]any{"code": -32000, "message": "resume rejected by test"},
			})
			return true
		}
		if threadStarted {
			s.notify(appServerNotifyThreadStarted, map[string]any{
				"thread": map[string]any{"id": "codex-thread-1"},
			})
			if !threadStartedResponse {
				return true
			}
		}
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
		response := map[string]any{
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
		}
		if (mcpAuthStderr || mcpStartupStatusFailed) && mcpFailureResponseDelay > 0 {
			go func() {
				time.Sleep(mcpFailureResponseDelay)
				s.sendJSON(response)
			}()
			return true
		}
		s.sendJSON(response)
		if !threadStarted {
			s.notify(appServerNotifyThreadStarted, map[string]any{
				"thread": map[string]any{"id": "codex-thread-1"},
			})
		}
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
		if s.forkNotificationBeforeResponse {
			s.notify(appServerNotifyThreadNameUpdated, map[string]any{
				"threadId":   childThreadID,
				"threadName": "Early Side title",
			})
		}
		s.mu.Lock()
		forkResponseDelay := s.forkResponseDelay
		s.mu.Unlock()
		response := map[string]any{
			"id": message.ID,
			"result": map[string]any{
				"thread": thread,
			},
		}
		if forkResponseDelay > 0 {
			go func() {
				time.Sleep(forkResponseDelay)
				s.sendJSON(response)
			}()
			return true
		}
		s.sendJSON(response)
	case appServerMethodThreadInjectItems:
		s.sendJSON(map[string]any{
			"id":     message.ID,
			"result": map[string]any{},
		})
	case appServerMethodThreadUnsubscribe:
		s.sendJSON(map[string]any{
			"id":     message.ID,
			"result": map[string]any{"status": "unsubscribed"},
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
