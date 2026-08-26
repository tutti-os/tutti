package agentruntime

import (
	"encoding/json"
	"maps"
)

func (c *standardACPConnection) streamSelectedPromptResult(promptID json.RawMessage) bool {
	if c.promptResultUpdates == nil {
		return false
	}
	for _, update := range c.promptResultUpdates {
		c.sendJSON(map[string]any{
			"jsonrpc": "2.0",
			"method":  acpMethodUpdate,
			"params": map[string]any{
				"sessionId": c.sessionID,
				"update":    update,
			},
		})
	}
	c.sendJSON(map[string]any{
		"jsonrpc": "2.0",
		"id":      promptID,
		"result":  map[string]any{"stopReason": "end_turn"},
	})
	return true
}

func (c *standardACPConnection) streamPromptResult(promptID json.RawMessage) {
	c.sendJSON(map[string]any{
		"jsonrpc": "2.0",
		"method":  acpMethodUpdate,
		"params": map[string]any{
			"sessionId": c.sessionID,
			"update": map[string]any{
				"sessionUpdate": "session_info_update",
				"title":         "Inspect workspace state",
			},
		},
	})
	c.sendJSON(map[string]any{
		"jsonrpc": "2.0",
		"method":  acpMethodUpdate,
		"params": map[string]any{
			"sessionId": c.sessionID,
			"update": map[string]any{
				"sessionUpdate": "agent_thought_chunk",
				"content": map[string]any{
					"type": "text",
					"text": "Need more context.",
				},
			},
		},
	})
	c.sendJSON(map[string]any{
		"jsonrpc": "2.0",
		"method":  acpMethodUpdate,
		"params": map[string]any{
			"sessionId": c.sessionID,
			"update": map[string]any{
				"sessionUpdate": "tool_call",
				"toolCallId":    "tool-1",
				"title":         "Read workspace files",
				"kind":          "execute",
				"status":        "pending",
				"rawInput": map[string]any{
					"path": "/workspace/room-1",
				},
			},
		},
	})
	if !c.omitAssistantTextInPromptResults {
		c.sendJSON(map[string]any{
			"jsonrpc": "2.0",
			"method":  acpMethodUpdate,
			"params": map[string]any{
				"sessionId": c.sessionID,
				"update": map[string]any{
					"sessionUpdate": "agent_message_chunk",
					"content": map[string]any{
						"type": "text",
						"text": "Inspecting files.",
					},
				},
			},
		})
	}
	if c.pauseBeforeToolCallCompletion != nil {
		<-c.pauseBeforeToolCallCompletion
	}
	c.sendJSON(map[string]any{
		"jsonrpc": "2.0",
		"method":  acpMethodUpdate,
		"params": map[string]any{
			"sessionId": c.sessionID,
			"update": map[string]any{
				"sessionUpdate": "tool_call_update",
				"toolCallId":    "tool-1",
				"title":         "Read workspace files",
				"kind":          "execute",
				"status":        "completed",
				"rawOutput": map[string]any{
					"filesRead": 3,
				},
			},
		},
	})
	if c.pauseBeforePromptResult != nil {
		<-c.pauseBeforePromptResult
	}
	result := map[string]any{
		"stopReason": "end_turn",
	}
	if len(c.promptFinalContent) > 0 {
		result["content"] = c.promptFinalContent
	}
	c.sendJSON(map[string]any{
		"jsonrpc": "2.0",
		"id":      promptID,
		"result":  result,
	})
}

func (c *standardACPConnection) permissionOptionID() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.selectedPermissionOption
}

func (c *standardACPConnection) interactiveOutcome() map[string]any {
	c.mu.Lock()
	defer c.mu.Unlock()
	return clonePayload(c.selectedInteractiveResult)
}

func (c *standardACPConnection) interactiveError() *acpError {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.selectedInteractiveError == nil {
		return nil
	}
	copied := *c.selectedInteractiveError
	return &copied
}

