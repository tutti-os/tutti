package agentruntime

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
)

func readSessionTestdataJSON(t *testing.T, name string) map[string]any {
	t.Helper()

	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	path := filepath.Clean(filepath.Join(filepath.Dir(file), "testdata", name))
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read session testdata %s: %v", path, err)
	}
	var body map[string]any
	if err := json.Unmarshal(raw, &body); err != nil {
		t.Fatalf("unmarshal session testdata %s: %v", path, err)
	}
	return body
}

func testSession() Session {
	return Session{
		RoomID:            "room-1",
		AgentSessionID:    "agent-session-1",
		Provider:          ProviderNexight,
		ProviderSessionID: "agent-session-1",
		CWD:               "/workspace/room-1",
		Status:            SessionStatusReady,
	}
}

type scriptedACPTransport struct {
	mu    sync.Mutex
	specs []ProcessSpec
	conn  *scriptedACPConnection
}

func newScriptedACPTransport() *scriptedACPTransport {
	return &scriptedACPTransport{conn: &scriptedACPConnection{
		recv:                   make(chan ProcessFrame, 32),
		supportsSessionRestore: true,
		respondSetMode:         true,
	}}
}

func (t *scriptedACPTransport) Start(_ context.Context, spec ProcessSpec) (ProcessConnection, error) {
	t.mu.Lock()
	t.specs = append(t.specs, spec)
	t.mu.Unlock()
	return t.conn, nil
}

type scriptedACPConnection struct {
	mu                         sync.Mutex
	sent                       [][]byte
	setConfigOptionSnapshots   []map[string]any
	configOptions              []map[string]any
	recv                       chan ProcessFrame
	supportsSessionRestore     bool
	respondSetMode             bool
	authRequiredOnNewSession   bool
	commandUpdateOnNewSession  bool
	commandUpdateOnLoadSession bool
	loadSessionError           *acpError
	promptPermission           bool
	promptKind                 string
	pauseBeforePromptResult    chan struct{}
	promptFinalContent         string
	pendingPermissionPromptID  json.RawMessage
	selectedPermissionOption   string
	selectedInteractiveResult  map[string]any
	appServerTurnStatus        string
}

