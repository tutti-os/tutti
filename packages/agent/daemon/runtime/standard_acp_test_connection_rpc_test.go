package agentruntime

import (
	"encoding/json"
	"maps"
	"strings"
)

func (c *standardACPConnection) Send(data []byte) error {
	for _, line := range acpScanLines(data) {
		var message struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
		}
		_ = json.Unmarshal([]byte(line), &message)
		switch message.Method {
		case acpMethodInitialize:
			var request struct {
				Params map[string]any `json:"params"`
			}
			_ = json.Unmarshal([]byte(line), &request)
			c.mu.Lock()
			if request.Params != nil {
				c.lastInitializeParamsSnapshot = maps.Clone(request.Params)
			}
			initializeError := c.initializeError
			c.mu.Unlock()
			if initializeError != nil {
				c.sendJSON(map[string]any{
					"jsonrpc": "2.0",
					"id":      message.ID,
					"error":   initializeError,
				})
				continue
			}
			result := map[string]any{
				"protocolVersion": acpProtocolVersion,
				"agentInfo": map[string]any{
					"name":  strings.ToLower(strings.ReplaceAll(c.agentTitle, " ", "-")),
					"title": c.agentTitle,
				},
			}
			sessionCapabilities := map[string]any{}
			if strings.EqualFold(c.agentTitle, "OpenCode") {
				sessionCapabilities["resume"] = true
			}
			if c.supportsLoadSession || strings.EqualFold(strings.TrimSpace(c.agentTitle), "OpenClaw") {
				sessionCapabilities["load"] = true
			}
			if c.supportsCloseSession {
				sessionCapabilities["close"] = true
			}
			if len(sessionCapabilities) > 0 {
				result["sessionCapabilities"] = sessionCapabilities
			}
			agentCapabilities := map[string]any{}
			if c.supportsAgentLoadSession {
				agentCapabilities["loadSession"] = true
			}
			if c.supportsHTTPMCP {
				agentCapabilities["mcpCapabilities"] = map[string]any{"http": true}
			}
			if len(agentCapabilities) > 0 {
				result["agentCapabilities"] = agentCapabilities
			}
			if len(c.authMethods) > 0 {
				result["authMethods"] = c.authMethods
			}
			c.sendJSON(map[string]any{
				"jsonrpc": "2.0",
				"id":      message.ID,
				"result":  result,
			})
		case acpMethodAuthenticate:
			var request struct {
				Params struct {
					MethodID string `json:"methodId"`
				} `json:"params"`
			}
			_ = json.Unmarshal([]byte(line), &request)
			if c.authenticateError != nil {
				c.sendJSON(map[string]any{
					"jsonrpc": "2.0",
					"id":      message.ID,
					"error":   c.authenticateError,
				})
				continue
			}
			c.mu.Lock()
			c.lastAuthenticatedMethodID = request.Params.MethodID
			c.mu.Unlock()
			result := c.authenticateResult
			if result == nil {
				result = map[string]any{}
			}
			c.sendJSON(map[string]any{
				"jsonrpc": "2.0",
				"id":      message.ID,
				"result":  result,
			})
		case acpMethodNewSession:
			var request struct {
				Params map[string]any `json:"params"`
			}
			_ = json.Unmarshal([]byte(line), &request)
			c.mu.Lock()
			if request.Params != nil {
				c.lastNewSessionParams = maps.Clone(request.Params)
			}
			c.newSessionCallCount++
			newSessionError := c.newSessionError
			if len(c.newSessionErrors) > 0 {
				newSessionError = c.newSessionErrors[0]
				c.newSessionErrors = c.newSessionErrors[1:]
			}
			c.mu.Unlock()
			if c.requireAuthentication && c.authenticatedMethodID() == "" {
				c.sendJSON(map[string]any{
					"jsonrpc": "2.0", "id": message.ID,
					"error": map[string]any{"code": -32000, "message": "authentication required"},
				})
				continue
			}
			if newSessionError != nil {
				c.sendJSON(map[string]any{
					"jsonrpc": "2.0", "id": message.ID, "error": newSessionError,
				})
				continue
			}
			if c.commandUpdateOnNewSession {
				c.sendAvailableCommandsUpdate()
			}
			result := map[string]any{
				"sessionId":     c.sessionID,
				"configOptions": c.defaultConfigOptions(),
			}
			if c.models != nil {
				result["models"] = clonePayload(c.models)
			}
			if c.modes != nil {
				result["modes"] = clonePayload(c.modes)
			}
			c.sendJSON(map[string]any{
				"jsonrpc": "2.0",
				"id":      message.ID,
				"result":  result,
			})
		case acpMethodLoadSession, acpMethodResume:
			var request struct {
				Params map[string]any `json:"params"`
			}
			_ = json.Unmarshal([]byte(line), &request)
			c.mu.Lock()
			if request.Params != nil {
				c.lastLoadSessionParams = maps.Clone(request.Params)
			}
			c.mu.Unlock()
			if c.commandUpdateOnLoadSession {
				c.sendAvailableCommandsUpdate()
			}
			if c.loadSessionError != nil {
				c.sendJSON(map[string]any{
					"jsonrpc": "2.0",
					"id":      message.ID,
					"error":   c.loadSessionError,
				})
				return nil
			}
			result := map[string]any{"configOptions": c.defaultConfigOptions()}
			if c.models != nil {
				result["models"] = clonePayload(c.models)
			}
			if c.modes != nil {
				result["modes"] = clonePayload(c.modes)
			}
			c.sendJSON(map[string]any{
				"jsonrpc": "2.0",
				"id":      message.ID,
				"result":  result,
			})
		case acpMethodCloseSession:
			var request struct {
				Params map[string]any `json:"params"`
			}
			_ = json.Unmarshal([]byte(line), &request)
			c.mu.Lock()
			if request.Params != nil {
				c.lastCloseSessionParams = maps.Clone(request.Params)
			}
			closeSessionError := c.closeSessionError
			closeSessionExits := c.closeSessionExits
			c.mu.Unlock()
			if closeSessionError != nil {
				c.sendJSON(map[string]any{
					"jsonrpc": "2.0",
					"id":      message.ID,
					"error":   closeSessionError,
				})
				return nil
			}
			c.sendJSON(map[string]any{
				"jsonrpc": "2.0",
				"id":      message.ID,
				"result":  map[string]any{},
			})
			if closeSessionExits {
				c.closeRecv()
			}
		case acpMethodSetMode:
			var request struct {
				Params map[string]any `json:"params"`
			}
			_ = json.Unmarshal([]byte(line), &request)
			c.mu.Lock()
			if request.Params != nil {
				if mid, ok := request.Params["modeId"].(string); ok {
					c.appliedModeID = mid
				}
				c.lastSetModeParamsSnapshot = maps.Clone(request.Params)
			}
			setModeError := c.setModeError
			started := c.pauseSettingsRPCStarted
			release := c.pauseSettingsRPCRelease
			c.mu.Unlock()
			if started != nil {
				select {
				case started <- struct{}{}:
				default:
				}
			}
			if release != nil {
				<-release
			}
			if setModeError != nil {
				c.sendJSON(map[string]any{
					"jsonrpc": "2.0",
					"id":      message.ID,
					"error":   setModeError,
				})
				return nil
			}
			c.sendJSON(map[string]any{
				"jsonrpc": "2.0",
				"id":      message.ID,
				"result":  map[string]any{},
			})
		case acpMethodSetModel:
			var request struct {
				Params map[string]any `json:"params"`
			}
			_ = json.Unmarshal([]byte(line), &request)
			c.mu.Lock()
			if request.Params != nil {
				c.setModelSnapshots = append(c.setModelSnapshots, clonePayload(request.Params))
			}
			result := map[string]any{}
			if c.models != nil {
				result["models"] = clonePayload(c.models)
			}
			setModelError := c.setModelError
			c.mu.Unlock()
			if setModelError != nil {
				c.sendJSON(map[string]any{
					"jsonrpc": "2.0",
					"id":      message.ID,
					"error":   setModelError,
				})
				return nil
			}
			c.sendJSON(map[string]any{
				"jsonrpc": "2.0",
				"id":      message.ID,
				"result":  result,
			})
		case "session/set_config_option":
			var request struct {
				Params map[string]any `json:"params"`
			}
			_ = json.Unmarshal([]byte(line), &request)
			c.mu.Lock()
			if request.Params != nil {
				c.setConfigOptionSnapshots = append(c.setConfigOptionSnapshots, maps.Clone(request.Params))
			}
			rejectModelValue := c.rejectModelValue
			started := c.pauseSettingsRPCStarted
			release := c.pauseSettingsRPCRelease
			c.mu.Unlock()
			if started != nil {
				select {
				case started <- struct{}{}:
				default:
				}
			}
			if release != nil {
				<-release
			}
			if rejectModelValue != "" && request.Params != nil {
				configID, _ := request.Params["configId"].(string)
				value, _ := request.Params["value"].(string)
				if configID == "model" && value == rejectModelValue {
					c.sendJSON(map[string]any{
						"jsonrpc": "2.0",
						"id":      message.ID,
						"error": &acpError{
							Code:    -32603,
							Message: "Internal error",
							Data:    json.RawMessage(`{"details":"Invalid value for config option model: ` + value + `"}`),
						},
					})
					return nil
				}
			}
			c.sendJSON(map[string]any{
				"jsonrpc": "2.0",
				"id":      message.ID,
				"result":  map[string]any{},
			})
		case acpMethodPrompt:
			var request struct {
				Params map[string]any `json:"params"`
			}
			_ = json.Unmarshal([]byte(line), &request)
			c.mu.Lock()
			if request.Params != nil {
				c.lastPromptParamsSnapshot = maps.Clone(request.Params)
				c.promptParamsSnapshots = append(c.promptParamsSnapshots, maps.Clone(request.Params))
			}
			c.promptCallCount++
			promptCall := c.promptCallCount
			c.mu.Unlock()
			if c.promptKind != "" {
				c.mu.Lock()
				c.pendingPermissionCallID = append(json.RawMessage(nil), message.ID...)
				c.mu.Unlock()
			}
			if c.promptKind == "cursor-ask-question" {
				c.sendJSON(map[string]any{
					"jsonrpc": "2.0",
					"id":      "cursor-ask-1",
					"method":  cursorACPMethodAskQuestion,
					"params": map[string]any{
						"toolCallId": "cursor-question-1",
						"title":      "Need a choice",
						"questions": []map[string]any{{
							"id":     "renderer",
							"prompt": "Which renderer should we use?",
							"options": []map[string]any{
								{"id": "modern", "label": "Modern"},
								{"id": "legacy", "label": "Legacy"},
							},
						}},
					},
				})
				return nil
			}
			if c.promptKind == "cursor-create-plan" {
				c.sendJSON(map[string]any{
					"jsonrpc": "2.0",
					"id":      "cursor-plan-1",
					"method":  cursorACPMethodCreatePlan,
					"params": map[string]any{
						"toolCallId": "cursor-plan-1",
						"name":       "Renderer plan",
						"overview":   "Use the shared renderer.",
						"plan":       "1. Update the renderer.\n2. Run tests.",
						"todos": []map[string]any{{
							"id": "todo-1", "content": "Update the renderer", "status": "pending",
						}},
					},
				})
				return nil
			}
			if c.planLimitPromptError {
				c.sendJSON(map[string]any{
					"jsonrpc": "2.0",
					"id":      message.ID,
					"error": map[string]any{
						"code":    -32000,
						"message": "Upgrade your plan to continue",
					},
				})
				return nil
			}
			if promptCall <= c.retriableErrorPrompts {
				c.mu.Lock()
				priorText := c.retriableErrorPriorText
				c.mu.Unlock()
				if priorText != "" {
					c.sendJSON(map[string]any{
						"jsonrpc": "2.0",
						"method":  acpMethodUpdate,
						"params": map[string]any{
							"sessionId": c.sessionID,
							"update": map[string]any{
								"sessionUpdate": "agent_message_chunk",
								"content": map[string]any{
									"type": "text",
									"text": priorText,
								},
							},
						},
					})
				}
				c.sendJSON(map[string]any{
					"jsonrpc": "2.0",
					"method":  acpMethodUpdate,
					"params": map[string]any{
						"sessionId": c.sessionID,
						"update": map[string]any{
							"sessionUpdate": "agent_message_chunk",
							"content": map[string]any{
								"type": "text",
								"text": "\n\nError: RetriableError: [canceled] http/2 stream closed with error code CANCEL (0x8)",
							},
						},
					},
				})
				c.sendJSON(map[string]any{
					"jsonrpc": "2.0",
					"id":      message.ID,
					"result":  map[string]any{"stopReason": "end_turn"},
				})
				return nil
			}
			if c.promptPermission || c.promptKind != "" {
				c.mu.Lock()
				c.pendingPermissionCallID = append(json.RawMessage(nil), message.ID...)
				c.mu.Unlock()
				toolCall, options := c.promptRequest()
				c.sendJSON(map[string]any{
					"jsonrpc": "2.0",
					"id":      "permission-1",
					"method":  acpMethodPermission,
					"params": map[string]any{
						"toolCall": toolCall,
						"options":  options,
					},
				})
				if strings.HasPrefix(c.promptKind, "ask-user-after-permission") {
					if c.pauseBeforeAskUserToolUpdate != nil {
						<-c.pauseBeforeAskUserToolUpdate
					}
					c.sendJSON(map[string]any{
						"jsonrpc": "2.0",
						"method":  acpMethodUpdate,
						"params": map[string]any{
							"sessionId": c.sessionID,
							"update": map[string]any{
								"sessionUpdate": "tool_call",
								"toolCallId":    "interactive-ask-1",
								"title":         "AskUserQuestion",
								"status":        "pending",
								"rawInput": map[string]any{
									"questions": c.askUserQuestionsAfterPermission(),
								},
							},
						},
					})
				}
				return nil
			}
			if c.emptyPromptResult {
				c.sendJSON(map[string]any{
					"jsonrpc": "2.0",
					"id":      message.ID,
					"result":  map[string]any{"stopReason": "end_turn"},
				})
				return nil
			}
			if c.streamSelectedPromptResult(message.ID) {
				return nil
			}
			c.streamPromptResult(message.ID)
		default:
			if (c.promptPermission || c.promptKind != "") &&
				(acpRequestID(message.ID) == "cursor-ask-1" || acpRequestID(message.ID) == "cursor-plan-1") {
				var response struct {
					Error  *acpError      `json:"error"`
					Result map[string]any `json:"result"`
				}
				_ = json.Unmarshal([]byte(line), &response)
				outcome := payloadObject(response.Result["outcome"])
				c.mu.Lock()
				c.selectedInteractiveResult = clonePayload(outcome)
				c.selectedInteractiveError = response.Error
				promptID := append(json.RawMessage(nil), c.pendingPermissionCallID...)
				c.mu.Unlock()
				c.streamPromptResult(promptID)
				continue
			}
			if (c.promptPermission || c.promptKind != "") && acpRequestID(message.ID) == "permission-1" {
				var response struct {
					Error  *acpError `json:"error"`
					Result struct {
						Outcome struct {
							OptionID string         `json:"optionId"`
							Outcome  string         `json:"outcome"`
							Payload  map[string]any `json:"payload"`
						} `json:"outcome"`
					} `json:"result"`
				}
				_ = json.Unmarshal([]byte(line), &response)
				c.mu.Lock()
				c.selectedPermissionOption = response.Result.Outcome.OptionID
				c.selectedInteractiveResult = map[string]any{
					"outcome":  response.Result.Outcome.Outcome,
					"optionId": response.Result.Outcome.OptionID,
					"payload":  clonePayload(response.Result.Outcome.Payload),
				}
				c.selectedInteractiveError = response.Error
				promptID := append(json.RawMessage(nil), c.pendingPermissionCallID...)
				c.mu.Unlock()
				c.streamPromptResult(promptID)
			}
		}
	}
	return nil
}

