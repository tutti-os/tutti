//revive:disable:file-length-limit
package agentruntime

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	activityshared "github.com/tutti-os/tutti/packages/agentactivity/daemon/activity/events"
)

func testAppServerSession() Session {
	return Session{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderCodex,
		CWD:            "/workspace/room-1",
		Status:         SessionStatusReady,
	}
}

// --- scripted app-server transport ---

type scriptedAppServerTransport struct {
	mu    sync.Mutex
	specs []ProcessSpec
	conn  *scriptedAppServerConnection
}

func newScriptedAppServerTransport() *scriptedAppServerTransport {
	return &scriptedAppServerTransport{conn: newScriptedAppServerConnection()}
}

func newScriptedAppServerConnection() *scriptedAppServerConnection {
	return &scriptedAppServerConnection{
		recv:                     make(chan ProcessFrame, 128),
		goalCompletionAfterTurns: 1,
	}
}

func (t *scriptedAppServerTransport) Start(_ context.Context, spec ProcessSpec) (ProcessConnection, error) {
	t.mu.Lock()
	t.specs = append(t.specs, spec)
	t.mu.Unlock()
	return t.conn, nil
}

type scriptedAppServerConnection struct {
	mu   sync.Mutex
	sent [][]byte
	recv chan ProcessFrame

	requiresAuth                 bool
	collaborationModeUnsupported bool
	emitPlanItem                 bool
	accountReadError             bool
	turnStatus                   string // completed (default) | failed | interrupted
	turnError                    map[string]any
	holdTurn                     bool // do not finish the turn until released
	ignoreInterrupt              bool // ack turn/interrupt but never complete the turn (wedged codex)
	hangInterrupt                bool // never even acknowledge the turn/interrupt RPC (fully wedged codex)
	turnStartEntered             chan struct{}
	turnStartRelease             chan struct{}
	commandApproval              bool
	userInputRequest             bool
	reviewInline                 bool          // stream review output as inline reasoning/command items
	reviewInlineSummaryDelta     bool          // stream review reasoning via summaryTextDelta with empty completed summary
	reviewHang                   bool          // respond to review/start but never complete the turn
	reviewStartEntered           chan struct{} // closed once review/start has responded
	approvalResponse             map[string]any
	goal                         map[string]any
	goalStartsTurn               bool
	goalTurnsStarted             int
	goalCompletionAfterTurns     int
	goalCleared                  bool
	replayTokenUsageOnResume     bool // mirror real codex: emit token usage during thread/resume
	closeOnce                    sync.Once
}

func (c *scriptedAppServerConnection) sendJSON(value map[string]any) {
	raw, err := json.Marshal(value)
	if err != nil {
		return
	}
	c.recv <- ProcessFrame{Stdout: append(raw, '\n')}
}

func (c *scriptedAppServerConnection) notify(method string, params map[string]any) {
	c.sendJSON(map[string]any{"method": method, "params": params})
}

func (c *scriptedAppServerConnection) Recv() (ProcessFrame, error) {
	frame, ok := <-c.recv
	if !ok {
		return ProcessFrame{}, io.EOF
	}
	return frame, nil
}

func (c *scriptedAppServerConnection) Close() error {
	c.closeOnce.Do(func() { close(c.recv) })
	return nil
}

// completePendingTurn finishes the in-flight turn the way the real
// app-server does: with a turn/completed notification carrying the final
// turn payload (the turn/start RPC already responded immediately).
func (c *scriptedAppServerConnection) completePendingTurn() {
	c.mu.Lock()
	status := firstNonEmpty(c.turnStatus, "completed")
	turnError := c.turnError
	c.mu.Unlock()
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
	c.notify(appServerNotifyTurnCompleted, map[string]any{
		"threadId": "codex-thread-1",
		"turn":     turn,
	})
}