func (c *scriptedACPConnection) Send(data []byte) error {
	c.mu.Lock()
	c.sent = append(c.sent, append([]byte(nil), data...))
	c.mu.Unlock()

	for _, line := range acpScanLines(data) {
		var message struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Result json.RawMessage `json:"result"`
		}
		_ = json.Unmarshal([]byte(line), &message)
		if c.handleAppServerMessage(line, message.ID, message.Method) {
			continue
		}
		switch message.Method {
		case acpMethodInitialize:
			result := map[string]any{
				"protocolVersion": acpProtocolVersion,
				"agentInfo": map[string]any{
					"name":  "codex-acp",
					"title": "Codex",
				},
			}
			if c.supportsSessionRestore {
				result["agentCapabilities"] = map[string]any{
					"loadSession": true,
				}
			}
			c.sendJSON(map[string]any{
				"jsonrpc": "2.0",
				"id":      message.ID,
				"result":  result,
			})
		case acpMethodNewSession:
			if c.authRequiredOnNewSession {
				c.sendJSON(map[string]any{
					"jsonrpc": "2.0",
					"id":      message.ID,
					"error": map[string]any{
						"code":    -32001,
						"message": "auth required",
						"data": map[string]any{
							"authRequired": true,
						},
					},
				})
				return nil
			}
			if c.commandUpdateOnNewSession {
				c.sendAvailableCommandsUpdate()
			}
			c.sendJSON(map[string]any{
				"jsonrpc": "2.0",
				"id":      message.ID,
				"result": map[string]any{
					"sessionId":     "codex-acp-session-1",
					"configOptions": c.defaultConfigOptions(),
				},
			})
		case acpMethodLoadSession, acpMethodResume:
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
			c.sendJSON(map[string]any{
				"jsonrpc": "2.0",
				"id":      message.ID,
				"result": map[string]any{
					"configOptions": c.defaultConfigOptions(),
				},
			})
		case acpMethodSetMode:
			if c.respondSetMode {
				c.sendJSON(map[string]any{
					"jsonrpc": "2.0",
					"id":      message.ID,
					"result":  map[string]any{},
				})
			}
		case acpMethodSetConfigOption:
			var request struct {
				Params map[string]any `json:"params"`
			}
			_ = json.Unmarshal([]byte(line), &request)
			c.mu.Lock()
			c.setConfigOptionSnapshots = append(c.setConfigOptionSnapshots, clonePayload(request.Params))
			c.mu.Unlock()
			c.sendJSON(map[string]any{
				"jsonrpc": "2.0",
				"id":      message.ID,
				"result":  map[string]any{},
			})
		case acpMethodPrompt:
			if c.promptPermission || c.promptKind != "" {
				c.mu.Lock()
				c.pendingPermissionPromptID = append(json.RawMessage(nil), message.ID...)
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
				return nil
			}
			if c.pauseBeforePromptResult != nil {
				<-c.pauseBeforePromptResult
			}
			c.sendJSON(map[string]any{
				"jsonrpc": "2.0",
				"method":  acpMethodUpdate,
				"params": map[string]any{
					"sessionId": "codex-acp-session-1",
					"update": map[string]any{
						"sessionUpdate": "tool_call",
						"toolCallId":    "tool-1",
						"title":         "Reading files",
						"kind":          "read",
						"status":        "in_progress",
					},
				},
			})
			c.sendJSON(map[string]any{
				"jsonrpc": "2.0",
				"method":  acpMethodUpdate,
				"params": map[string]any{
					"sessionId": "codex-acp-session-1",
					"update": map[string]any{
						"sessionUpdate": "session_info_update",
						"title":         "Inspect repository structure",
					},
				},
			})
			c.sendJSON(map[string]any{
				"jsonrpc": "2.0",
				"method":  acpMethodUpdate,
				"params": map[string]any{
					"sessionId": "codex-acp-session-1",
					"update": map[string]any{
						"sessionUpdate": "agent_thought_chunk",
						"content": map[string]any{
							"type": "text",
							"text": "Need ",
						},
					},
				},
			})
			c.sendJSON(map[string]any{
				"jsonrpc": "2.0",
				"method":  acpMethodUpdate,
				"params": map[string]any{
					"sessionId": "codex-acp-session-1",
					"update": map[string]any{
						"sessionUpdate": "agent_thought_chunk",
						"content": map[string]any{
							"type": "text",
							"text": "context.",
						},
					},
				},
			})
			c.sendJSON(map[string]any{
				"jsonrpc": "2.0",
				"method":  acpMethodUpdate,
				"params": map[string]any{
					"sessionId": "codex-acp-session-1",
					"update": map[string]any{
						"sessionUpdate": "agent_message_chunk",
						"content": map[string]any{
							"type": "text",
							"text": "I'll ",
						},
					},
				},
			})
			c.sendJSON(map[string]any{
				"jsonrpc": "2.0",
				"method":  acpMethodUpdate,
				"params": map[string]any{
					"sessionId": "codex-acp-session-1",
					"update": map[string]any{
						"sessionUpdate": "agent_message_chunk",
						"content": map[string]any{
							"type": "text",
							"text": "check ",
						},
					},
				},
			})
			c.sendJSON(map[string]any{
				"jsonrpc": "2.0",
				"method":  acpMethodUpdate,
				"params": map[string]any{
					"sessionId": "codex-acp-session-1",
					"update": map[string]any{
						"sessionUpdate": "agent_message_chunk",
						"content": map[string]any{
							"type": "text",
							"text": "the repo.",
						},
					},
				},
			})
			result := map[string]any{
				"stopReason": "end_turn",
			}
			if strings.TrimSpace(c.promptFinalContent) != "" {
				result["content"] = []map[string]any{{
					"type": "text",
					"text": c.promptFinalContent,
				}}
			}
			c.sendJSON(map[string]any{
				"jsonrpc": "2.0",
				"id":      message.ID,
				"result":  result,
			})
		default:
			if (c.promptPermission || c.promptKind != "") && acpRequestID(message.ID) == "permission-1" {
				var response struct {
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
					"payload":  response.Result.Outcome.Payload,
				}
				promptID := append(json.RawMessage(nil), c.pendingPermissionPromptID...)
				c.mu.Unlock()
				c.sendJSON(map[string]any{
					"jsonrpc": "2.0",
					"id":      promptID,
					"result": map[string]any{
						"stopReason": "end_turn",
					},
				})
			}
		}
	}
	return nil
}