func (c *standardACPConnection) sendAvailableCommandsUpdate() {
	commands := c.availableCommands
	if len(commands) == 0 {
		commands = []AgentSessionCommand{{Name: "web", Description: "Search the web", InputHint: "query"}}
	}
	availableCommands := make([]any, 0, len(commands))
	for _, command := range commands {
		item := map[string]any{"name": command.Name}
		if command.Description != "" {
			item["description"] = command.Description
		}
		if command.InputHint != "" {
			item["input"] = map[string]any{"hint": command.InputHint}
		}
		availableCommands = append(availableCommands, item)
	}
	c.sendJSON(map[string]any{
		"jsonrpc": "2.0",
		"method":  acpMethodUpdate,
		"params": map[string]any{
			"sessionId": c.sessionID,
			"update": map[string]any{
				"sessionUpdate":     "available_commands_update",
				"availableCommands": availableCommands,
			},
		},
	})
}

func (c *standardACPConnection) sendConfigOptionsUpdate(key string, value string) {
	c.sendJSON(map[string]any{
		"jsonrpc": "2.0",
		"method":  acpMethodUpdate,
		"params": map[string]any{
			"sessionId": c.sessionID,
			"update": map[string]any{
				"sessionUpdate": "config_option_update",
				"key":           key,
				"value":         value,
				"configOptions": []any{
					map[string]any{
						"id":           key,
						"currentValue": value,
						"options": []any{
							map[string]any{"value": value, "name": value},
						},
					},
				},
			},
		},
	})
}

func (c *standardACPConnection) defaultConfigOptions() []map[string]any {
	if len(c.configOptions) > 0 {
		out := make([]map[string]any, 0, len(c.configOptions))
		for _, option := range c.configOptions {
			out = append(out, clonePayloadDeep(option))
		}
		return out
	}
	title := strings.TrimSpace(c.agentTitle)
	if strings.EqualFold(title, "OpenCode") || strings.EqualFold(title, "Hermes Agent") {
		return []map[string]any{
			{"id": "model"},
			{"id": "effort"},
		}
	}
	return nil
}