func (c *scriptedAppServerConnection) Send(data []byte) error {
	c.mu.Lock()
	c.sent = append(c.sent, append([]byte(nil), data...))
	c.mu.Unlock()

	for _, line := range acpScanLines(data) {
		var message struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Params map[string]any  `json:"params"`
			Result json.RawMessage `json:"result"`
			Error  json.RawMessage `json:"error"`
		}
		_ = json.Unmarshal([]byte(line), &message)
		switch message.Method {
		case appServerMethodInitialize:
			c.sendJSON(map[string]any{
				"id": message.ID,
				"result": map[string]any{
					"userAgent":      "codex/0.137.0",
					"codexHome":      "/home/user/.codex",
					"platformOs":     "macos",
					"platformFamily": "unix",
				},
			})
		case appServerMethodInitialized:
			// notification, no response
		case appServerMethodAccountRead:
			if c.accountReadError {
				c.sendJSON(map[string]any{
					"id":    message.ID,
					"error": map[string]any{"code": -32000, "message": "account backend unavailable"},
				})
				continue
			}
			if c.requiresAuth {
				c.sendJSON(map[string]any{
					"id": message.ID,
					"result": map[string]any{
						"account":            nil,
						"requiresOpenaiAuth": true,
					},
				})
				continue
			}
			c.sendJSON(map[string]any{
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
			if c.collaborationModeUnsupported {
				c.sendJSON(map[string]any{
					"id":    message.ID,
					"error": map[string]any{"code": -32601, "message": "method not found"},
				})
				continue
			}
			c.sendJSON(map[string]any{
				"id": message.ID,
				"result": map[string]any{
					"data": []any{
						map[string]any{
							"name":             "Plan",
							"mode":             "plan",
							"model":            nil,
							"reasoning_effort": "medium",
						},
						map[string]any{
							"name":             "Pair",
							"mode":             "default",
							"model":            nil,
							"reasoning_effort": nil,
						},
					},
				},
			})
		case appServerMethodModelList:
			c.sendJSON(map[string]any{
				"id": message.ID,
				"result": map[string]any{
					"data": []any{
						map[string]any{
							"id":                        "gpt-5.1-codex",
							"model":                     "gpt-5.1-codex",
							"displayName":               "GPT-5.1 Codex",
							"description":               "",
							"isDefault":                 true,
							"hidden":                    false,
							"defaultReasoningEffort":    "medium",
							"supportedReasoningEfforts": []any{"low", "medium", "high"},
						},
						map[string]any{
							"id":                        "gpt-5.1-codex-mini",
							"model":                     "gpt-5.1-codex-mini",
							"displayName":               "GPT-5.1 Codex Mini",
							"description":               "",
							"isDefault":                 false,
							"hidden":                    true,
							"defaultReasoningEffort":    "medium",
							"supportedReasoningEfforts": []any{"low", "medium"},
						},
					},
				},
			})
		case appServerMethodRateLimitsRead:
			c.sendJSON(map[string]any{
				"id": message.ID,
				"result": map[string]any{
					"rateLimits": map[string]any{
						"primary":   map[string]any{"usedPercent": 25, "resetsAt": 1750000000},
						"secondary": map[string]any{"usedPercent": 10},
					},
				},
			})
		case appServerMethodThreadStart, appServerMethodThreadResume:
			c.notify(appServerNotifyThreadStarted, map[string]any{
				"thread": map[string]any{"id": "codex-thread-1"},
			})
			c.mu.Lock()
			replayTokenUsage := c.replayTokenUsageOnResume && message.Method == appServerMethodThreadResume
			c.mu.Unlock()
			if replayTokenUsage {
				// Real codex 0.140.0 replays thread/tokenUsage/updated during
				// thread/resume so the GUI can show context fill before a new
				// turn runs (modelContextWindow at top level, last.inputTokens).
				c.notify(appServerNotifyTokenUsage, map[string]any{
					"tokenUsage": map[string]any{
						"modelContextWindow": 258400,
						"last":               map[string]any{"inputTokens": 20453, "totalTokens": 20473},
						"total":              map[string]any{"totalTokens": 20473},
					},
				})
			}
			c.sendJSON(map[string]any{
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
		case appServerMethodTurnStart:
			c.mu.Lock()
			hold := c.holdTurn
			approval := c.commandApproval
			userInput := c.userInputRequest
			emitPlan := c.emitPlanItem
			turnStartEntered := c.turnStartEntered
			turnStartRelease := c.turnStartRelease
			c.mu.Unlock()
			if turnStartEntered != nil {
				close(turnStartEntered)
			}
			if turnStartRelease != nil {
				<-turnStartRelease
			}
			// Mirror the real app-server: the RPC responds immediately with
			// the inProgress turn; output streams as notifications.
			c.sendJSON(map[string]any{
				"id": message.ID,
				"result": map[string]any{
					"turn": map[string]any{"id": "turn-1", "status": "inProgress", "items": []any{}},
				},
			})
			c.notify(appServerNotifyTurnStarted, map[string]any{
				"threadId": "codex-thread-1",
				"turn":     map[string]any{"id": "turn-1", "status": "inProgress", "items": []any{}},
			})
			if approval {
				c.sendJSON(map[string]any{
					"id":     "approval-1",
					"method": appServerMethodCommandApproval,
					"params": map[string]any{
						"threadId":    "codex-thread-1",
						"turnId":      "turn-1",
						"itemId":      "item-cmd",
						"command":     "rm -rf build",
						"cwd":         "/workspace",
						"reason":      "cleanup",
						"startedAtMs": 1750000000000,
					},
				})
				continue
			}
			if userInput {
				c.sendJSON(map[string]any{
					"id":     "question-1",
					"method": appServerMethodRequestUserInput,
					"params": map[string]any{
						"threadId": "codex-thread-1",
						"turnId":   "turn-1",
						"itemId":   "item-question",
						"questions": []any{
							map[string]any{"id": "q1", "question": "Which database?"},
						},
					},
				})
				continue
			}
			if emitPlan {
				c.notify(appServerNotifyItemCompleted, map[string]any{
					"threadId": "codex-thread-1",
					"turnId":   "turn-1",
					"item": map[string]any{
						"type": "plan",
						"id":   "item-plan-1",
						"text": "# Plan\n1. inspect\n2. fix",
					},
				})
			}
			c.notify(appServerNotifyReasoningDelta, map[string]any{
				"threadId": "codex-thread-1", "turnId": "turn-1", "itemId": "item-think",
				"contentIndex": 0, "delta": "Need ",
			})
			c.notify(appServerNotifyReasoningDelta, map[string]any{
				"threadId": "codex-thread-1", "turnId": "turn-1", "itemId": "item-think",
				"contentIndex": 0, "delta": "context.",
			})
			c.notify(appServerNotifyAgentMessageDelta, map[string]any{
				"threadId": "codex-thread-1", "turnId": "turn-1", "itemId": "item-msg", "delta": "I'll ",
			})
			c.notify(appServerNotifyAgentMessageDelta, map[string]any{
				"threadId": "codex-thread-1", "turnId": "turn-1", "itemId": "item-msg", "delta": "check ",
			})
			c.notify(appServerNotifyAgentMessageDelta, map[string]any{
				"threadId": "codex-thread-1", "turnId": "turn-1", "itemId": "item-msg", "delta": "the repo.",
			})
			c.notify(appServerNotifyItemStarted, map[string]any{
				"threadId": "codex-thread-1", "turnId": "turn-1", "startedAtMs": 1750000000000,
				"item": map[string]any{
					"type": "commandExecution", "id": "item-cmd",
					"command": "ls -la", "cwd": "/workspace", "status": "inProgress",
				},
			})
			c.notify(appServerNotifyItemCompleted, map[string]any{
				"threadId": "codex-thread-1", "turnId": "turn-1", "completedAtMs": 1750000001000,
				"item": map[string]any{
					"type": "commandExecution", "id": "item-cmd",
					"command": "ls -la", "cwd": "/workspace", "status": "completed",
					"aggregatedOutput": "README.md\n", "exitCode": 0,
				},
			})
			c.notify(appServerNotifyTokenUsage, map[string]any{
				"threadId": "codex-thread-1", "turnId": "turn-1",
				"tokenUsage": map[string]any{
					"last":               map[string]any{"totalTokens": 1200, "inputTokens": 1000, "cachedInputTokens": 0, "outputTokens": 200, "reasoningOutputTokens": 50},
					"total":              map[string]any{"totalTokens": 1200, "inputTokens": 1000, "cachedInputTokens": 0, "outputTokens": 200, "reasoningOutputTokens": 50},
					"modelContextWindow": 272000,
				},
			})
			c.notify(appServerNotifyPlanUpdated, map[string]any{
				"threadId": "codex-thread-1", "turnId": "turn-1",
				"plan": []any{
					map[string]any{"step": "Inspect repo", "status": "completed"},
					map[string]any{"step": "Run tests", "status": "inProgress"},
				},
			})
			c.notify(appServerNotifyThreadNameUpdated, map[string]any{
				"threadId": "codex-thread-1", "threadName": "Inspect repository structure",
			})
			if hold {
				continue
			}
			c.completePendingTurn()
		case appServerMethodTurnInterrupt:
			c.mu.Lock()
			c.turnStatus = "interrupted"
			ignore := c.ignoreInterrupt
			hang := c.hangInterrupt
			c.mu.Unlock()
			if hang {
				// Fully wedged codex: never even acknowledge the interrupt RPC.
				continue
			}
			c.sendJSON(map[string]any{"id": message.ID, "result": map[string]any{}})
			if ignore {
				// Wedged codex: it acks the interrupt but never completes the turn.
				continue
			}
			c.completePendingTurn()
		case appServerMethodTurnSteer:
			c.sendJSON(map[string]any{"id": message.ID, "result": map[string]any{"turnId": "turn-1"}})
		case appServerMethodThreadCompact:
			c.sendJSON(map[string]any{"id": message.ID, "result": map[string]any{}})
			// The real app-server runs compaction as a full turn and streams
			// turn/started → item/started → item/completed → turn/completed.
			c.notify(appServerNotifyTurnStarted, map[string]any{
				"threadId": "codex-thread-1",
				"turn":     map[string]any{"id": "turn-compact", "status": "inProgress", "items": []any{}},
			})
			c.notify(appServerNotifyItemStarted, map[string]any{
				"threadId": "codex-thread-1", "turnId": "turn-compact",
				"item": map[string]any{"type": "contextCompaction", "id": "item-compact", "status": "inProgress"},
			})
			c.notify(appServerNotifyItemCompleted, map[string]any{
				"threadId": "codex-thread-1", "turnId": "turn-compact",
				"item": map[string]any{"type": "contextCompaction", "id": "item-compact", "status": "completed"},
			})
			c.notify(appServerNotifyTurnCompleted, map[string]any{
				"threadId": "codex-thread-1",
				"turn":     map[string]any{"id": "turn-compact", "status": "completed", "items": []any{}},
			})
		case appServerMethodThreadRollback:
			c.sendJSON(map[string]any{
				"id":     message.ID,
				"result": map[string]any{"thread": map[string]any{"id": "codex-thread-1"}},
			})
		case appServerMethodThreadGoalSet:
			c.mu.Lock()
			previousGoal := clonePayload(c.goal)
			goalStartsTurn := c.goalStartsTurn
			goalTurnNumber := c.goalTurnsStarted
			if goalStartsTurn && strings.TrimSpace(asString(message.Params["objective"])) != "" {
				c.goalTurnsStarted++
				goalTurnNumber = c.goalTurnsStarted
			}
			goalStatus := firstNonEmpty(asString(message.Params["status"]), "active")
			if goalStartsTurn &&
				goalTurnNumber > 0 &&
				c.goalCompletionAfterTurns > 0 &&
				goalTurnNumber >= c.goalCompletionAfterTurns {
				goalStatus = "complete"
			}
			goal := map[string]any{
				"threadId":        "codex-thread-1",
				"objective":       firstNonEmpty(asString(message.Params["objective"]), asString(previousGoal["objective"])),
				"status":          goalStatus,
				"tokensUsed":      int64(0),
				"timeUsedSeconds": int64(0),
				"createdAt":       int64(1750000000),
				"updatedAt":       int64(1750000001),
			}
			if tokenBudget, ok := acpInt64Value(message.Params["tokenBudget"]); ok {
				goal["tokenBudget"] = tokenBudget
			}
			c.goal = clonePayload(goal)
			c.mu.Unlock()
			c.sendJSON(map[string]any{
				"id":     message.ID,
				"result": map[string]any{"goal": goal},
			})
			if goalStartsTurn && goalTurnNumber > 0 {
				turnID := fmt.Sprintf("turn-goal-%d", goalTurnNumber)
				itemID := fmt.Sprintf("item-goal-%d", goalTurnNumber)
				messageText := "I'll work on the goal."
				if goalStatus == "complete" && goalTurnNumber > 1 {
					messageText = "Goal complete."
				}
				c.notify(appServerNotifyTurnStarted, map[string]any{
					"threadId": "codex-thread-1",
					"turn":     map[string]any{"id": turnID, "status": "inProgress", "items": []any{}},
				})
				c.notify(appServerNotifyAgentMessageDelta, map[string]any{
					"threadId": "codex-thread-1", "turnId": turnID, "itemId": itemID, "delta": messageText,
				})
				c.notify(appServerNotifyTurnCompleted, map[string]any{
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
		case appServerMethodThreadGoalGet:
			c.mu.Lock()
			goal := clonePayload(c.goal)
			c.mu.Unlock()
			c.sendJSON(map[string]any{
				"id":     message.ID,
				"result": map[string]any{"goal": goal},
			})
		case appServerMethodThreadGoalClear:
			c.mu.Lock()
			c.goal = nil
			c.goalCleared = true
			c.mu.Unlock()
			c.sendJSON(map[string]any{
				"id":     message.ID,
				"result": map[string]any{"cleared": true},
			})
		case appServerMethodReviewStart:
			c.mu.Lock()
			reviewInline := c.reviewInline
			reviewInlineSummaryDelta := c.reviewInlineSummaryDelta
			reviewHang := c.reviewHang
			reviewStartEntered := c.reviewStartEntered
			c.mu.Unlock()
			c.sendJSON(map[string]any{
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
				continue
			}
			if reviewInline {
				// Inline delivery: reasoning and command output arrive as
				// item/started + item/completed (no agentMessageDelta), the
				// way a real /review turn streams.
				c.notify(appServerNotifyItemStarted, map[string]any{
					"threadId": "codex-thread-1", "turnId": "turn-review",
					"item": map[string]any{"type": "reasoning", "id": "item-think", "status": "inProgress", "summary": []any{}, "content": []any{}},
				})
				if reviewInlineSummaryDelta {
					for _, delta := range []string{"Inspecting", "the", "auth", "flow."} {
						c.notify(appServerNotifyReasoningSummary, map[string]any{
							"threadId": "codex-thread-1", "turnId": "turn-review",
							"itemId": "item-think", "summaryIndex": 0, "delta": delta,
						})
					}
					c.notify(appServerNotifyItemCompleted, map[string]any{
						"threadId": "codex-thread-1", "turnId": "turn-review",
						"item": map[string]any{"type": "reasoning", "id": "item-think", "status": "completed", "summary": []any{"Inspecting the auth flow."}, "content": []any{}},
					})
				} else {
					c.notify(appServerNotifyItemCompleted, map[string]any{
						"threadId": "codex-thread-1", "turnId": "turn-review",
						"item": map[string]any{"type": "reasoning", "id": "item-think", "status": "completed", "summary": []any{"Inspecting the auth flow."}, "content": []any{}},
					})
				}
				c.notify(appServerNotifyItemStarted, map[string]any{
					"threadId": "codex-thread-1", "turnId": "turn-review",
					"item": map[string]any{"type": "commandExecution", "id": "item-cmd", "command": "rg verifyToken", "cwd": "/workspace", "status": "inProgress"},
				})
				c.notify(appServerNotifyItemCompleted, map[string]any{
					"threadId": "codex-thread-1", "turnId": "turn-review",
					"item": map[string]any{"type": "commandExecution", "id": "item-cmd", "command": "rg verifyToken", "cwd": "/workspace", "status": "completed", "aggregatedOutput": "auth.go:42", "exitCode": 0},
				})
				c.notify(appServerNotifyTurnCompleted, map[string]any{
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
				continue
			}
			c.notify(appServerNotifyAgentMessageDelta, map[string]any{
				"threadId": "codex-thread-1", "turnId": "turn-review", "itemId": "item-review", "delta": "Found one issue.",
			})
			c.notify(appServerNotifyTurnCompleted, map[string]any{
				"threadId": "codex-thread-1",
				"turn": map[string]any{
					"id": "turn-review", "status": "completed",
					"items": []any{map[string]any{"type": "agentMessage", "id": "item-review", "text": "Found one issue."}},
				},
			})
		default:
			if message.Method == "" && len(message.ID) > 0 {
				// response to a server -> client request (approval / question)
				var payload map[string]any
				_ = json.Unmarshal([]byte(line), &payload)
				c.mu.Lock()
				c.approvalResponse = payload
				c.mu.Unlock()
				c.completePendingTurn()
			}
		}
	}
	return nil
}

func appServerRequestParamsList(t *testing.T, conn *scriptedAppServerConnection, method string) []map[string]any {
	t.Helper()
	conn.mu.Lock()
	sent := append([][]byte(nil), conn.sent...)
	conn.mu.Unlock()
	var matches []map[string]any
	for _, data := range sent {
		for _, line := range acpScanLines(data) {
			var request struct {
				Method string         `json:"method"`
				Params map[string]any `json:"params"`
			}
			if err := json.Unmarshal([]byte(line), &request); err != nil {
				t.Fatalf("unmarshal app-server request: %v", err)
			}
			if request.Method == method {
				matches = append(matches, request.Params)
			}
		}
	}
	return matches
}

func appServerRequestParams(t *testing.T, conn *scriptedAppServerConnection, method string) map[string]any {
	t.Helper()
	requests := appServerRequestParamsList(t, conn, method)
	if len(requests) == 0 {
		t.Fatalf("missing app-server request method %q", method)
	}
	return requests[0]
}

func startedAppServerAdapter(t *testing.T) (*CodexAppServerAdapter, *scriptedAppServerTransport, Session) {
	t.Helper()
	transport := newScriptedAppServerTransport()
	adapter := NewCodexAppServerAdapter(transport)
	session := testAppServerSession()
	events, err := adapter.Start(context.Background(), session)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if len(events) != 1 || events[0].Type != activityshared.EventSessionStarted {
		t.Fatalf("start events = %#v, want session.started", events)
	}
	session.ProviderSessionID = "codex-thread-1"
	return adapter, transport, session
}

func eventsOfType(events []activityshared.Event, eventType activityshared.EventType) []activityshared.Event {
	var matches []activityshared.Event
	for _, event := range events {
		if event.Type == eventType {
			matches = append(matches, event)
		}
	}
	return matches
}

// --- lifecycle tests ---

func TestCodexAppServerAdapterStartCreatesThread(t *testing.T) {
	t.Parallel()

	adapter, transport, _ := startedAppServerAdapter(t)
	if len(transport.specs) != 1 {
		t.Fatalf("process starts = %d, want 1", len(transport.specs))
	}
	spec := transport.specs[0]
	wantCommand := []string{codexAppServerCommand, codexAppServerSubcmd}
	if len(spec.Command) != 2 || spec.Command[0] != wantCommand[0] || spec.Command[1] != wantCommand[1] {
		t.Fatalf("command = %#v, want %#v", spec.Command, wantCommand)
	}
	if spec.CWD != "/workspace" {
		t.Fatalf("cwd = %q, want /workspace (workspace-mapped)", spec.CWD)
	}
	if !containsString(spec.Env, codexAgentRoutingEnv) {
		t.Fatalf("env = %#v, want agent routing env", spec.Env)
	}

	initialize := appServerRequestParams(t, transport.conn, appServerMethodInitialize)
	clientInfo, _ := initialize["clientInfo"].(map[string]any)
	if asString(clientInfo["name"]) != codexOfficialOriginator || asString(clientInfo["version"]) == "" {
		t.Fatalf("initialize clientInfo = %#v, want name=%q + non-empty version",
			initialize["clientInfo"], codexOfficialOriginator)
	}
	capabilities, _ := initialize["capabilities"].(map[string]any)
	if experimental, _ := capabilities["experimentalApi"].(bool); !experimental {
		t.Fatalf("initialize capabilities = %#v, want experimentalApi=true", initialize["capabilities"])
	}
	if params := appServerRequestParamsList(t, transport.conn, appServerMethodInitialized); len(params) != 1 {
		t.Fatalf("initialized notifications = %d, want 1", len(params))
	}
	threadStart := appServerRequestParams(t, transport.conn, appServerMethodThreadStart)
	if asString(threadStart["cwd"]) != "/workspace" {
		t.Fatalf("thread/start cwd = %q, want /workspace", threadStart["cwd"])
	}
	state := adapter.SessionState(testAppServerSession())
	if state.AuthState != "authenticated" {
		t.Fatalf("auth state = %q, want authenticated", state.AuthState)
	}
}

func TestCodexClientInfoParamsPresentsOfficialOriginator(t *testing.T) {
	t.Parallel()

	// A resolved codex version is used verbatim and overrides the host name,
	// so the outbound originator/User-Agent match the genuine codex_cli_rs.
	host := HostMetadata{ClientInfo: ClientInfo{Name: "tutti-desktop", Title: "Tutti", Version: "0.1.0"}}
	got := codexClientInfoParamsForVersion(host, "1.2.3")

	if got["name"] != codexOfficialOriginator {
		t.Fatalf("name = %v, want %q (official originator, not the host name)", got["name"], codexOfficialOriginator)
	}
	if got["version"] != "1.2.3" {
		t.Fatalf("version = %v, want the resolved codex version 1.2.3 (not host %q)", got["version"], host.ClientInfo.Version)
	}
	if got["title"] != "Tutti" {
		t.Fatalf("title = %v, want Tutti (passed through from host)", got["title"])
	}
}

func TestCodexClientInfoParamsFallsBackToHostVersion(t *testing.T) {
	t.Parallel()

	// When the codex version cannot be resolved, fall back to the host version
	// rather than emitting a blank version segment.
	host := HostMetadata{ClientInfo: ClientInfo{Name: "tutti-desktop", Title: "Tutti", Version: "9.9.9"}}
	got := codexClientInfoParamsForVersion(host, "")

	if got["name"] != codexOfficialOriginator {
		t.Fatalf("name = %v, want %q", got["name"], codexOfficialOriginator)
	}
	if got["version"] != "9.9.9" {
		t.Fatalf("version = %v, want host fallback 9.9.9", got["version"])
	}
}

func TestCodexAppServerAdapterWireFormatOmitsJSONRPCVersion(t *testing.T) {
	t.Parallel()

	_, transport, _ := startedAppServerAdapter(t)
	transport.conn.mu.Lock()
	defer transport.conn.mu.Unlock()
	for _, data := range transport.conn.sent {
		for _, line := range acpScanLines(data) {
			var message map[string]any
			if err := json.Unmarshal([]byte(line), &message); err != nil {
				t.Fatalf("unmarshal sent line: %v", err)
			}
			if _, found := message["jsonrpc"]; found {
				t.Fatalf("sent message includes jsonrpc version header: %s", line)
			}
		}
	}
}

func TestCodexAppServerAdapterStartAppliesSettingsAndPermissionMode(t *testing.T) {
	t.Parallel()

	transport := newScriptedAppServerTransport()
	adapter := NewCodexAppServerAdapter(transport)
	session := testAppServerSession()
	session.PermissionModeID = "read-only"
	session.Settings = &SessionSettings{
		Model:            "gpt-5.3-codex-spark",
		ReasoningEffort:  "max",
		PermissionModeID: "read-only",
	}
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	threadStart := appServerRequestParams(t, transport.conn, appServerMethodThreadStart)
	if asString(threadStart["model"]) != "gpt-5.3-codex-spark" {
		t.Fatalf("thread/start model = %q", threadStart["model"])
	}
	if asString(threadStart["approvalPolicy"]) != "on-request" {
		t.Fatalf("thread/start approvalPolicy = %q, want on-request", threadStart["approvalPolicy"])
	}
	if asString(threadStart["sandbox"]) != "read-only" {
		t.Fatalf("thread/start sandbox = %q, want read-only", threadStart["sandbox"])
	}
	config, _ := threadStart["config"].(map[string]any)
	if asString(config["model_reasoning_effort"]) != "xhigh" {
		t.Fatalf("thread/start config = %#v, want model_reasoning_effort=xhigh", config)
	}
	if asString(config["model_reasoning_summary"]) != "auto" {
		t.Fatalf("thread/start config = %#v, want reasoning summaries enabled for inline review on spark", config)
	}
}

func TestCodexAppServerAdapterStartAuthRequired(t *testing.T) {
	t.Parallel()

	transport := newScriptedAppServerTransport()
	transport.conn.requiresAuth = true
	adapter := NewCodexAppServerAdapter(transport)
	session := testAppServerSession()

	events, err := adapter.Start(context.Background(), session)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if len(events) != 1 || events[0].Type != activityshared.EventSessionStarted {
		t.Fatalf("events = %#v, want session.started", events)
	}
	if got := asString(events[0].Payload.Metadata["authState"]); got != "auth_required" {
		t.Fatalf("authState = %q, want auth_required", got)
	}
	if requests := appServerRequestParamsList(t, transport.conn, appServerMethodThreadStart); len(requests) != 0 {
		t.Fatalf("thread/start requests = %d, want 0 when auth is required", len(requests))
	}
	state := adapter.SessionState(session)
	if state.AuthState != "auth_required" {
		t.Fatalf("session auth state = %q, want auth_required", state.AuthState)
	}
	if asString(state.RuntimeContext["authMessage"]) == "" {
		t.Fatalf("runtime context missing authMessage: %#v", state.RuntimeContext)
	}
}

func TestCodexAppServerAdapterStartToleratesAccountReadError(t *testing.T) {
	t.Parallel()

	transport := newScriptedAppServerTransport()
	transport.conn.accountReadError = true
	adapter := NewCodexAppServerAdapter(transport)
	if _, err := adapter.Start(context.Background(), testAppServerSession()); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if requests := appServerRequestParamsList(t, transport.conn, appServerMethodThreadStart); len(requests) != 1 {
		t.Fatalf("thread/start requests = %d, want 1", len(requests))
	}
}

func TestCodexAppServerAdapterResume(t *testing.T) {
	t.Parallel()

	transport := newScriptedAppServerTransport()
	adapter := NewCodexAppServerAdapter(transport)
	session := testAppServerSession()
	session.ProviderSessionID = "codex-thread-1"

	if err := adapter.Resume(context.Background(), session); err != nil {
		t.Fatalf("Resume: %v", err)
	}
	resume := appServerRequestParams(t, transport.conn, appServerMethodThreadResume)
	if asString(resume["threadId"]) != "codex-thread-1" {
		t.Fatalf("thread/resume threadId = %q", resume["threadId"])
	}
	if asString(resume["cwd"]) != "/workspace" {
		t.Fatalf("thread/resume cwd = %q, want /workspace", resume["cwd"])
	}
	if !adapter.CanResume(session) {
		t.Fatalf("CanResume = false, want true")
	}
}

func TestCodexAppServerAdapterResumeEmitsCommandSnapshot(t *testing.T) {
	t.Parallel()

	transport := newScriptedAppServerTransport()
	adapter := NewCodexAppServerAdapter(transport)
	var snapshots []AgentSessionCommandSnapshot
	adapter.SetCommandSnapshotSink(func(snapshot AgentSessionCommandSnapshot) {
		snapshots = append(snapshots, snapshot)
	})
	session := testAppServerSession()
	session.ProviderSessionID = "codex-thread-1"

	if err := adapter.Resume(context.Background(), session); err != nil {
		t.Fatalf("Resume: %v", err)
	}
	if len(snapshots) == 0 {
		t.Fatalf("Resume emitted no command snapshot; review/undo would be missing on resumed sessions")
	}
	names := agentSessionCommandNames(snapshots[len(snapshots)-1].Commands)
	for _, want := range []string{"review", "compact", "undo"} {
		if !containsString(names, want) {
			t.Fatalf("resume snapshot commands = %#v, want %q", names, want)
		}
	}
}

func TestCodexAppServerAdapterResumeRetainsReplayedContextUsage(t *testing.T) {
	t.Parallel()

	transport := newScriptedAppServerTransport()
	transport.conn.replayTokenUsageOnResume = true
	adapter := NewCodexAppServerAdapter(transport)
	session := testAppServerSession()
	session.ProviderSessionID = "codex-thread-1"

	if err := adapter.Resume(context.Background(), session); err != nil {
		t.Fatalf("Resume: %v", err)
	}

	state := adapter.SessionState(session)
	usage, _ := state.RuntimeContext["usage"].(map[string]any)
	contextWindow, _ := usage["contextWindow"].(map[string]any)

	if contextWindow == nil {
		t.Fatalf("resume dropped replayed token usage: usage=%#v", usage)
	}
	if got, _ := acpInt64Value(contextWindow["usedTokens"]); got != 20453 {
		t.Fatalf("usedTokens = %d, want 20453", got)
	}
	if got, _ := acpInt64Value(contextWindow["totalTokens"]); got != 258400 {
		t.Fatalf("totalTokens = %d, want 258400", got)
	}
}

func TestCodexAppServerAdapterResumeRequiresProviderSession(t *testing.T) {
	t.Parallel()

	adapter := NewCodexAppServerAdapter(newScriptedAppServerTransport())
	session := testAppServerSession()
	session.ProviderSessionID = ""
	if err := adapter.Resume(context.Background(), session); err == nil {
		t.Fatalf("Resume without provider session id should fail")
	}
	if adapter.CanResume(session) {
		t.Fatalf("CanResume = true, want false")
	}
}

// --- exec tests ---

func TestCodexAppServerAdapterExecStreamsTurn(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	events, err := adapter.Exec(context.Background(), session, []PromptContentBlock{{
		Type: "text",
		Text: "inspect the repo",
	}}, "", "turn-local-1", nil, nil)
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}

	turnStart := appServerRequestParams(t, transport.conn, appServerMethodTurnStart)
	if asString(turnStart["threadId"]) != "codex-thread-1" {
		t.Fatalf("turn/start threadId = %q", turnStart["threadId"])
	}
	input, _ := turnStart["input"].([]any)
	if len(input) != 1 || asString(payloadObject(input[0])["text"]) != "inspect the repo" {
		t.Fatalf("turn/start input = %#v", turnStart["input"])
	}

	messages := eventsOfType(events, activityshared.EventMessageAppended)
	var assistantText, thinkingText string
	for _, event := range messages {
		switch event.Payload.Role {
		case activityshared.MessageRoleAssistant:
			assistantText = event.Payload.Content
		case activityshared.MessageRole(RoleAssistantThinking):
			thinkingText = event.Payload.Content
		}
	}
	if assistantText != "I'll check the repo." {
		t.Fatalf("assistant content = %q, want streamed message", assistantText)
	}
	if thinkingText != "Need context." {
		t.Fatalf("thinking content = %q", thinkingText)
	}

	callsStarted := eventsOfType(events, activityshared.EventCallStarted)
	callsCompleted := eventsOfType(events, activityshared.EventCallCompleted)
	if len(callsStarted) == 0 || len(callsCompleted) == 0 {
		t.Fatalf("missing call events: started=%d completed=%d", len(callsStarted), len(callsCompleted))
	}
	var bashCall *activityshared.Event
	for index := range callsCompleted {
		if asString(callsCompleted[index].Payload.Metadata["toolName"]) == "Bash" {
			bashCall = &callsCompleted[index]
		}
	}
	if bashCall == nil {
		t.Fatalf("missing completed Bash tool call: %#v", callsCompleted)
	}
	output := payloadMap(bashCall.Payload.Metadata, "output")
	if stdout, _ := output["stdout"].(string); stdout != "README.md\n" {
		t.Fatalf("bash output = %#v", output)
	}

	var todoCall *activityshared.Event
	for index := range callsCompleted {
		if asString(callsCompleted[index].Payload.Metadata["toolName"]) == "TodoWrite" {
			todoCall = &callsCompleted[index]
		}
	}
	if todoCall == nil {
		t.Fatalf("missing TodoWrite plan call")
	}

	completed := eventsOfType(events, activityshared.EventTurnCompleted)
	if len(completed) != 1 {
		t.Fatalf("turn completed events = %d, want 1", len(completed))
	}
	if asString(completed[0].Payload.Metadata["stopReason"]) != "end_turn" {
		t.Fatalf("stopReason = %#v", completed[0].Payload.Metadata)
	}

	var titleEvent bool
	for _, event := range events {
		if event.Type == activityshared.EventSessionUpdated && event.Payload.Title == "Inspect repository structure" {
			titleEvent = true
		}
	}
	if !titleEvent {
		t.Fatalf("missing thread name title event")
	}

	state := adapter.SessionState(session)
	usage, _ := state.RuntimeContext["usage"].(map[string]any)
	contextWindow, _ := usage["contextWindow"].(map[string]any)
	if used, _ := acpInt64Value(contextWindow["usedTokens"]); used != 1000 {
		t.Fatalf("usage usedTokens = %#v, want last.inputTokens (1000)", usage)
	}
	if total, _ := acpInt64Value(contextWindow["totalTokens"]); total != 272000 {
		t.Fatalf("usage totalTokens = %#v", usage)
	}
}

func TestCodexAppServerAdapterExecSendsTurnOverrides(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	session.PermissionModeID = "full-access"
	session.Settings = &SessionSettings{
		Model:            "gpt-5.1-codex",
		ReasoningEffort:  "high",
		PermissionModeID: "full-access",
	}
	if _, err := adapter.Exec(context.Background(), session, []PromptContentBlock{{
		Type: "text", Text: "go",
	}}, "", "turn-local-1", nil, nil); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	turnStart := appServerRequestParams(t, transport.conn, appServerMethodTurnStart)
	if asString(turnStart["model"]) != "gpt-5.1-codex" {
		t.Fatalf("turn/start model = %q", turnStart["model"])
	}
	if asString(turnStart["effort"]) != "high" {
		t.Fatalf("turn/start effort = %q", turnStart["effort"])
	}
	if asString(turnStart["approvalPolicy"]) != "never" {
		t.Fatalf("turn/start approvalPolicy = %q, want never", turnStart["approvalPolicy"])
	}
	sandboxPolicy, _ := turnStart["sandboxPolicy"].(map[string]any)
	if asString(sandboxPolicy["type"]) != "dangerFullAccess" {
		t.Fatalf("turn/start sandboxPolicy = %#v", turnStart["sandboxPolicy"])
	}
}

func TestCodexAppServerAdapterExecImagePrompt(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	if err := adapter.ValidatePromptContent(session, []PromptContentBlock{{Type: "image", MimeType: "image/png", Data: "aGk="}}); err != nil {
		t.Fatalf("ValidatePromptContent: %v", err)
	}
	if _, err := adapter.Exec(context.Background(), session, []PromptContentBlock{
		{Type: "text", Text: "look at this"},
		{Type: "image", MimeType: "image/png", Data: "aGk="},
	}, "", "turn-local-1", nil, nil); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	turnStart := appServerRequestParams(t, transport.conn, appServerMethodTurnStart)
	input, _ := turnStart["input"].([]any)
	if len(input) != 2 {
		t.Fatalf("turn/start input = %#v, want text+image", turnStart["input"])
	}
	image := payloadObject(input[1])
	if asString(image["type"]) != "image" || asString(image["url"]) != "data:image/png;base64,aGk=" {
		t.Fatalf("image input = %#v", image)
	}
}

func TestCodexAppServerAdapterExecTurnFailed(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	transport.conn.turnStatus = "failed"
	transport.conn.turnError = map[string]any{"message": "model is overloaded"}

	events, err := adapter.Exec(context.Background(), session, []PromptContentBlock{{
		Type: "text", Text: "go",
	}}, "", "turn-local-1", nil, nil)
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	failed := eventsOfType(events, activityshared.EventTurnFailed)
	if len(failed) != 1 {
		t.Fatalf("turn failed events = %d, want 1", len(failed))
	}
	if asString(failed[0].Payload.Metadata["error"]) != "model is overloaded" {
		t.Fatalf("failed metadata = %#v", failed[0].Payload.Metadata)
	}
}

func TestCodexAppServerAdapterExecTurnInterrupted(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	transport.conn.turnStatus = "interrupted"

	events, err := adapter.Exec(context.Background(), session, []PromptContentBlock{{
		Type: "text", Text: "go",
	}}, "", "turn-local-1", nil, nil)
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	if completed := eventsOfType(events, activityshared.EventTurnCompleted); len(completed) != 1 {
		t.Fatalf("turn completed events = %d, want 1 (interrupted outcome)", len(completed))
	} else if completed[0].Payload.TurnOutcome != string(activityshared.TurnOutcomeInterrupted) {
		t.Fatalf("turn outcome = %q, want interrupted", completed[0].Payload.TurnOutcome)
	}
}

func TestCodexAppServerAdapterCancelInterruptsActiveTurn(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	transport.conn.holdTurn = true

	execDone := make(chan []activityshared.Event, 1)
	go func() {
		events, _ := adapter.Exec(context.Background(), session, []PromptContentBlock{{
			Type: "text", Text: "long task",
		}}, "", "turn-local-1", nil, nil)
		execDone <- events
	}()

	waitForCondition(t, func() bool {
		return adapter.sessionActiveTurnID(session.AgentSessionID) == "turn-1"
	})
	if _, err := adapter.Cancel(context.Background(), session, "user requested"); err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	interrupt := appServerRequestParams(t, transport.conn, appServerMethodTurnInterrupt)
	if asString(interrupt["threadId"]) != "codex-thread-1" || asString(interrupt["turnId"]) != "turn-1" {
		t.Fatalf("turn/interrupt params = %#v", interrupt)
	}
	select {
	case events := <-execDone:
		if completed := eventsOfType(events, activityshared.EventTurnCompleted); len(completed) != 1 ||
			completed[0].Payload.TurnOutcome != string(activityshared.TurnOutcomeInterrupted) {
			t.Fatalf("expected interrupted turn outcome, got %#v", events)
		}
	case <-time.After(5 * time.Second):
		t.Fatalf("Exec did not finish after interrupt")
	}
}

func TestCodexAppServerAdapterCancelForceClosesWedgedTurn(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	adapter.cancelGraceWindow = 150 * time.Millisecond
	transport.conn.holdTurn = true
	// Wedged codex: it acks turn/interrupt but never sends turn/completed.
	transport.conn.ignoreInterrupt = true

	execDone := make(chan []activityshared.Event, 1)
	go func() {
		events, _ := adapter.Exec(context.Background(), session, []PromptContentBlock{{
			Type: "text", Text: "long task",
		}}, "", "turn-local-1", nil, nil)
		execDone <- events
	}()

	waitForCondition(t, func() bool {
		return adapter.sessionActiveTurnID(session.AgentSessionID) == "turn-1"
	})

	// Decision: terminate-then-respond. Cancel must return only after the turn
	// is actually terminated, and within grace + margin even though codex never
	// honored the interrupt.
	cancelReturned := make(chan error, 1)
	go func() {
		_, err := adapter.Cancel(context.Background(), session, "user requested")
		cancelReturned <- err
	}()
	select {
	case err := <-cancelReturned:
		if err != nil {
			t.Fatalf("Cancel: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("Cancel did not return; force-close fallback missing")
	}

	// The wedged turn must actually end, surfaced as canceled (interrupted
	// outcome), never as a failure.
	select {
	case events := <-execDone:
		completed := eventsOfType(events, activityshared.EventTurnCompleted)
		if len(completed) != 1 ||
			completed[0].Payload.TurnOutcome != string(activityshared.TurnOutcomeInterrupted) {
			t.Fatalf("expected interrupted (canceled) outcome, got %#v", events)
		}
		if failed := eventsOfType(events, activityshared.EventTurnFailed); len(failed) != 0 {
			t.Fatalf("force-cancel must not surface as failed, got %#v", events)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("Exec did not finish after force cancel")
	}
}

func TestCodexAppServerAdapterCancelForceCloseIsBoundedByGrace(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	adapter.cancelGraceWindow = 150 * time.Millisecond
	transport.conn.holdTurn = true
	// Fully wedged: codex never even acknowledges the turn/interrupt RPC, so a
	// synchronous interrupt call would block on its own ~10s timeout.
	transport.conn.hangInterrupt = true

	execDone := make(chan []activityshared.Event, 1)
	go func() {
		events, _ := adapter.Exec(context.Background(), session, []PromptContentBlock{{
			Type: "text", Text: "long task",
		}}, "", "turn-local-1", nil, nil)
		execDone <- events
	}()
	waitForCondition(t, func() bool {
		return adapter.sessionActiveTurnID(session.AgentSessionID) == "turn-1"
	})

	cancelReturned := make(chan error, 1)
	go func() {
		_, err := adapter.Cancel(context.Background(), session, "user requested")
		cancelReturned <- err
	}()
	// Time-to-force must be bounded by the grace window, not by the hung
	// interrupt RPC's own timeout.
	select {
	case err := <-cancelReturned:
		if err != nil {
			t.Fatalf("Cancel: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("Cancel blocked on the hung interrupt RPC instead of bounding by grace")
	}
	select {
	case <-execDone:
	case <-time.After(2 * time.Second):
		t.Fatalf("Exec did not finish after force cancel")
	}
}

func TestCodexAppServerAdapterCancelQueuesInterruptUntilTurnIDArrives(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	transport.conn.holdTurn = true
	transport.conn.turnStartEntered = make(chan struct{})
	transport.conn.turnStartRelease = make(chan struct{})

	execDone := make(chan []activityshared.Event, 1)
	go func() {
		events, _ := adapter.Exec(context.Background(), session, []PromptContentBlock{{
			Type: "text", Text: "long task",
		}}, "", "turn-local-1", nil, nil)
		execDone <- events
	}()

	select {
	case <-transport.conn.turnStartEntered:
	case <-time.After(5 * time.Second):
		t.Fatalf("turn/start was not sent")
	}
	waitForCondition(t, func() bool {
		return adapter.sessionActiveTurn(session.AgentSessionID) != nil &&
			adapter.sessionActiveTurnID(session.AgentSessionID) == ""
	})
	if _, err := adapter.Cancel(context.Background(), session, "user requested"); err != nil {
		t.Fatalf("Cancel before provider turn id: %v", err)
	}

	close(transport.conn.turnStartRelease)
	waitForCondition(t, func() bool {
		return len(appServerRequestParamsList(t, transport.conn, appServerMethodTurnInterrupt)) == 1
	})
	interrupt := appServerRequestParams(t, transport.conn, appServerMethodTurnInterrupt)
	if asString(interrupt["threadId"]) != "codex-thread-1" || asString(interrupt["turnId"]) != "turn-1" {
		t.Fatalf("turn/interrupt params = %#v", interrupt)
	}
	select {
	case events := <-execDone:
		if completed := eventsOfType(events, activityshared.EventTurnCompleted); len(completed) != 1 ||
			completed[0].Payload.TurnOutcome != string(activityshared.TurnOutcomeInterrupted) {
			t.Fatalf("expected interrupted turn outcome, got %#v", events)
		}
	case <-time.After(5 * time.Second):
		t.Fatalf("Exec did not finish after queued interrupt")
	}
}

func TestCodexAppServerAdapterCancelWithoutActiveTurnFails(t *testing.T) {
	t.Parallel()

	adapter, _, session := startedAppServerAdapter(t)
	if _, err := adapter.Cancel(context.Background(), session, "user requested"); err == nil {
		t.Fatalf("Cancel without active turn returned nil error")
	}
}

func TestCodexAppServerAdapterExecSteersActiveTurn(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	transport.conn.holdTurn = true

	execDone := make(chan struct{})
	go func() {
		_, _ = adapter.Exec(context.Background(), session, []PromptContentBlock{{
			Type: "text", Text: "long task",
		}}, "", "turn-local-1", nil, nil)
		close(execDone)
	}()
	waitForCondition(t, func() bool {
		return adapter.sessionActiveTurnID(session.AgentSessionID) == "turn-1"
	})

	events, err := adapter.Exec(context.Background(), session, []PromptContentBlock{{
		Type: "text", Text: "also update the docs",
	}}, "", "turn-local-2", nil, nil)
	if err != nil {
		t.Fatalf("steer Exec: %v", err)
	}
	steer := appServerRequestParams(t, transport.conn, appServerMethodTurnSteer)
	if asString(steer["expectedTurnId"]) != "turn-1" {
		t.Fatalf("turn/steer params = %#v", steer)
	}
	messages := eventsOfType(events, activityshared.EventMessageAppended)
	if len(messages) != 1 || messages[0].Payload.Role != activityshared.MessageRoleUser {
		t.Fatalf("steer events = %#v, want single user message", events)
	}

	transport.conn.completePendingTurn()
	select {
	case <-execDone:
	case <-time.After(5 * time.Second):
		t.Fatalf("original Exec did not finish")
	}
}

// --- approval and interactive tests ---

func TestCodexAppServerAdapterCommandApprovalApprove(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	transport.conn.commandApproval = true

	var streamed []activityshared.Event
	var streamedMu sync.Mutex
	execDone := make(chan []activityshared.Event, 1)
	go func() {
		events, _ := adapter.Exec(context.Background(), session, []PromptContentBlock{{
			Type: "text", Text: "clean the build dir",
		}}, "", "turn-local-1", func(next []activityshared.Event) {
			streamedMu.Lock()
			streamed = append(streamed, next...)
			streamedMu.Unlock()
		}, nil)
		execDone <- events
	}()

	waitForCondition(t, func() bool {
		return adapter.getPendingRequest(session.AgentSessionID, "approval-1") != nil
	})
	state := adapter.SessionState(session)
	if state.PendingInteractive == nil || state.PendingInteractive.Kind != "approval" {
		t.Fatalf("pending interactive = %#v, want approval", state.PendingInteractive)
	}

	result, err := adapter.SubmitInteractive(context.Background(), session, SubmitInteractiveInput{
		RequestID: "approval-1",
		OptionID:  "approve",
	})
	if err != nil {
		t.Fatalf("SubmitInteractive: %v", err)
	}
	if !result.Accepted || result.OptionID != "approve" {
		t.Fatalf("submit result = %#v", result)
	}

	events := <-execDone
	waitForCondition(t, func() bool {
		transport.conn.mu.Lock()
		defer transport.conn.mu.Unlock()
		return transport.conn.approvalResponse != nil
	})
	transport.conn.mu.Lock()
	response := transport.conn.approvalResponse
	transport.conn.mu.Unlock()
	resultPayload := payloadObject(response["result"])
	if asString(resultPayload["decision"]) != "accept" {
		t.Fatalf("approval response = %#v, want decision accept", response)
	}

	streamedMu.Lock()
	streamedCopy := append([]activityshared.Event(nil), streamed...)
	streamedMu.Unlock()
	var sawWaiting bool
	for _, event := range streamedCopy {
		if event.Type == activityshared.EventCallStarted &&
			asString(event.Payload.Metadata["callType"]) == "approval" {
			sawWaiting = true
		}
	}
	if !sawWaiting {
		t.Fatalf("approval call.started was not streamed: %#v", streamedCopy)
	}
	if completedCalls := eventsOfType(events, activityshared.EventCallCompleted); len(completedCalls) == 0 {
		t.Fatalf("approval resolution missing call.completed: %#v", events)
	}
}

func TestCodexAppServerAdapterCommandApprovalDecisionMapping(t *testing.T) {
	t.Parallel()

	tests := map[string]string{
		"approve_for_session": "acceptForSession",
		"deny":                "decline",
		"abort":               "cancel",
	}
	for optionID, wantDecision := range tests {
		adapter, transport, session := startedAppServerAdapter(t)
		transport.conn.commandApproval = true
		execDone := make(chan struct{})
		go func() {
			_, _ = adapter.Exec(context.Background(), session, []PromptContentBlock{{
				Type: "text", Text: "run it",
			}}, "", "turn-local-1", nil, nil)
			close(execDone)
		}()
		waitForCondition(t, func() bool {
			return adapter.getPendingRequest(session.AgentSessionID, "approval-1") != nil
		})
		if _, err := adapter.SubmitInteractive(context.Background(), session, SubmitInteractiveInput{
			RequestID: "approval-1",
			OptionID:  optionID,
		}); err != nil {
			t.Fatalf("SubmitInteractive(%s): %v", optionID, err)
		}
		<-execDone
		transport.conn.mu.Lock()
		response := transport.conn.approvalResponse
		transport.conn.mu.Unlock()
		if got := asString(payloadObject(response["result"])["decision"]); got != wantDecision {
			t.Fatalf("option %q decision = %q, want %q", optionID, got, wantDecision)
		}
	}
}

func TestCodexAppServerAdapterRequestUserInput(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	transport.conn.userInputRequest = true

	execDone := make(chan struct{})
	go func() {
		_, _ = adapter.Exec(context.Background(), session, []PromptContentBlock{{
			Type: "text", Text: "set up storage",
		}}, "", "turn-local-1", nil, nil)
		close(execDone)
	}()
	waitForCondition(t, func() bool {
		return adapter.getPendingRequest(session.AgentSessionID, "question-1") != nil
	})
	state := adapter.SessionState(session)
	if state.PendingInteractive == nil || state.PendingInteractive.Kind != "ask-user" {
		t.Fatalf("pending interactive = %#v, want ask-user", state.PendingInteractive)
	}

	// Mirror the GUI contract: `answers` is a flat display list and the
	// per-question map lives under answersByQuestionId.
	if _, err := adapter.SubmitInteractive(context.Background(), session, SubmitInteractiveInput{
		RequestID: "question-1",
		Action:    "submit",
		Payload: map[string]any{
			"answers":             []any{"postgres"},
			"answersByQuestionId": map[string]any{"q1": "postgres"},
		},
	}); err != nil {
		t.Fatalf("SubmitInteractive: %v", err)
	}
	<-execDone

	transport.conn.mu.Lock()
	response := transport.conn.approvalResponse
	transport.conn.mu.Unlock()
	answers := payloadObject(payloadObject(response["result"])["answers"])
	entry := payloadObject(answers["q1"])
	values, _ := entry["answers"].([]any)
	if len(values) != 1 || asString(values[0]) != "postgres" {
		t.Fatalf("user input response = %#v", response)
	}
}

// --- slash command tests ---

func TestCodexAppServerAdapterSlashCompact(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	events, err := adapter.Exec(context.Background(), session, []PromptContentBlock{{
		Type: "text", Text: "/compact",
	}}, "", "turn-local-1", nil, nil)
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	compact := appServerRequestParams(t, transport.conn, appServerMethodThreadCompact)
	if asString(compact["threadId"]) != "codex-thread-1" {
		t.Fatalf("compact params = %#v", compact)
	}
	if requests := appServerRequestParamsList(t, transport.conn, appServerMethodTurnStart); len(requests) != 0 {
		t.Fatalf("turn/start should not run for /compact")
	}
	// "Context compacted." must arrive via item/completed through the
	// session-level handler — not as a locally-emitted terminal message.
	var gotCompactedBanner bool
	for _, event := range events {
		if event.Payload.Content == "Context compacted." {
			gotCompactedBanner = true
		}
	}
	if !gotCompactedBanner {
		t.Fatalf("expected 'Context compacted.' banner in compact events; got %#v", events)
	}
	if completed := eventsOfType(events, activityshared.EventTurnCompleted); len(completed) != 1 {
		t.Fatalf("compact turn completed events = %d, want 1", len(completed))
	}
}

func TestCodexAppServerAdapterSlashReview(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	events, err := adapter.Exec(context.Background(), session, []PromptContentBlock{{
		Type: "text", Text: "/review check the auth flow",
	}}, "", "turn-local-1", nil, nil)
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	review := appServerRequestParams(t, transport.conn, appServerMethodReviewStart)
	target := payloadObject(review["target"])
	if asString(target["type"]) != "custom" || asString(target["instructions"]) != "check the auth flow" {
		t.Fatalf("review target = %#v", target)
	}
	if asString(review["summary"]) != "auto" {
		t.Fatalf("review/start summary = %q, want auto", review["summary"])
	}
	var assistantText string
	for _, event := range eventsOfType(events, activityshared.EventMessageAppended) {
		if event.Payload.Role == activityshared.MessageRoleAssistant {
			assistantText = event.Payload.Content
		}
	}
	if assistantText != "Found one issue." {
		t.Fatalf("review assistant message = %q", assistantText)
	}
	if completed := eventsOfType(events, activityshared.EventTurnCompleted); len(completed) != 1 {
		t.Fatalf("review turn completed events = %d, want 1", len(completed))
	}
}

func TestCodexAppServerAdapterSlashReviewInlineReasoning(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	transport.conn.reviewInline = true
	events, err := adapter.Exec(context.Background(), session, []PromptContentBlock{{
		Type: "text", Text: "/review check the auth flow",
	}}, "", "turn-local-1", nil, nil)
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}

	// Inline reasoning items must surface as finalized thinking so they break
	// the otherwise-unbroken tool-call streak in the GUI.
	thinking := activityMessagesWithRole(events, activityshared.MessageRoleAssistantThinking)
	sawReasoningText := false
	for _, event := range thinking {
		if event.Payload.Metadata["messageKind"] != "review-process" {
			t.Fatalf("thinking messageKind = %#v, want review-process", event.Payload.Metadata["messageKind"])
		}
		if strings.Contains(event.Payload.Content, "Inspecting the auth flow.") {
			sawReasoningText = true
		}
	}
	if !sawReasoningText {
		t.Fatalf("expected reasoning to surface as thinking, got %#v", thinking)
	}

	// Reasoning streamed and finalized exactly once (no double-append).
	if strings.Count(lastThinkingContent(thinking), "Inspecting the auth flow.") != 1 {
		t.Fatalf("reasoning text duplicated in thinking: %q", lastThinkingContent(thinking))
	}

	assistantText := ""
	for _, event := range activityMessagesWithRole(events, activityshared.MessageRoleAssistant) {
		assistantText = event.Payload.Content
	}
	if assistantText != "Found one issue." {
		t.Fatalf("review assistant message = %q", assistantText)
	}

	if completed := eventsOfType(events, activityshared.EventTurnCompleted); len(completed) != 1 {
		t.Fatalf("review turn completed events = %d, want 1", len(completed))
	}
}

func TestAppServerReasoningText(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		item map[string]any
		want string
	}{
		{
			name: "string summary array",
			item: map[string]any{
				"summary": []any{"Inspecting the auth flow."},
			},
			want: "Inspecting the auth flow.",
		},
		{
			name: "plain string summary",
			item: map[string]any{
				"summary": "Inspecting the auth flow.",
			},
			want: "Inspecting the auth flow.",
		},
		{
			name: "object summary sections",
			item: map[string]any{
				"summary": []any{map[string]any{"text": "Inspecting the auth flow."}},
			},
			want: "Inspecting the auth flow.",
		},
		{
			name: "top-level text fallback",
			item: map[string]any{
				"summary": []any{},
				"content": []any{},
				"text":    "Inspecting the auth flow.",
			},
			want: "Inspecting the auth flow.",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := appServerReasoningText(tt.item); got != tt.want {
				t.Fatalf("appServerReasoningText() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestAppServerReasoningDeltaTextPreservesWhitespace(t *testing.T) {
	t.Parallel()

	if got := appServerReasoningDeltaText(map[string]any{"delta": "Need "}); got != "Need " {
		t.Fatalf("delta text = %q, want trailing space preserved", got)
	}
	if got := appServerReasoningDeltaText(map[string]any{"text": "still "}); got != "still " {
		t.Fatalf("fallback text = %q, want trailing space preserved", got)
	}
	if got := appServerReasoningDeltaText(map[string]any{"text": " more"}); got != " more" {
		t.Fatalf("text fallback = %q, want leading space preserved", got)
	}
}

func TestCodexAppServerAdapterSlashReviewInlineReasoningSummaryDelta(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	transport.conn.reviewInline = true
	transport.conn.reviewInlineSummaryDelta = true
	events, err := adapter.Exec(context.Background(), session, []PromptContentBlock{{
		Type: "text", Text: "/review check the auth flow",
	}}, "", "turn-local-1", nil, nil)
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}

	thinking := activityMessagesWithRole(events, activityshared.MessageRoleAssistantThinking)
	if len(thinking) == 0 {
		t.Fatalf("expected streamed reasoning to surface as thinking, got none")
	}
	finalContent := thinking[len(thinking)-1].Payload.Content
	if finalContent != "Inspecting the auth flow." {
		t.Fatalf("thinking content = %q, want authoritative completed summary text", finalContent)
	}
	if thinking[len(thinking)-1].Payload.Metadata["messageKind"] != "review-process" {
		t.Fatalf("messageKind = %#v, want review-process", thinking[len(thinking)-1].Payload.Metadata["messageKind"])
	}
}

func lastThinkingContent(thinking []activityshared.Event) string {
	content := ""
	for _, event := range thinking {
		content = event.Payload.Content
	}
	return content
}

func TestCodexAppServerAdapterSlashReviewCancel(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	transport.conn.reviewHang = true
	entered := make(chan struct{})
	transport.conn.reviewStartEntered = entered

	ctx, cancel := context.WithCancel(context.Background())
	type execResult struct {
		events []activityshared.Event
		err    error
	}
	resultCh := make(chan execResult, 1)
	go func() {
		events, err := adapter.Exec(ctx, session, []PromptContentBlock{{
			Type: "text", Text: "/review",
		}}, "", "turn-local-1", nil, nil)
		resultCh <- execResult{events: events, err: err}
	}()

	<-entered
	cancel()
	res := <-resultCh
	if res.err != nil {
		t.Fatalf("Exec: %v", res.err)
	}

	// A canceled review must report as canceled (interrupted), not failed,
	// mirroring a normal turn.
	if failed := eventsOfType(res.events, activityshared.EventTurnFailed); len(failed) != 0 {
		t.Fatalf("canceled review emitted %d turn.failed events, want 0", len(failed))
	}
	sawCanceled := false
	for _, event := range eventsOfType(res.events, activityshared.EventTurnCompleted) {
		if event.Payload.TurnOutcome == string(activityshared.TurnOutcomeInterrupted) {
			sawCanceled = true
		}
	}
	if !sawCanceled {
		t.Fatalf("canceled review missing interrupted turn outcome: %#v", res.events)
	}
}

func TestCodexAppServerAdapterSlashReviewDefaultsToUncommitted(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	if _, err := adapter.Exec(context.Background(), session, []PromptContentBlock{{
		Type: "text", Text: "/review",
	}}, "", "turn-local-1", nil, nil); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	review := appServerRequestParams(t, transport.conn, appServerMethodReviewStart)
	if asString(payloadObject(review["target"])["type"]) != "uncommittedChanges" {
		t.Fatalf("review target = %#v, want uncommittedChanges", review["target"])
	}
}

func TestCodexAppServerAdapterSlashGoalSetsObjective(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	transport.conn.goalStartsTurn = true
	events, err := adapter.Exec(context.Background(), session, []PromptContentBlock{{
		Type: "text", Text: "/goal ship the review picker",
	}}, "", "turn-local-1", nil, nil)
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	goalSet := appServerRequestParams(t, transport.conn, appServerMethodThreadGoalSet)
	if asString(goalSet["threadId"]) != "codex-thread-1" {
		t.Fatalf("goal/set params = %#v", goalSet)
	}
	if asString(goalSet["objective"]) != "ship the review picker" {
		t.Fatalf("goal objective = %#v", goalSet)
	}
	if asString(goalSet["status"]) != "active" {
		t.Fatalf("goal status = %#v, want active", goalSet)
	}
	if requests := appServerRequestParamsList(t, transport.conn, appServerMethodTurnStart); len(requests) != 0 {
		t.Fatalf("turn/start should not run for /goal")
	}
	var assistantText string
	for _, event := range eventsOfType(events, activityshared.EventMessageAppended) {
		if event.Payload.Role == activityshared.MessageRoleAssistant {
			assistantText = event.Payload.Content
		}
		if event.Payload.Metadata["kind"] == "agent_system_notice" {
			t.Fatalf("goal objective should stream app-server turn instead of local-only notice: %#v", event)
		}
	}
	if assistantText != "I'll work on the goal." {
		t.Fatalf("goal assistant message = %q", assistantText)
	}
	if completed := eventsOfType(events, activityshared.EventTurnCompleted); len(completed) != 1 {
		t.Fatalf("goal turn completed events = %d, want 1", len(completed))
	}
}

func TestCodexAppServerAdapterSlashGoalContinuesUntilTerminalGoal(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	transport.conn.goalStartsTurn = true
	transport.conn.goalCompletionAfterTurns = 2
	events, err := adapter.Exec(context.Background(), session, []PromptContentBlock{{
		Type: "text", Text: "/goal finish the DrawingML pass",
	}}, "", "turn-local-goal", nil, nil)
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}

	goalSets := appServerRequestParamsList(t, transport.conn, appServerMethodThreadGoalSet)
	if len(goalSets) != 2 {
		t.Fatalf("goal/set requests = %d, want 2", len(goalSets))
	}
	if asString(goalSets[1]["status"]) != "active" {
		t.Fatalf("continuation goal/set params = %#v, want active status", goalSets[1])
	}
	if asString(goalSets[1]["objective"]) != "finish the DrawingML pass" {
		t.Fatalf("continuation goal objective = %#v", goalSets[1])
	}

	assistantMessages := []string{}
	for _, event := range eventsOfType(events, activityshared.EventMessageAppended) {
		if event.Payload.Role == activityshared.MessageRoleAssistant &&
			event.Payload.Metadata["streamState"] == messageStreamStateCompleted {
			assistantMessages = append(assistantMessages, event.Payload.Content)
		}
	}
	if strings.Join(assistantMessages, "\n") != "I'll work on the goal.\nGoal complete." {
		t.Fatalf("assistant messages = %#v", assistantMessages)
	}
	if completed := eventsOfType(events, activityshared.EventTurnCompleted); len(completed) != 1 {
		t.Fatalf("logical goal completed events = %d, want 1", len(completed))
	}
}

func TestCodexAppServerAdapterSlashGoalReadsCurrentGoal(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	transport.conn.mu.Lock()
	transport.conn.goal = map[string]any{
		"threadId":        "codex-thread-1",
		"objective":       "finish tests",
		"status":          "active",
		"tokensUsed":      int64(12),
		"timeUsedSeconds": int64(3),
		"createdAt":       int64(1750000000),
		"updatedAt":       int64(1750000001),
	}
	transport.conn.mu.Unlock()
	if _, err := adapter.Exec(context.Background(), session, []PromptContentBlock{{
		Type: "text", Text: "/goal",
	}}, "", "turn-local-1", nil, nil); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	goalGet := appServerRequestParams(t, transport.conn, appServerMethodThreadGoalGet)
	if asString(goalGet["threadId"]) != "codex-thread-1" {
		t.Fatalf("goal/get params = %#v", goalGet)
	}
	if requests := appServerRequestParamsList(t, transport.conn, appServerMethodTurnStart); len(requests) != 0 {
		t.Fatalf("turn/start should not run for bare /goal")
	}
}

func TestCodexAppServerAdapterSlashGoalObjectiveMayStartWithStatusWord(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	transport.conn.goalStartsTurn = true
	if _, err := adapter.Exec(context.Background(), session, []PromptContentBlock{{
		Type: "text", Text: "/goal complete support for goal commands",
	}}, "", "turn-local-1", nil, nil); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	goalSet := appServerRequestParams(t, transport.conn, appServerMethodThreadGoalSet)
	if asString(goalSet["objective"]) != "complete support for goal commands" {
		t.Fatalf("goal objective = %#v", goalSet)
	}
	if asString(goalSet["status"]) != "active" {
		t.Fatalf("goal status = %#v, want active", goalSet)
	}
}

func TestCodexAppServerAdapterSlashGoalStatusAndClear(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	if _, err := adapter.Exec(context.Background(), session, []PromptContentBlock{{
		Type: "text", Text: "/goal blocked",
	}}, "", "turn-local-1", nil, nil); err != nil {
		t.Fatalf("Exec blocked: %v", err)
	}
	goalSet := appServerRequestParams(t, transport.conn, appServerMethodThreadGoalSet)
	if asString(goalSet["status"]) != "blocked" {
		t.Fatalf("goal status params = %#v, want blocked", goalSet)
	}
	if _, hasObjective := goalSet["objective"]; hasObjective {
		t.Fatalf("status-only goal update should omit objective: %#v", goalSet)
	}

	if _, err := adapter.Exec(context.Background(), session, []PromptContentBlock{{
		Type: "text", Text: "/goal clear",
	}}, "", "turn-local-2", nil, nil); err != nil {
		t.Fatalf("Exec clear: %v", err)
	}
	goalClear := appServerRequestParams(t, transport.conn, appServerMethodThreadGoalClear)
	if asString(goalClear["threadId"]) != "codex-thread-1" {
		t.Fatalf("goal/clear params = %#v", goalClear)
	}
	transport.conn.mu.Lock()
	cleared := transport.conn.goalCleared
	transport.conn.mu.Unlock()
	if !cleared {
		t.Fatalf("scripted app-server goal was not cleared")
	}
}

func TestAppServerReviewTargetParsing(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name string
		args string
		want map[string]any
	}{
		{name: "empty", args: "", want: map[string]any{"type": "uncommittedChanges"}},
		{name: "blank", args: "   ", want: map[string]any{"type": "uncommittedChanges"}},
		{name: "base branch", args: "base:main", want: map[string]any{"type": "baseBranch", "branch": "main"}},
		{name: "base branch slashes", args: "base:feature/x", want: map[string]any{"type": "baseBranch", "branch": "feature/x"}},
		{name: "commit", args: "commit:abc123", want: map[string]any{"type": "commit", "sha": "abc123"}},
		{name: "custom keyword", args: "custom:check the auth flow", want: map[string]any{"type": "custom", "instructions": "check the auth flow"}},
		{name: "free text stays custom", args: "check the auth flow", want: map[string]any{"type": "custom", "instructions": "check the auth flow"}},
		// Collision guard: free text starting with a keyword but no colon must
		// not be parsed as a structured target.
		{name: "base no colon", args: "base our error handling", want: map[string]any{"type": "custom", "instructions": "base our error handling"}},
		// Unknown keyword before a colon falls back to a full custom prompt.
		{name: "unknown keyword colon", args: "fix the bug: it crashes", want: map[string]any{"type": "custom", "instructions": "fix the bug: it crashes"}},
		// Empty payload after a keyword falls back to custom.
		{name: "base empty", args: "base:", want: map[string]any{"type": "custom", "instructions": "base:"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := appServerReviewTarget(tc.args)
			if len(got) != len(tc.want) {
				t.Fatalf("target = %#v, want %#v", got, tc.want)
			}
			for key, want := range tc.want {
				if asString(got[key]) != want {
					t.Fatalf("target[%q] = %v, want %v", key, got[key], want)
				}
			}
		})
	}
}

func TestCodexAppServerAdapterReviewBannersEmitOnce(t *testing.T) {
	t.Parallel()

	adapter := &CodexAppServerAdapter{}
	session := Session{Provider: "codex", AgentSessionID: "agent-review", RoomID: "room-review"}

	countNotice := func(itemType, wantTitle string) int {
		// Real app-server streams both item/started and item/completed for
		// review/compaction items; the banner must appear exactly once.
		normalizer := newACPTurnNormalizer()
		item := map[string]any{"type": itemType, "id": "item-1"}
		events := adapter.appServerItemEvents(session, "turn-review", item, false, normalizer)
		events = append(events, adapter.appServerItemEvents(session, "turn-review", item, true, normalizer)...)
		count := 0
		for _, event := range events {
			if event.Payload.Content == wantTitle {
				count++
			}
		}
		return count
	}

	if got := countNotice("enteredReviewMode", "Code review started."); got != 1 {
		t.Fatalf("entered review banners = %d, want exactly 1", got)
	}
	if got := countNotice("exitedReviewMode", "Code review finished."); got != 1 {
		t.Fatalf("exited review banners = %d, want exactly 1", got)
	}
	if got := countNotice("contextCompaction", "Context compacted."); got != 1 {
		t.Fatalf("context compaction banners = %d, want exactly 1", got)
	}
}

func TestCodexAppServerAdapterSlashReviewBaseBranch(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	if _, err := adapter.Exec(context.Background(), session, []PromptContentBlock{{
		Type: "text", Text: "/review base:main",
	}}, "", "turn-local-1", nil, nil); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	review := appServerRequestParams(t, transport.conn, appServerMethodReviewStart)
	target := payloadObject(review["target"])
	if asString(target["type"]) != "baseBranch" || asString(target["branch"]) != "main" {
		t.Fatalf("review target = %#v, want baseBranch main", target)
	}
}

func TestCodexAppServerAdapterSlashUndo(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	events, err := adapter.Exec(context.Background(), session, []PromptContentBlock{{
		Type: "text", Text: "/undo",
	}}, "", "turn-local-1", nil, nil)
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	rollback := appServerRequestParams(t, transport.conn, appServerMethodThreadRollback)
	if numTurns, _ := acpInt64Value(rollback["numTurns"]); numTurns != 1 {
		t.Fatalf("rollback params = %#v", rollback)
	}
	if completed := eventsOfType(events, activityshared.EventTurnCompleted); len(completed) != 1 {
		t.Fatalf("undo turn completed events = %d, want 1", len(completed))
	}
}

// --- state and capability tests ---

func TestCodexAppServerAdapterSessionStateIncludesModelsAccountAndRateLimits(t *testing.T) {
	t.Parallel()

	adapter, _, session := startedAppServerAdapter(t)
	state := adapter.SessionState(session)

	options, _ := state.RuntimeContext["configOptions"].([]map[string]any)
	var modelOption map[string]any
	var effortOption map[string]any
	for _, option := range options {
		switch asString(option["id"]) {
		case "model":
			modelOption = option
		case "reasoning_effort":
			effortOption = option
		}
	}
	if modelOption == nil {
		t.Fatalf("missing model config option: %#v", options)
	}
	if asString(modelOption["currentValue"]) != "gpt-5.1-codex" {
		t.Fatalf("model currentValue = %#v", modelOption)
	}
	values, _ := modelOption["options"].([]any)
	if len(values) != 1 {
		t.Fatalf("model options = %#v, want hidden models excluded", values)
	}
	if effortOption == nil || asString(effortOption["currentValue"]) != "medium" {
		t.Fatalf("effort option = %#v", effortOption)
	}

	account, _ := state.RuntimeContext["account"].(map[string]any)
	if asString(account["email"]) != "dev@example.com" || asString(account["planType"]) != "pro" {
		t.Fatalf("account = %#v", account)
	}
	capabilities, _ := state.RuntimeContext["capabilities"].([]string)
	if !containsString(capabilities, "steer") || !containsString(capabilities, "rateLimits") {
		t.Fatalf("capabilities = %#v", capabilities)
	}
	commands, _ := state.RuntimeContext["commands"].([]string)
	if !containsString(commands, "review") || !containsString(commands, "compact") || !containsString(commands, "undo") || !containsString(commands, "goal") {
		t.Fatalf("commands = %#v", commands)
	}
	startup, _ := state.RuntimeContext["appServerStartup"].(map[string]any)
	if asString(startup["models"]) != "ready" || asString(startup["rateLimits"]) != "loading" {
		t.Fatalf("appServerStartup = %#v", startup)
	}
}

func TestCodexAppServerAdapterStartSkipsSlowStartupProbesWhenModelIsSpecified(t *testing.T) {
	t.Parallel()

	transport := newScriptedAppServerTransport()
	adapter := NewCodexAppServerAdapter(transport)
	session := testAppServerSession()
	session.Settings = &SessionSettings{Model: "gpt-5.3-codex-spark", ReasoningEffort: "high"}
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if requests := appServerRequestParamsList(t, transport.conn, appServerMethodModelList); len(requests) != 0 {
		t.Fatalf("model/list requests = %d, want 0 on startup with explicit model", len(requests))
	}
	if requests := appServerRequestParamsList(t, transport.conn, appServerMethodRateLimitsRead); len(requests) != 0 {
		t.Fatalf("rateLimits/read requests = %d, want 0 on startup", len(requests))
	}
	state := adapter.SessionState(session)
	options, _ := state.RuntimeContext["configOptions"].([]map[string]any)
	modelOption := configOptionByID(options, "model")
	if modelOption == nil {
		t.Fatalf("missing minimal model config option: %#v", options)
	}
	if asString(modelOption["currentValue"]) != "gpt-5.3-codex-spark" {
		t.Fatalf("model option = %#v, want explicit current model", modelOption)
	}
	values := configOptionValues(modelOption)
	if !containsString(values, "gpt-5.3-codex-spark") {
		t.Fatalf("model option values = %#v, want explicit model", values)
	}
	startup, _ := state.RuntimeContext["appServerStartup"].(map[string]any)
	if asString(startup["models"]) != "loading" || asString(startup["rateLimits"]) != "loading" {
		t.Fatalf("appServerStartup = %#v, want startup probes loading", startup)
	}
}

func TestCodexAppServerAdapterRefreshesStartupMetadataAsync(t *testing.T) {
	t.Parallel()

	transport := newScriptedAppServerTransport()
	controller := NewDefaultControllerWithProcessTransport(nil, transport)
	started, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderCodex,
		CWD:            "/workspace/room-1",
		Settings: &SessionSettings{
			Model:           "gpt-5.3-codex-spark",
			ReasoningEffort: "high",
		},
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if started.Error != nil {
		t.Fatalf("Start error = %#v", started.Error)
	}
	waitForCondition(t, func() bool {
		state, err := controller.State("room-1", started.Session.AgentSessionID)
		if err != nil {
			return false
		}
		rateLimits, _ := state.RuntimeContext["rateLimits"].(map[string]any)
		if rateLimits == nil {
			return false
		}
		startup, _ := state.RuntimeContext["appServerStartup"].(map[string]any)
		if asString(startup["models"]) != "ready" || asString(startup["rateLimits"]) != "ready" {
			return false
		}
		options, _ := state.RuntimeContext["configOptions"].([]map[string]any)
		modelOption := configOptionByID(options, "model")
		values := configOptionValues(modelOption)
		return containsString(values, "gpt-5.1-codex") &&
			containsString(values, "gpt-5.3-codex-spark")
	})
}

func configOptionByID(options []map[string]any, id string) map[string]any {
	for _, option := range options {
		if asString(option["id"]) == id {
			return option
		}
	}
	return nil
}

func configOptionValues(option map[string]any) []string {
	if len(option) == 0 {
		return nil
	}
	raw, _ := option["options"].([]any)
	values := make([]string, 0, len(raw))
	for _, entry := range raw {
		entryMap, _ := entry.(map[string]any)
		if value := asString(entryMap["value"]); value != "" {
			values = append(values, value)
		}
	}
	return values
}

func TestCodexAppServerAdapterSessionCommandSnapshot(t *testing.T) {
	t.Parallel()

	adapter, _, session := startedAppServerAdapter(t)
	snapshot, ok := adapter.SessionCommandSnapshot(session)
	if !ok {
		t.Fatalf("SessionCommandSnapshot not available")
	}
	names := agentSessionCommandNames(snapshot.Commands)
	for _, want := range []string{"review", "compact", "undo", "goal"} {
		if !containsString(names, want) {
			t.Fatalf("commands = %#v, want %q", names, want)
		}
	}
}

func TestCodexAppServerAdapterRateLimitNotificationUpdatesUsage(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	transport.conn.notify(appServerNotifyRateLimitsUpdated, map[string]any{
		"rateLimits": map[string]any{
			"primary":   map[string]any{"usedPercent": 40, "resetsAt": 1750003600},
			"secondary": map[string]any{"usedPercent": 5},
		},
	})
	waitForCondition(t, func() bool {
		state := adapter.SessionState(session)
		usage, _ := state.RuntimeContext["usage"].(map[string]any)
		quotas, _ := usage["quotas"].([]map[string]any)
		for _, quota := range quotas {
			if asString(quota["quotaType"]) != "session" {
				continue
			}
			remaining, _ := acpFloatValue(quota["percentRemaining"])
			return remaining == 60
		}
		return false
	})
	state := adapter.SessionState(session)
	usage, _ := state.RuntimeContext["usage"].(map[string]any)
	quotas, _ := usage["quotas"].([]map[string]any)
	var sessionQuota map[string]any
	for _, quota := range quotas {
		if asString(quota["quotaType"]) == "session" {
			sessionQuota = quota
		}
	}
	if sessionQuota == nil {
		t.Fatalf("quotas = %#v, want session quota", quotas)
	}
	if remaining, _ := acpFloatValue(sessionQuota["percentRemaining"]); remaining != 60 {
		t.Fatalf("session quota = %#v, want 60%% remaining", sessionQuota)
	}
	if resetsAt, _ := acpInt64Value(sessionQuota["resetsAtUnixMs"]); resetsAt != 1750003600000 {
		t.Fatalf("session quota resetsAt = %#v", sessionQuota)
	}
}

func TestCodexAppServerAdapterApplySessionSettings(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	model := "gpt-5.1-codex-mini"
	effort := "low"
	if adapter.RequiresNewSessionForSettings(session, SessionSettingsPatch{Model: &model}) {
		t.Fatalf("RequiresNewSessionForSettings = true, want false (per-turn overrides)")
	}
	if err := adapter.ApplySessionSettings(context.Background(), session, SessionSettingsPatch{
		Model:           &model,
		ReasoningEffort: &effort,
	}); err != nil {
		t.Fatalf("ApplySessionSettings: %v", err)
	}
	state := adapter.SessionState(session)
	config, _ := state.RuntimeContext["config"].(map[string]any)
	if asString(config["model"]) != model || asString(config["reasoning_effort"]) != "low" {
		t.Fatalf("config = %#v", config)
	}

	session.Settings = &SessionSettings{Model: model, ReasoningEffort: effort}
	if _, err := adapter.Exec(context.Background(), session, []PromptContentBlock{{
		Type: "text", Text: "go",
	}}, "", "turn-local-1", nil, nil); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	turnStart := appServerRequestParams(t, transport.conn, appServerMethodTurnStart)
	if asString(turnStart["model"]) != model || asString(turnStart["effort"]) != "low" {
		t.Fatalf("turn/start overrides = %#v", turnStart)
	}
}

func TestCodexAppServerAdapterApplyPermissionModeUpdatesState(t *testing.T) {
	t.Parallel()

	adapter, _, session := startedAppServerAdapter(t)
	session.PermissionModeID = "full-access"
	if err := adapter.ApplyPermissionMode(context.Background(), session); err != nil {
		t.Fatalf("ApplyPermissionMode: %v", err)
	}
	state := adapter.SessionState(session)
	if asString(state.RuntimeContext["mode"]) != "full-access" {
		t.Fatalf("mode = %#v, want full-access", state.RuntimeContext["mode"])
	}
}

func TestCodexAppServerAdapterCloseShutsDownSession(t *testing.T) {
	t.Parallel()

	adapter, _, session := startedAppServerAdapter(t)
	if err := adapter.Close(context.Background(), session); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if adapter.getSession(session.AgentSessionID) != nil {
		t.Fatalf("session should be removed after Close")
	}
	if _, err := adapter.Exec(context.Background(), session, []PromptContentBlock{{
		Type: "text", Text: "go",
	}}, "", "turn-local-1", nil, nil); err == nil {
		t.Fatalf("Exec after Close should fail with disconnected session")
	}
}

func TestCodexAppServerAdapterWarningNotificationsBecomeSystemNotices(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	transport.conn.holdTurn = true

	var streamed []activityshared.Event
	var streamedMu sync.Mutex
	execDone := make(chan struct{})
	go func() {
		_, _ = adapter.Exec(context.Background(), session, []PromptContentBlock{{
			Type: "text", Text: "go",
		}}, "", "turn-local-1", func(next []activityshared.Event) {
			streamedMu.Lock()
			streamed = append(streamed, next...)
			streamedMu.Unlock()
		}, nil)
		close(execDone)
	}()
	waitForCondition(t, func() bool {
		return adapter.sessionActiveTurnID(session.AgentSessionID) == "turn-1"
	})

	transport.conn.notify(appServerNotifyWarning, map[string]any{
		"message":  "Model fell back to a smaller context window.",
		"threadId": "codex-thread-1",
	})
	transport.conn.notify(appServerNotifyError, map[string]any{
		"threadId":  "codex-thread-1",
		"turnId":    "turn-1",
		"willRetry": true,
		"error":     map[string]any{"message": "stream disconnected"},
	})
	waitForCondition(t, func() bool {
		streamedMu.Lock()
		defer streamedMu.Unlock()
		notices := 0
		for _, event := range streamed {
			if event.Type == activityshared.EventMessageAppended &&
				asString(event.Payload.Metadata["kind"]) == "agent_system_notice" {
				notices++
			}
		}
		return notices >= 2
	})

	streamedMu.Lock()
	var retryNotice map[string]any
	for _, event := range streamed {
		if asString(event.Payload.Metadata["noticeKind"]) == "transport_retry" {
			retryNotice = event.Payload.Metadata
		}
	}
	streamedMu.Unlock()
	if retryNotice == nil {
		t.Fatalf("missing transport retry notice")
	}

	transport.conn.completePendingTurn()
	<-execDone
}

func TestCodexAppServerAdapterDefaultControllerUsesAppServerForCodex(t *testing.T) {
	t.Parallel()

	controller := NewDefaultControllerWithProcessTransport(nil, newScriptedAppServerTransport())
	adapter := controller.adapter(ProviderCodex)
	if _, ok := adapter.(*CodexAppServerAdapter); !ok {
		t.Fatalf("codex adapter = %T, want *CodexAppServerAdapter", adapter)
	}
	if nexight := controller.adapter(ProviderNexight); nexight == nil {
		t.Fatalf("nexight adapter missing")
	} else if _, ok := nexight.(*CodexAdapter); !ok {
		t.Fatalf("nexight adapter = %T, want ACP family adapter", nexight)
	}
}

func TestCodexAppServerAdapterReportsPlanModeCapabilityWhenCollaborationModesAvailable(t *testing.T) {
	t.Parallel()

	adapter, _, session := startedAppServerAdapter(t)
	state := adapter.SessionState(session)
	capabilities, _ := state.RuntimeContext["capabilities"].([]string)
	if !containsString(capabilities, CapabilityPlanMode) {
		t.Fatalf("capabilities = %#v, want planMode", capabilities)
	}
}

func TestCodexAppServerAdapterOmitsPlanModeCapabilityWithoutCollaborationModes(t *testing.T) {
	t.Parallel()

	transport := newScriptedAppServerTransport()
	transport.conn.collaborationModeUnsupported = true
	adapter := NewCodexAppServerAdapter(transport)
	session := testAppServerSession()
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	session.ProviderSessionID = "codex-thread-1"
	state := adapter.SessionState(session)
	capabilities, _ := state.RuntimeContext["capabilities"].([]string)
	if containsString(capabilities, CapabilityPlanMode) {
		t.Fatalf("capabilities = %#v, want no planMode without collaboration modes", capabilities)
	}
}

func TestCodexAppServerAdapterSendsCollaborationModeForPlanTurns(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	session.Settings = &SessionSettings{PlanMode: true}
	if _, err := adapter.Exec(context.Background(), session, []PromptContentBlock{{
		Type: "text", Text: "plan it",
	}}, "", "turn-plan-1", nil, nil); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	turnStart := appServerRequestParams(t, transport.conn, appServerMethodTurnStart)
	collaborationMode, _ := turnStart["collaborationMode"].(map[string]any)
	if asString(collaborationMode["mode"]) != "plan" {
		t.Fatalf("turn/start collaborationMode = %#v, want plan preset", turnStart["collaborationMode"])
	}
	settings, _ := collaborationMode["settings"].(map[string]any)
	// Settings.model is a required String in the app-server schema; the
	// adapter fills it from the session default when no override is set.
	if asString(settings["model"]) != "gpt-5.1-codex" {
		t.Fatalf("collaborationMode settings = %#v, want default model", settings)
	}
	if asString(settings["reasoning_effort"]) != "medium" {
		t.Fatalf("collaborationMode settings = %#v, want preset reasoning effort", settings)
	}
	if value, ok := settings["developer_instructions"]; !ok || value != nil {
		t.Fatalf("collaborationMode settings = %#v, want explicit null developer_instructions", settings)
	}

	session.Settings = &SessionSettings{PlanMode: false}
	if _, err := adapter.Exec(context.Background(), session, []PromptContentBlock{{
		Type: "text", Text: "now build",
	}}, "", "turn-plan-2", nil, nil); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	turnStarts := appServerRequestParamsList(t, transport.conn, appServerMethodTurnStart)
	last := turnStarts[len(turnStarts)-1]
	// Collaboration mode is sticky thread state on the codex side, so leaving
	// plan mode must explicitly declare the default mode rather than omit the
	// field (mirrors the codex TUI's SubmitUserMessageWithMode behavior).
	exitMode, _ := last["collaborationMode"].(map[string]any)
	if asString(exitMode["mode"]) != "default" {
		t.Fatalf("turn/start collaborationMode = %#v, want explicit default mode after plan", last["collaborationMode"])
	}
	exitSettings, _ := exitMode["settings"].(map[string]any)
	if asString(exitSettings["model"]) != "gpt-5.1-codex" {
		t.Fatalf("default collaborationMode settings = %#v, want default model", exitSettings)
	}

	session.Settings = &SessionSettings{PlanMode: true, Model: "gpt-5.1-codex-mini", ReasoningEffort: "low"}
	if _, err := adapter.Exec(context.Background(), session, []PromptContentBlock{{
		Type: "text", Text: "plan again",
	}}, "", "turn-plan-3", nil, nil); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	turnStarts = appServerRequestParamsList(t, transport.conn, appServerMethodTurnStart)
	last = turnStarts[len(turnStarts)-1]
	overrideMode, _ := last["collaborationMode"].(map[string]any)
	overrideSettings, _ := overrideMode["settings"].(map[string]any)
	if asString(overrideSettings["model"]) != "gpt-5.1-codex-mini" || asString(overrideSettings["reasoning_effort"]) != "low" {
		t.Fatalf("collaborationMode settings = %#v, want session overrides", overrideSettings)
	}
}

func TestCodexAppServerAdapterEmitsPlanItemAsTaggedMessage(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	transport.conn.mu.Lock()
	transport.conn.emitPlanItem = true
	transport.conn.mu.Unlock()
	session.Settings = &SessionSettings{PlanMode: true}
	adapterTurnEvents, err := adapter.Exec(context.Background(), session, []PromptContentBlock{{
		Type: "text", Text: "plan it",
	}}, "", "turn-plan-track-1", nil, nil)
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	planMessages := 0
	for _, event := range eventsOfType(adapterTurnEvents, activityshared.EventMessageAppended) {
		if event.Payload.Metadata["messageKind"] == "plan" {
			planMessages++
			if !strings.Contains(event.Payload.Content, "# Plan") {
				t.Fatalf("plan message content = %q, want plan text", event.Payload.Content)
			}
		}
	}
	if planMessages != 1 {
		t.Fatalf("plan-tagged messages = %d, want exactly 1", planMessages)
	}
}