// handleAppServerMessage lets the shared scripted connection answer the codex
// app-server protocol next to ACP, so controller tests can exercise the
// app-server-backed codex adapter with the same fake. Returns true when the
// message was consumed.
func (c *scriptedACPConnection) handleAppServerMessage(line string, id json.RawMessage, method string) bool {
	switch method {
	case appServerMethodInitialized:
		return true
	case appServerMethodAccountRead:
		requiresAuth := c.authRequiredOnNewSession
		result := map[string]any{
			"requiresOpenaiAuth": requiresAuth,
		}
		if !requiresAuth {
			result["account"] = map[string]any{"type": "chatgpt", "planType": "pro"}
		}
		c.sendJSON(map[string]any{"id": id, "result": result})
		return true
	case appServerMethodModelList:
		c.sendJSON(map[string]any{"id": id, "result": map[string]any{"data": []any{}}})
		return true
	case appServerMethodRateLimitsRead:
		c.sendJSON(map[string]any{"id": id, "result": map[string]any{"rateLimits": map[string]any{}}})
		return true
	case appServerMethodThreadStart:
		c.sendJSON(map[string]any{
			"id": id,
			"result": map[string]any{
				"thread": map[string]any{"id": "codex-thread-1"},
			},
		})
		return true
	case appServerMethodThreadResume:
		var request struct {
			Params map[string]any `json:"params"`
		}
		_ = json.Unmarshal([]byte(line), &request)
		c.sendJSON(map[string]any{
			"id": id,
			"result": map[string]any{
				"thread": map[string]any{"id": asString(request.Params["threadId"])},
			},
		})
		return true
	case appServerMethodTurnStart:
		c.mu.Lock()
		c.appServerTurnStatus = "completed"
		c.mu.Unlock()
		// Mirror the real app-server: respond immediately with the
		// inProgress turn; output streams as notifications afterwards.
		c.sendJSON(map[string]any{
			"id": id,
			"result": map[string]any{
				"turn": map[string]any{"id": "turn-1", "status": "inProgress", "items": []any{}},
			},
		})
		c.sendJSON(map[string]any{
			"method": appServerNotifyTurnStarted,
			"params": map[string]any{
				"threadId": "codex-thread-1",
				"turn":     map[string]any{"id": "turn-1", "status": "inProgress", "items": []any{}},
			},
		})
		if c.promptPermission || c.promptKind != "" {
			c.sendJSON(map[string]any{
				"id":     "permission-1",
				"method": appServerMethodCommandApproval,
				"params": map[string]any{
					"threadId":    "codex-thread-1",
					"turnId":      "turn-1",
					"itemId":      "item-cmd",
					"command":     "make test",
					"cwd":         "/workspace",
					"startedAtMs": 1750000000000,
				},
			})
			return true
		}
		if c.pauseBeforePromptResult != nil {
			<-c.pauseBeforePromptResult
		}
		for _, delta := range []string{"Need ", "context."} {
			c.sendJSON(map[string]any{
				"method": appServerNotifyReasoningDelta,
				"params": map[string]any{
					"threadId": "codex-thread-1", "turnId": "turn-1",
					"itemId": "item-think", "contentIndex": 0, "delta": delta,
				},
			})
		}
		for _, delta := range []string{"I'll ", "check ", "the repo."} {
			c.sendJSON(map[string]any{
				"method": appServerNotifyAgentMessageDelta,
				"params": map[string]any{
					"threadId": "codex-thread-1", "turnId": "turn-1",
					"itemId": "item-msg", "delta": delta,
				},
			})
		}
		c.sendJSON(map[string]any{
			"method": appServerNotifyItemStarted,
			"params": map[string]any{
				"threadId": "codex-thread-1", "turnId": "turn-1", "startedAtMs": 1750000000000,
				"item": map[string]any{
					"type": "commandExecution", "id": "item-cmd",
					"command": "ls -la", "cwd": "/workspace", "status": "inProgress",
				},
			},
		})
		c.sendJSON(map[string]any{
			"method": appServerNotifyThreadNameUpdated,
			"params": map[string]any{
				"threadId":   "codex-thread-1",
				"threadName": "Inspect repository structure",
			},
		})
		c.completeAppServerTurn()
		return true
	case appServerMethodThreadGoalGet:
		c.sendJSON(map[string]any{
			"id":     id,
			"result": map[string]any{"goal": nil},
		})
		return true
	case appServerMethodTurnInterrupt:
		c.mu.Lock()
		c.appServerTurnStatus = "interrupted"
		c.mu.Unlock()
		c.sendJSON(map[string]any{"id": id, "result": map[string]any{}})
		c.completeAppServerTurn()
		return true
	case appServerMethodTurnSteer:
		c.sendJSON(map[string]any{"id": id, "result": map[string]any{"turnId": "turn-1"}})
		return true
	case appServerMethodThreadCompact:
		c.sendJSON(map[string]any{"id": id, "result": map[string]any{}})
		return true
	case appServerMethodThreadRollback:
		c.sendJSON(map[string]any{
			"id":     id,
			"result": map[string]any{"thread": map[string]any{"id": "codex-thread-1"}},
		})
		return true
	case appServerMethodReviewStart:
		c.sendJSON(map[string]any{
			"id": id,
			"result": map[string]any{
				"reviewThreadId": "codex-thread-1",
				"turn": map[string]any{
					"id": "turn-review", "status": "completed",
					"items": []any{map[string]any{"type": "agentMessage", "id": "item-review", "text": "Review finished."}},
				},
			},
		})
		return true
	case "":
		if acpRequestID(id) != "permission-1" {
			return false
		}
		var response struct {
			Result struct {
				Decision string `json:"decision"`
			} `json:"result"`
			Error json.RawMessage `json:"error"`
		}
		_ = json.Unmarshal([]byte(line), &response)
		if response.Result.Decision == "" {
			if len(response.Error) > 0 {
				// App-server approval rejected (for example on cancel); the
				// turn finishes through turn/interrupt instead.
				return true
			}
			return false
		}
		optionID := map[string]string{
			"accept":           "allow_once",
			"acceptForSession": "allow_always",
			"decline":          "reject_once",
			"cancel":           "reject_always",
		}[response.Result.Decision]
		c.mu.Lock()
		c.selectedPermissionOption = optionID
		c.mu.Unlock()
		c.completeAppServerTurn()
		return true
	default:
		return false
	}
}