func (c *standardACPConnection) promptRequest() (map[string]any, []map[string]any) {
	switch c.promptKind {
	case "ask-user":
		return map[string]any{
			"toolCallId": "interactive-ask-1",
			"title":      "AskUserQuestion",
			"input": map[string]any{
				"questions": []map[string]any{{
					"id":       "render-path",
					"header":   "Renderer",
					"question": "Which renderer should we use?",
					"options": []map[string]any{
						{"label": "Renderer A", "description": "Shared transcript renderer"},
						{"label": "Renderer B", "description": "Legacy room renderer"},
					},
				}},
			},
		}, nil
	case "ask-user-after-permission",
		"ask-user-after-permission-multi-question",
		"ask-user-after-permission-multi-select":
		return map[string]any{
				"toolCallId": "interactive-ask-1",
				"title":      "AskUserQuestion",
			}, []map[string]any{
				{"optionId": "q0_opt_0", "name": "很好", "kind": "allow_once"},
				{"optionId": "q0_opt_1", "name": "一般", "kind": "allow_once"},
				{"optionId": "q0_opt_2", "name": "不太好", "kind": "allow_once"},
				{"optionId": "q0_skip", "name": "Skip", "kind": "reject_once"},
			}
	case "approval-after-permission":
		return map[string]any{"toolCallId": "read-file-1", "title": "Read file", "kind": "read"}, []map[string]any{
			{"optionId": "allow", "label": "Allow", "kind": "allow_once"},
			{"optionId": "reject", "label": "Reject", "kind": "reject_once"},
		}
	case "exit-plan":
		return map[string]any{
			"toolCallId": "interactive-plan-1",
			"title":      "ExitPlanMode",
			"input": map[string]any{
				"plan": "Implement the shared renderer",
			},
		}, nil
	default:
		return map[string]any{
				"toolCallId": "approval-1",
				"title":      "Allow Bash",
			}, []map[string]any{
				{"optionId": "allow", "label": "Allow", "kind": "allow_once"},
				{"optionId": "reject", "label": "Reject", "kind": "reject_once"},
			}
	}
}

func (c *standardACPConnection) askUserQuestionsAfterPermission() []any {
	first := map[string]any{
		"header":      "心情",
		"question":    "你今天心情怎么样？",
		"multiSelect": c.promptKind == "ask-user-after-permission-multi-select",
		"options": []any{
			map[string]any{"label": "很好", "description": "精神饱满，充满活力"},
			map[string]any{"label": "一般", "description": "状态平稳，可以正常进行工作"},
			map[string]any{"label": "不太好", "description": "有些疲惫或注意力分散，需要调整"},
		},
	}
	questions := []any{first}
	if c.promptKind == "ask-user-after-permission-multi-question" {
		questions = append(questions, map[string]any{
			"header":   "安排",
			"question": "接下来做什么？",
			"options":  []any{map[string]any{"label": "继续"}, map[string]any{"label": "休息"}},
		})
	}
	return questions
}

func (c *standardACPConnection) lastModeID() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.appliedModeID
}

func (c *standardACPConnection) lastPromptParams() map[string]any {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.lastPromptParamsSnapshot == nil {
		return nil
	}
	return maps.Clone(c.lastPromptParamsSnapshot)
}

func (c *standardACPConnection) lastSetModeParams() map[string]any {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.lastSetModeParamsSnapshot == nil {
		return nil
	}
	return maps.Clone(c.lastSetModeParamsSnapshot)
}

func (c *standardACPConnection) closeSessionParams() map[string]any {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.lastCloseSessionParams == nil {
		return nil
	}
	return maps.Clone(c.lastCloseSessionParams)
}

func (c *standardACPConnection) authenticatedMethodID() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.lastAuthenticatedMethodID
}

//nolint:unused // Retain the migrated connection snapshot for focused transport tests.
func (c *standardACPConnection) lastInitializeParams() map[string]any {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.lastInitializeParamsSnapshot == nil {
		return nil
	}
	return maps.Clone(c.lastInitializeParamsSnapshot)
}

func (c *standardACPConnection) setConfigOptionCalls() []map[string]any {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.setConfigOptionSnapshots) == 0 {
		return nil
	}
	out := make([]map[string]any, 0, len(c.setConfigOptionSnapshots))
	for _, snapshot := range c.setConfigOptionSnapshots {
		out = append(out, maps.Clone(snapshot))
	}
	return out
}

func (c *standardACPConnection) setModelCalls() []map[string]any {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.setModelSnapshots) == 0 {
		return nil
	}
	out := make([]map[string]any, 0, len(c.setModelSnapshots))
	for _, snapshot := range c.setModelSnapshots {
		out = append(out, clonePayload(snapshot))
	}
	return out
}

func (c *standardACPConnection) closed() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.isClosed
}