// completeAppServerTurn finishes the in-flight app-server turn the way the
// real server does: with a turn/completed notification (the turn/start RPC
// already responded immediately).
func (c *scriptedACPConnection) completeAppServerTurn() {
	c.mu.Lock()
	status := firstNonEmpty(c.appServerTurnStatus, "completed")
	finalContent := firstNonEmpty(strings.TrimSpace(c.promptFinalContent), "I'll check the repo.")
	c.mu.Unlock()
	c.sendJSON(map[string]any{
		"method": appServerNotifyItemCompleted,
		"params": map[string]any{
			"threadId": "codex-thread-1", "turnId": "turn-1", "completedAtMs": 1750000001000,
			"item": map[string]any{
				"type": "commandExecution", "id": "item-cmd",
				"command": "ls -la", "cwd": "/workspace", "status": "completed",
				"aggregatedOutput": "README.md\n", "exitCode": 0,
			},
		},
	})
	c.sendJSON(map[string]any{
		"method": appServerNotifyTurnCompleted,
		"params": map[string]any{
			"threadId": "codex-thread-1",
			"turn": map[string]any{
				"id":     "turn-1",
				"status": status,
				"items": []any{
					map[string]any{"type": "agentMessage", "id": "item-msg", "text": finalContent},
				},
			},
		},
	})
}

func (c *scriptedACPConnection) Recv() (ProcessFrame, error) {
	frame, ok := <-c.recv
	if !ok {
		return ProcessFrame{}, io.EOF
	}
	return frame, nil
}

func (c *scriptedACPConnection) Close() error {
	close(c.recv)
	return nil
}

func (c *scriptedACPConnection) sendAvailableCommandsUpdate() {
	c.sendJSON(map[string]any{
		"jsonrpc": "2.0",
		"method":  acpMethodUpdate,
		"params": map[string]any{
			"sessionId": "codex-acp-session-1",
			"update": map[string]any{
				"sessionUpdate": "available_commands_update",
				"availableCommands": []any{
					map[string]any{
						"name":        "web",
						"description": "Search the web",
						"input": map[string]any{
							"hint": "query",
						},
					},
				},
			},
		},
	})
}

func (c *scriptedACPConnection) sendJSON(value any) {
	raw, _ := json.Marshal(value)
	raw = append(raw, '\n')
	c.recv <- ProcessFrame{Stdout: raw}
}

func (c *scriptedACPConnection) permissionOptionID() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.selectedPermissionOption
}

func (c *scriptedACPConnection) defaultConfigOptions() []map[string]any {
	c.mu.Lock()
	defer c.mu.Unlock()
	return cloneConfigOptionDescriptors(c.configOptions)
}

func (c *scriptedACPConnection) promptRequest() (map[string]any, []map[string]any) {
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
				"title":      "Run command",
			}, []map[string]any{{
				"optionId": "allow_once",
				"label":    "Allow once",
				"kind":     "allow_once",
			}, {
				"optionId": "reject",
				"label":    "No, continue without running",
				"kind":     "reject_once",
			}, {
				"optionId": "abort",
				"label":    "No, and tell Codex what to do differently",
				"kind":     "reject_once",
			}}
	}
}
