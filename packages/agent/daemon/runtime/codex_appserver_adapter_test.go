//revive:disable:file-length-limit
package agentruntime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
)

const (
	testAppServerPlanCollaborationInstructions    = "# Plan Mode (Conversational)\n\nPlan before implementing."
	testAppServerDefaultCollaborationInstructions = "# Collaboration Mode: Default\n\nExecute with reasonable assumptions."
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

func codexProviderDescriptorForTest(t *testing.T) providerregistry.ProviderDescriptor {
	t.Helper()
	descriptor, ok := providerregistry.Find(providerregistry.CodexProviderID)
	if !ok {
		t.Fatal("migrated Codex provider descriptor is missing")
	}
	return descriptor
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
		closed:                   make(chan struct{}),
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
	mu     sync.Mutex
	sent   [][]byte
	recv   chan ProcessFrame
	closed chan struct{}

	modelList                       []any
	requiresAuth                    bool
	collaborationModeUnsupported    bool
	emitPlanItem                    bool
	accountReadError                bool
	turnStatus                      string // completed (default) | failed | interrupted
	turnError                       map[string]any
	holdTurn                        bool              // do not finish the turn until released
	steeredTurnStart                bool              // turn/start returns a queued stub turn (input steered into the running turn): no turn/started, no auto-completion
	ignoreInterrupt                 bool              // ack turn/interrupt but never complete the turn (wedged codex)
	hangInterrupt                   bool              // never even acknowledge the turn/interrupt RPC (fully wedged codex)
	interruptTurnIDMismatch         string            // reject the first turn/interrupt with "expected active turn id X but found <this>"; a retry against the reported id succeeds
	interruptAttempts               []string          // turnId requested on every turn/interrupt call, in order
	childNicknames                  map[string]string // thread/read agentNickname responses by threadId
	turnStartEntered                chan struct{}
	turnStartRelease                chan struct{}
	hangTurnStart                   bool
	hangSteer                       bool
	threadName                      string
	commandApproval                 bool
	userInputRequest                bool
	compactSilent                   bool          // stream turn/started+turn/completed for /compact but no contextCompaction item notifications
	reviewInline                    bool          // stream review output as inline reasoning/command items
	reviewInlineSummaryDelta        bool          // stream review reasoning via summaryTextDelta with empty completed summary
	reviewHang                      bool          // respond to review/start but never complete the turn
	foreignThreadNoise              bool          // emit subagent/foreign thread notifications during a parent turn
	reviewStartEntered              chan struct{} // closed once review/start has responded
	approvalResponse                map[string]any
	goal                            map[string]any
	goalStartsTurn                  bool
	goalNotificationsBeforeResponse bool
	goalUpdatedOmitsTurnID          bool
	goalTurnsStarted                int
	goalCompletionAfterTurns        int
	goalTurnFailAtTurn              int // goal-driven turn number (1-based) that settles as "failed" instead of "completed"
	goalCleared                     bool
	goalOmitUpdatedAt               bool
	goalEmptyResponse               bool
	replayTokenUsageOnResume        bool // mirror real codex: emit token usage during thread/resume
	threadResumeError               bool // fail thread/resume with an RPC error
	closeOnce                       sync.Once
	closeCount                      int
}

func (c *scriptedAppServerConnection) sendJSON(value map[string]any) {
	c.sendJSONWithWaitSignal(value, nil)
}

func (c *scriptedAppServerConnection) sendJSONWithWaitSignal(value map[string]any, waitEntered chan<- struct{}) {
	raw, err := json.Marshal(value)
	if err != nil {
		return
	}
	select {
	case <-c.closed:
		return
	default:
	}
	for {
		select {
		case <-c.closed:
			return
		case c.recv <- ProcessFrame{Stdout: append(raw, '\n')}:
			return
		case waitEntered <- struct{}{}:
			waitEntered = nil
		}
	}
}

func (c *scriptedAppServerConnection) notify(method string, params map[string]any) {
	c.sendJSON(map[string]any{"method": method, "params": params})
}

func (c *scriptedAppServerConnection) Recv() (ProcessFrame, error) {
	return c.recvWithWaitSignal(nil)
}

func (c *scriptedAppServerConnection) recvWithWaitSignal(waitEntered chan<- struct{}) (ProcessFrame, error) {
	select {
	case <-c.closed:
		return ProcessFrame{}, io.EOF
	default:
	}
	for {
		select {
		case <-c.closed:
			return ProcessFrame{}, io.EOF
		case frame := <-c.recv:
			return frame, nil
		case waitEntered <- struct{}{}:
			waitEntered = nil
		}
	}
}

func (c *scriptedAppServerConnection) Close() error {
	c.mu.Lock()
	c.closeCount++
	c.mu.Unlock()
	c.closeOnce.Do(func() { close(c.closed) })
	return nil
}

func TestScriptedAppServerConnectionCloseUnblocksSendAndReceive(t *testing.T) {
	t.Run("send", func(t *testing.T) {
		connection := newScriptedAppServerConnection()
		for index := 0; index < cap(connection.recv); index++ {
			connection.sendJSON(map[string]any{"index": index})
		}
		waitEntered := make(chan struct{})
		sendReturned := make(chan struct{})
		go func() {
			connection.sendJSONWithWaitSignal(map[string]any{"afterBuffer": true}, waitEntered)
			close(sendReturned)
		}()
		<-waitEntered
		if err := connection.Close(); err != nil {
			t.Fatal(err)
		}
		select {
		case <-sendReturned:
		case <-time.After(time.Second):
			t.Fatal("connection close did not unblock a pending scripted send")
		}
	})

	t.Run("receive", func(t *testing.T) {
		connection := newScriptedAppServerConnection()
		waitEntered := make(chan struct{})
		receiveReturned := make(chan error, 1)
		go func() {
			_, err := connection.recvWithWaitSignal(waitEntered)
			receiveReturned <- err
		}()
		<-waitEntered
		if err := connection.Close(); err != nil {
			t.Fatal(err)
		}
		select {
		case err := <-receiveReturned:
			if !errors.Is(err, io.EOF) {
				t.Fatalf("receive after close error = %v", err)
			}
		case <-time.After(time.Second):
			t.Fatal("connection close did not unblock a pending scripted receive")
		}
	})
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
			c.mu.Lock()
			models := c.modelList
			c.mu.Unlock()
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
			c.sendJSON(map[string]any{
				"id": message.ID,
				"result": map[string]any{
					"data": models,
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
			c.mu.Lock()
			threadResumeError := c.threadResumeError && message.Method == appServerMethodThreadResume
			replayTokenUsage := c.replayTokenUsageOnResume && message.Method == appServerMethodThreadResume
			c.mu.Unlock()
			if threadResumeError {
				c.sendJSON(map[string]any{
					"id":    message.ID,
					"error": map[string]any{"code": -32000, "message": "resume rejected by test"},
				})
				continue
			}
			c.notify(appServerNotifyThreadStarted, map[string]any{
				"thread": map[string]any{"id": "codex-thread-1"},
			})
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
			steered := c.steeredTurnStart
			approval := c.commandApproval
			userInput := c.userInputRequest
			emitPlan := c.emitPlanItem
			foreignThreadNoise := c.foreignThreadNoise
			turnStartEntered := c.turnStartEntered
			turnStartRelease := c.turnStartRelease
			hangTurnStart := c.hangTurnStart
			c.mu.Unlock()
			if turnStartEntered != nil {
				close(turnStartEntered)
			}
			if turnStartRelease != nil {
				<-turnStartRelease
			}
			if hangTurnStart {
				continue
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
				c.sendJSON(map[string]any{
					"id": message.ID,
					"result": map[string]any{
						"turn": map[string]any{"id": "turn-steer-stub", "status": "inProgress", "items": []any{}},
					},
				})
				continue
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
			if foreignThreadNoise {
				c.notify(appServerNotifyAgentMessageDelta, map[string]any{
					"threadId": "foreign-thread-1", "turnId": "foreign-turn-1", "itemId": "foreign-msg",
					"delta": `{"n":7}`,
				})
				c.notify(appServerNotifyItemCompleted, map[string]any{
					"threadId": "foreign-thread-1", "turnId": "foreign-turn-1",
					"item": map[string]any{
						"type": "agentMessage", "id": "foreign-msg", "text": `{"n":7}`,
					},
				})
				c.notify(appServerNotifyTurnCompleted, map[string]any{
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
			c.mu.Lock()
			threadName := c.threadName
			c.mu.Unlock()
			if threadName == "" {
				threadName = "Inspect repository structure"
			}
			c.notify(appServerNotifyThreadNameUpdated, map[string]any{
				"threadId": "codex-thread-1", "threadName": threadName,
			})
			if hold {
				continue
			}
			c.completePendingTurn()
		case appServerMethodThreadRead:
			c.mu.Lock()
			nickname := c.childNicknames[asString(message.Params["threadId"])]
			c.mu.Unlock()
			thread := map[string]any{"id": message.Params["threadId"]}
			if nickname != "" {
				thread["agentNickname"] = nickname
			}
			c.sendJSON(map[string]any{"id": message.ID, "result": map[string]any{"thread": thread}})
		case appServerMethodTurnInterrupt:
			c.mu.Lock()
			threadID := asString(message.Params["threadId"])
			if threadID == "codex-thread-1" {
				c.turnStatus = "interrupted"
			}
			ignore := c.ignoreInterrupt
			hang := c.hangInterrupt
			mismatchTurnID := c.interruptTurnIDMismatch
			requestedTurnID := asString(message.Params["turnId"])
			c.interruptAttempts = append(c.interruptAttempts, requestedTurnID)
			c.mu.Unlock()
			if hang {
				// Fully wedged codex: never even acknowledge the interrupt RPC.
				continue
			}
			if mismatchTurnID != "" && requestedTurnID != mismatchTurnID {
				// Mirror codex rejecting a stale expected turn id (live
				// -32600 "invalid request" shape): the client's own turn
				// bookkeeping raced ahead of what codex still considers
				// active (e.g. a slow-to-terminate wait_agent call kept the
				// real turn alive past our local cancel). Only the retry
				// against the reported id (mismatchTurnID) is honored.
				c.sendJSON(map[string]any{
					"id": message.ID,
					"error": map[string]any{
						"code": -32600,
						"message": fmt.Sprintf(
							"expected active turn id %s but found %s", requestedTurnID, mismatchTurnID,
						),
					},
				})
				continue
			}
			c.sendJSON(map[string]any{"id": message.ID, "result": map[string]any{}})
			if ignore {
				// Wedged codex: it acks the interrupt but never completes the turn.
				continue
			}
			if threadID == "codex-thread-1" {
				c.completePendingTurn()
			}
		case appServerMethodTurnSteer:
			c.mu.Lock()
			hang := c.hangSteer
			c.mu.Unlock()
			if hang {
				continue
			}
			c.sendJSON(map[string]any{"id": message.ID, "result": map[string]any{"turnId": "turn-1"}})
		case appServerMethodThreadCompact:
			c.sendJSON(map[string]any{"id": message.ID, "result": map[string]any{}})
			// The real app-server runs compaction as a full turn and streams
			// turn/started → item/started → item/completed → turn/completed.
			c.notify(appServerNotifyTurnStarted, map[string]any{
				"threadId": "codex-thread-1",
				"turn":     map[string]any{"id": "turn-compact", "status": "inProgress", "items": []any{}},
			})
			if !c.compactSilent {
				c.notify(appServerNotifyItemStarted, map[string]any{
					"threadId": "codex-thread-1", "turnId": "turn-compact",
					"item": map[string]any{"type": "contextCompaction", "id": "item-compact", "status": "inProgress"},
				})
				c.notify(appServerNotifyItemCompleted, map[string]any{
					"threadId": "codex-thread-1", "turnId": "turn-compact",
					"item": map[string]any{"type": "contextCompaction", "id": "item-compact", "status": "completed"},
				})
			}
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
			if c.goalOmitUpdatedAt {
				delete(goal, "updatedAt")
			}
			if tokenBudget, ok := int64Value(message.Params["tokenBudget"]); ok {
				goal["tokenBudget"] = tokenBudget
			}
			c.goal = clonePayload(goal)
			notificationsBeforeResponse := c.goalNotificationsBeforeResponse
			responseGoal := goal
			if c.goalEmptyResponse {
				responseGoal = map[string]any{}
			}
			c.mu.Unlock()
			sendResponse := func() {
				c.sendJSON(map[string]any{
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
				c.mu.Lock()
				failThisTurn := c.goalTurnFailAtTurn > 0 && goalTurnNumber == c.goalTurnFailAtTurn
				c.mu.Unlock()
				messageText := "I'll work on the goal."
				if goalStatus == "complete" && goalTurnNumber > 1 {
					messageText = "Goal complete."
				}
				goalUpdate := map[string]any{
					"threadId": "codex-thread-1",
					"goal":     goal,
				}
				c.mu.Lock()
				omitTurnID := c.goalUpdatedOmitsTurnID
				c.mu.Unlock()
				if !omitTurnID {
					goalUpdate["turnId"] = turnID
				}
				c.notify(appServerNotifyThreadGoalUpdated, goalUpdate)
				c.notify(appServerNotifyTurnStarted, map[string]any{
					"threadId": "codex-thread-1",
					"turn":     map[string]any{"id": turnID, "status": "inProgress", "items": []any{}},
				})
				if failThisTurn {
					// Simulate a mid-goal turn ending in a transient failure
					// (a tool or model error) while the goal itself remains
					// "active" per codex's own thread state: the turn
					// settles failed but the goal is not paused/completed.
					c.notify(appServerNotifyTurnCompleted, map[string]any{
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
			if notificationsBeforeResponse {
				sendTurnNotifications()
				sendResponse()
			} else {
				sendResponse()
				sendTurnNotifications()
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
	descriptor := codexProviderDescriptorForTest(t)
	wantCommand := descriptor.Runtime.Command
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
	if asString(clientInfo["name"]) != descriptor.Runtime.ClientInfoName || asString(clientInfo["version"]) == "" {
		t.Fatalf("initialize clientInfo = %#v, want name=%q + non-empty version",
			initialize["clientInfo"], descriptor.Runtime.ClientInfoName)
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

func TestCodexAppServerAdapterStartClampsProviderDefaultReasoning(t *testing.T) {
	t.Parallel()

	transport := newScriptedAppServerTransport()
	adapter := NewCodexAppServerAdapter(transport)
	session := testAppServerSession()
	session.Settings = &SessionSettings{ReasoningEffort: "ultra"}
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	threadStart := appServerRequestParams(t, transport.conn, appServerMethodThreadStart)
	if got := asString(threadStart["model"]); got != "gpt-5.1-codex" {
		t.Fatalf("thread/start model = %q, want gpt-5.1-codex", got)
	}
	config, _ := threadStart["config"].(map[string]any)
	if got := asString(config["model_reasoning_effort"]); got != "medium" {
		t.Fatalf("thread/start reasoning effort = %q, want medium", got)
	}
}

func TestCodexAppServerAdapterStartClampsPersistedReasoningForExplicitModel(t *testing.T) {
	t.Parallel()

	transport := newScriptedAppServerTransport()
	adapter := NewCodexAppServerAdapter(transport)
	session := testAppServerSession()
	session.Settings = &SessionSettings{
		Model:           "gpt-5.1-codex-mini",
		ReasoningEffort: "high",
	}
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if requests := appServerRequestParamsList(t, transport.conn, appServerMethodModelList); len(requests) != 1 {
		t.Fatalf("model/list requests = %d, want 1 to validate persisted reasoning", len(requests))
	}
	threadStart := appServerRequestParams(t, transport.conn, appServerMethodThreadStart)
	if got := asString(threadStart["model"]); got != "gpt-5.1-codex-mini" {
		t.Fatalf("thread/start model = %q, want gpt-5.1-codex-mini", got)
	}
	config, _ := threadStart["config"].(map[string]any)
	if got := asString(config["model_reasoning_effort"]); got != "medium" {
		t.Fatalf("thread/start reasoning effort = %q, want catalog default medium", got)
	}
	state := adapter.SessionState(session)
	options, _ := state.RuntimeContext["configOptions"].([]map[string]any)
	reasoning := configOptionByID(options, "reasoning_effort")
	if got := configOptionValues(reasoning); !slices.Equal(got, []string{"low", "medium"}) {
		t.Fatalf("hidden current model reasoning options = %#v, want catalog profile", got)
	}
}

func TestCodexAppServerAdapterResumeClampsPersistedReasoningBeforeRequest(t *testing.T) {
	t.Parallel()

	transport := newScriptedAppServerTransport()
	adapter := NewCodexAppServerAdapter(transport)
	session := testAppServerSession()
	session.ProviderSessionID = "codex-thread-1"
	session.Settings = &SessionSettings{
		Model:           "gpt-5.1-codex-mini",
		ReasoningEffort: "high",
	}
	if err := adapter.Resume(context.Background(), session); err != nil {
		t.Fatalf("Resume: %v", err)
	}
	threadResume := appServerRequestParams(t, transport.conn, appServerMethodThreadResume)
	config, _ := threadResume["config"].(map[string]any)
	if got := asString(config["model_reasoning_effort"]); got != "medium" {
		t.Fatalf("thread/resume reasoning effort = %q, want catalog default medium", got)
	}
}

func TestCodexAppServerAdapterResumeDoesNotInferModelOverrideForPersistedReasoning(t *testing.T) {
	t.Parallel()

	transport := newScriptedAppServerTransport()
	transport.conn.modelList = []any{map[string]any{
		"id":                        "gpt-current-default",
		"model":                     "gpt-current-default",
		"isDefault":                 true,
		"defaultReasoningEffort":    "medium",
		"supportedReasoningEfforts": []any{"low", "medium"},
	}}
	adapter := NewCodexAppServerAdapter(transport)
	session := testAppServerSession()
	session.ProviderSessionID = "codex-thread-1"
	session.Settings = &SessionSettings{ReasoningEffort: "ultra"}

	if err := adapter.Resume(context.Background(), session); err != nil {
		t.Fatalf("Resume: %v", err)
	}
	threadResume := appServerRequestParams(t, transport.conn, appServerMethodThreadResume)
	if got := asString(threadResume["model"]); got != "" {
		t.Fatalf("thread/resume model = %q, want existing thread model preserved", got)
	}
	config, _ := threadResume["config"].(map[string]any)
	if got := asString(config["model_reasoning_effort"]); got != "medium" {
		t.Fatalf("thread/resume reasoning effort = %q, want catalog default medium", got)
	}
	state := adapter.SessionState(session)
	if state.Settings == nil || state.Settings.Model != "gpt-5.1-codex" {
		t.Fatalf("resumed settings = %#v, want model reported by existing thread", state.Settings)
	}
}

func TestCodexAppServerAdapterStartUsesModelFieldForCatalogDefault(t *testing.T) {
	t.Parallel()

	transport := newScriptedAppServerTransport()
	transport.conn.modelList = []any{map[string]any{
		"id":                        "catalog-record-id",
		"model":                     "gpt-default-api-name",
		"displayName":               "Default API Model",
		"isDefault":                 true,
		"defaultReasoningEffort":    "high",
		"supportedReasoningEfforts": []any{"low", "high"},
	}}
	adapter := NewCodexAppServerAdapter(transport)
	session := testAppServerSession()
	session.Settings = &SessionSettings{ReasoningEffort: "ultra"}
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}

	threadStart := appServerRequestParams(t, transport.conn, appServerMethodThreadStart)
	if got := asString(threadStart["model"]); got != "gpt-default-api-name" {
		t.Fatalf("thread/start model = %q, want catalog model field", got)
	}
	config, _ := threadStart["config"].(map[string]any)
	if got := asString(config["model_reasoning_effort"]); got != "high" {
		t.Fatalf("thread/start reasoning effort = %q, want model-specific default high", got)
	}
	state := adapter.SessionState(session)
	options, _ := state.RuntimeContext["configOptions"].([]map[string]any)
	modelOption := configOptionByID(options, "model")
	if got := asString(modelOption["currentValue"]); got != "gpt-default-api-name" {
		t.Fatalf("model current value = %q, want catalog model field", got)
	}
	reasoningOption := configOptionByID(options, "reasoning_effort")
	if got := configOptionValues(reasoningOption); !slices.Equal(got, []string{"low", "high"}) {
		t.Fatalf("reasoning options = %#v, want model-specific catalog values", got)
	}
}

func TestCodexClientInfoParamsPresentsOfficialOriginator(t *testing.T) {
	t.Parallel()

	// A resolved codex version is used verbatim and overrides the host name,
	// so the outbound originator/User-Agent match the genuine codex_cli_rs.
	host := HostMetadata{ClientInfo: ClientInfo{Name: "tutti-desktop", Title: "Tutti", Version: "0.1.0"}}
	descriptor := codexProviderDescriptorForTest(t)
	got := clientInfoParamsForVersion(host, descriptor.Runtime.ClientInfoName, "1.2.3")

	if got["name"] != descriptor.Runtime.ClientInfoName {
		t.Fatalf("name = %v, want %q (official originator, not the host name)", got["name"], descriptor.Runtime.ClientInfoName)
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
	descriptor := codexProviderDescriptorForTest(t)
	got := clientInfoParamsForVersion(host, descriptor.Runtime.ClientInfoName, "")

	if got["name"] != descriptor.Runtime.ClientInfoName {
		t.Fatalf("name = %v, want %q", got["name"], descriptor.Runtime.ClientInfoName)
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

func TestCodexAppServerAdapterExecRoutesAgentTargetMention(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	prompt := "让 [@Codex](mention://agent-target/local:codex?workspaceId=workspace-1) 来 review"

	events, err := adapter.Exec(context.Background(), session, textPrompt(prompt), "", "turn-agent-target", nil, nil)
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}

	turnStart := appServerRequestParams(t, transport.conn, appServerMethodTurnStart)
	input, _ := turnStart["input"].([]any)
	if len(input) != 2 {
		t.Fatalf("turn/start input = %#v, want user prompt plus internal routing prompt", turnStart["input"])
	}
	first, _ := input[0].(map[string]any)
	if asString(first["text"]) != prompt {
		t.Fatalf("turn/start user text = %q, want %q", asString(first["text"]), prompt)
	}
	last, _ := input[len(input)-1].(map[string]any)
	if asString(last["text"]) != tuttiAgentMentionRoutingReminder {
		t.Fatalf("turn/start routing text = %q, want %q", asString(last["text"]), tuttiAgentMentionRoutingReminder)
	}

	userContent := firstUserMessageContent(t, events)
	if userContent != prompt || strings.Contains(userContent, "system-reminder") {
		t.Fatalf("user activity content = %q, want original prompt only", userContent)
	}
}

func TestCodexAppServerAdapterDoesNotProjectInternalMentionRoutingTitle(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	transport.conn.mu.Lock()
	transport.conn.threadName = tuttiMentionRoutingReminder
	transport.conn.mu.Unlock()

	events, err := adapter.Exec(context.Background(), session, textPrompt("inspect repo"), "", "turn-internal-title", nil, nil)
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}

	for _, event := range events {
		if event.Type == activityshared.EventSessionUpdated && event.Payload.Title == tuttiMentionRoutingReminder {
			t.Fatalf("events = %#v, want internal mention routing title excluded from title updates", events)
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
		ReasoningEffort:  "xhigh",
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
	if asString(threadStart["approvalsReviewer"]) != "user" {
		t.Fatalf("thread/start approvalsReviewer = %q, want user", threadStart["approvalsReviewer"])
	}
	config, _ := threadStart["config"].(map[string]any)
	if asString(config["model_reasoning_effort"]) != "xhigh" {
		t.Fatalf("thread/start config = %#v, want model_reasoning_effort=xhigh", config)
	}
	if asString(config["model_reasoning_summary"]) != "auto" {
		t.Fatalf("thread/start config = %#v, want reasoning summaries enabled for inline review on spark", config)
	}
}

func TestCodexAppServerAdapterCommandNetworkAccessPreservesPermissionModes(t *testing.T) {
	t.Parallel()

	tests := []struct {
		mode              string
		threadSandbox     string
		turnSandbox       string
		approvalPolicy    string
		approvalsReviewer string
	}{
		{
			mode:              "read-only",
			threadSandbox:     "read-only",
			turnSandbox:       "readOnly",
			approvalPolicy:    "on-request",
			approvalsReviewer: "user",
		},
		{
			mode:              "auto",
			threadSandbox:     "workspace-write",
			turnSandbox:       "workspaceWrite",
			approvalPolicy:    "on-request",
			approvalsReviewer: "auto_review",
		},
		{
			mode:           "full-access",
			threadSandbox:  "danger-full-access",
			turnSandbox:    "dangerFullAccess",
			approvalPolicy: "never",
		},
	}
	for _, test := range tests {
		t.Run(test.mode, func(t *testing.T) {
			t.Parallel()

			transport := newScriptedAppServerTransport()
			adapter := NewCodexAppServerAdapterWithHostMetadataAndOptions(
				transport,
				LegacyHostMetadata(),
				CodexAppServerAdapterOptions{CommandNetworkAccess: true},
			)
			session := testAppServerSession()
			session.PermissionModeID = test.mode
			session.Settings = &SessionSettings{PermissionModeID: test.mode}

			if _, err := adapter.Start(context.Background(), session); err != nil {
				t.Fatalf("Start: %v", err)
			}
			threadStart := appServerRequestParams(t, transport.conn, appServerMethodThreadStart)
			if got := asString(threadStart["sandbox"]); got != test.threadSandbox {
				t.Fatalf("thread/start sandbox = %q, want %q", got, test.threadSandbox)
			}
			if got := asString(threadStart["approvalPolicy"]); got != test.approvalPolicy {
				t.Fatalf("thread/start approvalPolicy = %q, want %q", got, test.approvalPolicy)
			}
			if got := asString(threadStart["approvalsReviewer"]); got != test.approvalsReviewer {
				t.Fatalf("thread/start approvalsReviewer = %q, want %q", got, test.approvalsReviewer)
			}

			if _, err := adapter.Exec(context.Background(), session, textPrompt("go"), "", "turn-local-1", nil, nil); err != nil {
				t.Fatalf("Exec: %v", err)
			}
			turnStart := appServerRequestParams(t, transport.conn, appServerMethodTurnStart)
			policy, _ := turnStart["sandboxPolicy"].(map[string]any)
			if got := asString(policy["type"]); got != test.turnSandbox {
				t.Fatalf("turn/start sandboxPolicy = %#v, want type %q", policy, test.turnSandbox)
			}
			if test.mode == "full-access" {
				if _, ok := policy["networkAccess"]; ok {
					t.Fatalf("turn/start sandboxPolicy = %#v, want implicit full-access networking", policy)
				}
			} else if enabled, _ := policy["networkAccess"].(bool); !enabled {
				t.Fatalf("turn/start sandboxPolicy = %#v, want networkAccess=true", policy)
			}
		})
	}
}

func TestCodexAppServerAdapterDefaultCommandNetworkAccessRemainsDisabled(t *testing.T) {
	t.Parallel()

	transport := newScriptedAppServerTransport()
	adapter := NewCodexAppServerAdapter(transport)
	session := testAppServerSession()
	session.PermissionModeID = "read-only"
	session.Settings = &SessionSettings{PermissionModeID: "read-only"}

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if _, err := adapter.Exec(context.Background(), session, textPrompt("go"), "", "turn-local-1", nil, nil); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	turnStart := appServerRequestParams(t, transport.conn, appServerMethodTurnStart)
	policy, _ := turnStart["sandboxPolicy"].(map[string]any)
	if _, ok := policy["networkAccess"]; ok {
		t.Fatalf("turn/start sandboxPolicy = %#v, want legacy network default", policy)
	}
}

func TestCodexAppServerReasoningEffortValuePreservesCatalogValues(t *testing.T) {
	t.Parallel()

	if got := codexACPReasoningEffortValue("max"); got != "xhigh" {
		t.Fatalf("legacy codexACPReasoningEffortValue(max) = %q, want xhigh", got)
	}
	for _, value := range []string{"max", "ultra", "deep", "none"} {
		if got := codexAppServerReasoningEffortValue(value); got != value {
			t.Fatalf("codexAppServerReasoningEffortValue(%q) = %q, want %q", value, got, value)
		}
	}
}

func TestAppServerThreadStartParamsPreservesCatalogReasoningEffort(t *testing.T) {
	t.Parallel()

	for _, effort := range []string{"max", "deep"} {
		session := testAppServerSession()
		session.Settings = &SessionSettings{Model: "gpt-5.6-sol", ReasoningEffort: effort}
		params := appServerThreadStartParams(session, "/workspace")
		config, _ := params["config"].(map[string]any)
		if got := asString(config["model_reasoning_effort"]); got != effort {
			t.Fatalf("thread/start reasoning effort = %q, want %q", got, effort)
		}
	}
}

func TestAppServerReasoningEffortForModelPreservesAdvertisedValue(t *testing.T) {
	t.Parallel()

	models := []map[string]any{{
		"id":                        "gpt-future",
		"defaultReasoningEffort":    "medium",
		"supportedReasoningEfforts": []any{"low", "medium", "deep"},
	}}
	if got := appServerReasoningEffortForModel(models, "gpt-future", "deep"); got != "deep" {
		t.Fatalf("appServerReasoningEffortForModel(deep) = %q, want deep", got)
	}
}

func TestAppServerReasoningEffortForModelHonorsAdvertisedEmptyList(t *testing.T) {
	t.Parallel()

	models := []map[string]any{{
		"model":                     "gpt-no-reasoning",
		"supportedReasoningEfforts": []any{},
	}}
	if got := appServerReasoningEffortForModel(models, "gpt-no-reasoning", "high"); got != "" {
		t.Fatalf("appServerReasoningEffortForModel(high) = %q, want empty", got)
	}
	descriptors := codexAppServerConfigOptionDescriptors(models, Session{
		Settings: &SessionSettings{Model: "gpt-no-reasoning", ReasoningEffort: "high"},
	}, nil)
	option := configOptionByID(descriptors, "reasoning_effort")
	if option == nil {
		t.Fatalf("reasoning descriptor missing, want explicit empty live profile")
	}
	if value, ok := option["currentValue"]; !ok || value != nil {
		t.Fatalf("reasoning currentValue = %#v, want nil tombstone", value)
	}
	if values := configOptionValues(option); len(values) != 0 {
		t.Fatalf("reasoning options = %#v, want advertised empty list", values)
	}
}

func TestCodexAppServerAdapterStartAutoPermissionUsesAutoReviewer(t *testing.T) {
	t.Parallel()

	transport := newScriptedAppServerTransport()
	adapter := NewCodexAppServerAdapter(transport)
	session := testAppServerSession()
	session.PermissionModeID = "auto"
	session.Settings = &SessionSettings{
		PermissionModeID: "auto",
	}
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	threadStart := appServerRequestParams(t, transport.conn, appServerMethodThreadStart)
	if asString(threadStart["approvalPolicy"]) != "on-request" {
		t.Fatalf("thread/start approvalPolicy = %q, want on-request", threadStart["approvalPolicy"])
	}
	if asString(threadStart["sandbox"]) != "workspace-write" {
		t.Fatalf("thread/start sandbox = %q, want workspace-write", threadStart["sandbox"])
	}
	if asString(threadStart["approvalsReviewer"]) != "auto_review" {
		t.Fatalf("thread/start approvalsReviewer = %q, want auto_review", threadStart["approvalsReviewer"])
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
	if got := asString(resume["model"]); got != "" {
		t.Fatalf("thread/resume model = %q, want existing thread setting", got)
	}
	if config, ok := resume["config"].(map[string]any); ok {
		if got := asString(config["model_reasoning_effort"]); got != "" {
			t.Fatalf("thread/resume reasoning effort = %q, want existing thread setting", got)
		}
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
	if got, _ := int64Value(contextWindow["usedTokens"]); got != 20453 {
		t.Fatalf("usedTokens = %d, want 20453", got)
	}
	if got, _ := int64Value(contextWindow["totalTokens"]); got != 258400 {
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

func TestCodexAppServerAdapterReleaseLiveSessionClosesClientAndKeepsProviderSession(t *testing.T) {
	t.Parallel()

	transport := newScriptedAppServerTransport()
	adapter := NewCodexAppServerAdapter(transport)
	session := testAppServerSession()
	events, err := adapter.Start(context.Background(), session)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	session = applySessionEvents(session, events)
	if session.ProviderSessionID == "" {
		t.Fatalf("provider session id was not assigned")
	}
	if !adapter.HasLiveSession(session) {
		t.Fatalf("HasLiveSession = false, want true before release")
	}

	if err := adapter.ReleaseLiveSession(context.Background(), session); err != nil {
		t.Fatalf("ReleaseLiveSession: %v", err)
	}
	if adapter.HasLiveSession(session) {
		t.Fatalf("HasLiveSession = true, want false after release")
	}
	if session.ProviderSessionID != "codex-thread-1" {
		t.Fatalf("provider session id = %q, want preserved caller session", session.ProviderSessionID)
	}
	transport.conn.mu.Lock()
	closeCount := transport.conn.closeCount
	transport.conn.mu.Unlock()
	if closeCount == 0 {
		t.Fatalf("connection close count = 0, want client closed")
	}
}

func TestCodexAppServerAdapterReleaseLiveSessionSkipsPendingRequests(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	transport.conn.commandApproval = true
	execDone := make(chan struct{})
	go func() {
		_, _ = adapter.Exec(context.Background(), session, []PromptContentBlock{{
			Type: "text", Text: "clean the build dir",
		}}, "", "turn-local-1", nil, nil)
		close(execDone)
	}()
	waitForCondition(t, func() bool {
		return adapter.getPendingRequest(session.AgentSessionID, "turn-local-1", "approval-1") != nil
	})

	err := adapter.ReleaseLiveSession(context.Background(), session)
	if !errors.Is(err, ErrLiveSessionBusy) {
		t.Fatalf("ReleaseLiveSession error = %v, want ErrLiveSessionBusy", err)
	}
	if !adapter.HasLiveSession(session) {
		t.Fatalf("HasLiveSession = false, want pending request to keep live session")
	}
	if _, err := adapter.SubmitInteractive(context.Background(), session, SubmitInteractiveInput{
		TurnID:    "turn-local-1",
		RequestID: "approval-1",
		OptionID:  "deny",
	}); err != nil {
		t.Fatalf("SubmitInteractive after busy release: %v", err)
	}
	select {
	case <-execDone:
	case <-time.After(5 * time.Second):
		t.Fatal("exec did not finish after resolving pending approval")
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
	if _, ok := turnStart["responsesapiClientMetadata"]; ok {
		t.Fatalf("turn/start responsesapiClientMetadata = %#v, want omitted", turnStart["responsesapiClientMetadata"])
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

	completed := eventsOfType(events, activityshared.EventRootProviderTurnCompleted)
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
	if used, _ := int64Value(contextWindow["usedTokens"]); used != 1000 {
		t.Fatalf("usage usedTokens = %#v, want last.inputTokens (1000)", usage)
	}
	if total, _ := int64Value(contextWindow["totalTokens"]); total != 272000 {
		t.Fatalf("usage totalTokens = %#v", usage)
	}
}

func TestCodexAppServerTurnStartKeepsLargePromptInInputOnly(t *testing.T) {
	t.Parallel()

	longPrompt := strings.Repeat("a", 33*1024)
	params := appServerTurnStartParams(
		Session{},
		"codex-thread-1",
		[]PromptContentBlock{{Type: "text", Text: longPrompt}},
		nil,
		nil,
		"",
		"",
		false,
	)
	if _, ok := params["responsesapiClientMetadata"]; ok {
		t.Fatalf("responsesapiClientMetadata = %#v, want omitted", params["responsesapiClientMetadata"])
	}
	input, ok := params["input"].([]map[string]any)
	if !ok || len(input) != 1 || asString(input[0]["text"]) != longPrompt {
		t.Fatalf("turn/start input did not preserve the full prompt")
	}
}

func TestCodexAppServerAdapterExecIgnoresForeignThreadNotifications(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	transport.conn.foreignThreadNoise = true
	events, err := adapter.Exec(context.Background(), session, []PromptContentBlock{{
		Type: "text",
		Text: "spawn subagents",
	}}, "", "turn-local-1", nil, nil)
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}

	var assistantText string
	for _, event := range eventsOfType(events, activityshared.EventMessageAppended) {
		if event.Payload.Role == activityshared.MessageRoleAssistant {
			assistantText = event.Payload.Content
		}
	}
	if assistantText != "I'll check the repo." {
		t.Fatalf("assistant content = %q, want parent thread message", assistantText)
	}
	if strings.Contains(fmt.Sprintf("%#v", events), `{"n":7}`) {
		t.Fatalf("foreign thread payload leaked into parent events: %#v", events)
	}
}

func TestCodexAppServerAdapterExecSendsTurnOverrides(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	session.PermissionModeID = "full-access"
	session.Settings = &SessionSettings{
		Model:            "gpt-5.6-sol",
		ReasoningEffort:  "ultra",
		PermissionModeID: "full-access",
	}
	if _, err := adapter.Exec(context.Background(), session, []PromptContentBlock{{
		Type: "text", Text: "go",
	}}, "", "turn-local-1", nil, nil); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	turnStart := appServerRequestParams(t, transport.conn, appServerMethodTurnStart)
	if asString(turnStart["model"]) != "gpt-5.6-sol" {
		t.Fatalf("turn/start model = %q", turnStart["model"])
	}
	if asString(turnStart["effort"]) != "ultra" {
		t.Fatalf("turn/start effort = %q", turnStart["effort"])
	}
	if asString(turnStart["approvalPolicy"]) != "never" {
		t.Fatalf("turn/start approvalPolicy = %q, want never", turnStart["approvalPolicy"])
	}
	sandboxPolicy, _ := turnStart["sandboxPolicy"].(map[string]any)
	if asString(sandboxPolicy["type"]) != "dangerFullAccess" {
		t.Fatalf("turn/start sandboxPolicy = %#v", turnStart["sandboxPolicy"])
	}
	if _, ok := turnStart["approvalsReviewer"]; ok {
		t.Fatalf("turn/start approvalsReviewer = %#v, want omitted for full-access", turnStart["approvalsReviewer"])
	}
}

func TestCodexAppServerAdapterExecReadOnlyPermissionUsesUserReviewer(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	session.PermissionModeID = "read-only"
	session.Settings = &SessionSettings{
		PermissionModeID: "read-only",
	}
	if _, err := adapter.Exec(context.Background(), session, []PromptContentBlock{{
		Type: "text", Text: "go",
	}}, "", "turn-local-1", nil, nil); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	turnStart := appServerRequestParams(t, transport.conn, appServerMethodTurnStart)
	if asString(turnStart["approvalPolicy"]) != "on-request" {
		t.Fatalf("turn/start approvalPolicy = %q, want on-request", turnStart["approvalPolicy"])
	}
	sandboxPolicy, _ := turnStart["sandboxPolicy"].(map[string]any)
	if asString(sandboxPolicy["type"]) != "readOnly" {
		t.Fatalf("turn/start sandboxPolicy = %#v", turnStart["sandboxPolicy"])
	}
	if asString(turnStart["approvalsReviewer"]) != "user" {
		t.Fatalf("turn/start approvalsReviewer = %q, want user", turnStart["approvalsReviewer"])
	}
}

func TestCodexAppServerAdapterExecAutoPermissionUsesAutoReviewer(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	session.PermissionModeID = "auto"
	session.Settings = &SessionSettings{
		PermissionModeID: "auto",
	}
	if _, err := adapter.Exec(context.Background(), session, []PromptContentBlock{{
		Type: "text", Text: "go",
	}}, "", "turn-local-1", nil, nil); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	turnStart := appServerRequestParams(t, transport.conn, appServerMethodTurnStart)
	if asString(turnStart["approvalPolicy"]) != "on-request" {
		t.Fatalf("turn/start approvalPolicy = %q, want on-request", turnStart["approvalPolicy"])
	}
	sandboxPolicy, _ := turnStart["sandboxPolicy"].(map[string]any)
	if asString(sandboxPolicy["type"]) != "workspaceWrite" {
		t.Fatalf("turn/start sandboxPolicy = %#v", turnStart["sandboxPolicy"])
	}
	if asString(turnStart["approvalsReviewer"]) != "auto_review" {
		t.Fatalf("turn/start approvalsReviewer = %q, want auto_review", turnStart["approvalsReviewer"])
	}
}

func TestCodexAppServerAdapterExecImagePrompt(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	if err := adapter.ValidatePromptContent(session, []PromptContentBlock{{
		Type: "image", MimeType: "image/png", Path: "/managed/agent-prompt-assets/screen.png",
	}}); err != nil {
		t.Fatalf("ValidatePromptContent path-backed image: %v", err)
	}
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
	failed := eventsOfType(events, activityshared.EventRootProviderTurnCompleted)
	if len(failed) != 1 || failed[0].Payload.TurnOutcome != string(activityshared.TurnOutcomeFailed) {
		t.Fatalf("root provider failed events = %#v, want one failed outcome", failed)
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
	if completed := eventsOfType(events, activityshared.EventRootProviderTurnCompleted); len(completed) != 1 {
		t.Fatalf("turn completed events = %d, want 1 (interrupted outcome)", len(completed))
	} else if completed[0].Payload.TurnOutcome != string(activityshared.TurnOutcomeCanceled) {
		t.Fatalf("turn outcome = %q, want canceled", completed[0].Payload.TurnOutcome)
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
		if completed := eventsOfType(events, activityshared.EventRootProviderTurnCompleted); len(completed) != 1 ||
			completed[0].Payload.TurnOutcome != string(activityshared.TurnOutcomeCanceled) {
			t.Fatalf("expected interrupted turn outcome, got %#v", events)
		}
	case <-time.After(5 * time.Second):
		t.Fatalf("Exec did not finish after interrupt")
	}
}

func TestCodexAppServerAdapterFetchesChildThreadNickname(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	transport.conn.mu.Lock()
	transport.conn.childNicknames = map[string]string{"child-thread-1": "Euclid"}
	transport.conn.mu.Unlock()
	var mu sync.Mutex
	var markers []activityshared.Event
	adapter.SetSessionEventSink(func(_ string, events []activityshared.Event) {
		mu.Lock()
		defer mu.Unlock()
		markers = append(markers, events...)
	})
	appTurn := &codexAppServerActiveTurn{}
	if !adapter.beginActiveTurn(session.AgentSessionID, appTurn) {
		t.Fatal("beginActiveTurn failed")
	}
	defer adapter.endActiveTurn(session.AgentSessionID, appTurn)
	adapter.setSessionActiveTurnID(session.AgentSessionID, appTurn, "turn-1")

	// Registering a child (parent collab item/started) must trigger an async
	// thread/read: codex assigns spawned agents an agentNickname on the Thread
	// object but never pushes it (no thread/name/updated for children).
	reducer := newCodexAppServerReducer(adapter)
	reducer.ReduceNotification(nil, session, "turn-1", acpMessage{
		Method: appServerNotifyItemStarted,
		Params: mustJSONRawMessage(t, map[string]any{
			"threadId": session.ProviderSessionID,
			"turnId":   "turn-1",
			"item": map[string]any{
				"type":              "collabAgentToolCall",
				"id":                "spawn-child-1",
				"tool":              "spawnAgent",
				"status":            "inProgress",
				"receiverThreadIds": []any{"child-thread-1"},
			},
		}),
	}, newACPTurnNormalizer(), nil)

	waitForCondition(t, func() bool {
		mu.Lock()
		defer mu.Unlock()
		for _, event := range markers {
			if event.Type == activityshared.EventSessionUpdated &&
				event.Payload.Title == "Euclid" &&
				event.SessionKind == "child" &&
				event.ParentToolCallID == "spawn-child-1" &&
				event.ProviderSessionID == "child-thread-1" {
				return true
			}
		}
		return false
	})
}

// Pins the terminal contract the settle-path inversion must preserve: a
// normal turn emits exactly one turn-outcome event, delivered through the
// emit sink before Exec returns.
func TestCodexAppServerAdapterEmitsExactlyOneTurnOutcome(t *testing.T) {
	t.Parallel()

	adapter, _, session := startedAppServerAdapter(t)
	var mu sync.Mutex
	var streamed []activityshared.Event
	events, err := adapter.Exec(context.Background(), session, []PromptContentBlock{{
		Type: "text",
		Text: "inspect the repo",
	}}, "", "turn-local-1", func(next []activityshared.Event) {
		mu.Lock()
		defer mu.Unlock()
		streamed = append(streamed, next...)
	}, nil)
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	countOutcomes := func(list []activityshared.Event) int {
		count := 0
		for _, event := range list {
			if event.Type == activityshared.EventRootProviderTurnCompleted {
				count++
			}
		}
		return count
	}
	if got := countOutcomes(events); got != 1 {
		t.Fatalf("returned turn outcome events = %d, want exactly 1", got)
	}
	mu.Lock()
	defer mu.Unlock()
	if got := countOutcomes(streamed); got != 1 {
		t.Fatalf("streamed turn outcome events = %d, want exactly 1", got)
	}
}

// Pins the client-death terminal transition: when the app-server connection
// dies mid-turn, the turn settles as failed instead of hanging.
func TestCodexAppServerAdapterExecSteeredTurnSettlesOnRunningTurnCompletion(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	transport.conn.steeredTurnStart = true

	execDone := make(chan []activityshared.Event, 1)
	go func() {
		events, _ := adapter.Exec(context.Background(), session, []PromptContentBlock{{
			Type: "text", Text: "stop refactoring, just report",
		}}, "", "turn-local-2", nil, nil)
		execDone <- events
	}()
	// The steered turn/start result binds the session to the steer stub id.
	waitForCondition(t, func() bool {
		return adapter.sessionActiveTurnID(session.AgentSessionID) == "turn-steer-stub"
	})

	// The running turn ("turn-1") absorbed the steered input and completes;
	// no other terminal notification will ever arrive for the stub turn.
	transport.conn.completePendingTurn()

	select {
	case events := <-execDone:
		completed := eventsOfType(events, activityshared.EventRootProviderTurnCompleted)
		if len(completed) != 1 {
			t.Fatalf("root provider terminal outcomes = %d, want exactly one", len(completed))
		}
		if completed[0].Payload.TurnOutcome != string(activityshared.TurnOutcomeCompleted) {
			t.Fatalf("steered provider turn settled as %#v, want completed outcome", completed[0])
		}
	case <-time.After(5 * time.Second):
		t.Fatalf("Exec never settled: turn/completed for the running turn was dropped by the provider-turn-id guard")
	}
}

func TestCodexAppServerAdapterDropsEmptyTerminalIDForBoundActiveTurn(t *testing.T) {
	t.Parallel()

	adapter, _, session := startedAppServerAdapter(t)
	appTurn := &codexAppServerActiveTurn{
		turnID:     "turn-local-1",
		session:    session,
		normalizer: newACPTurnNormalizer(),
		phase:      codexAppServerTurnPhaseRunning,
		terminal:   make(chan codexAppServerTurnTerminal, 1),
		terminated: make(chan struct{}),
	}
	if !adapter.beginActiveTurn(session.AgentSessionID, appTurn) {
		t.Fatal("beginActiveTurn failed")
	}
	adapter.setSessionActiveTurnID(session.AgentSessionID, appTurn, "turn-real")
	adapter.confirmSessionActiveTurnStarted(session.AgentSessionID, "turn-real")

	adapter.completeActiveTurn(session.AgentSessionID, map[string]any{"status": "completed"})

	if got := adapter.sessionActiveTurnID(session.AgentSessionID); got != "turn-real" {
		t.Fatalf("active turn id = %q, want turn-real after empty terminal id", got)
	}
	if active := adapter.sessionActiveTurn(session.AgentSessionID); active != appTurn {
		t.Fatalf("active turn = %#v, want original appTurn", active)
	}
	select {
	case terminal := <-appTurn.terminal:
		t.Fatalf("empty terminal id delivered terminal %#v, want drop", terminal)
	default:
	}
}

func TestCodexAppServerAdapterDropsEmptyTerminalIDForUnconfirmedActiveTurn(t *testing.T) {
	t.Parallel()

	adapter, _, session := startedAppServerAdapter(t)
	appTurn := &codexAppServerActiveTurn{
		turnID:     "turn-local-1",
		session:    session,
		normalizer: newACPTurnNormalizer(),
		phase:      codexAppServerTurnPhaseRunning,
		terminal:   make(chan codexAppServerTurnTerminal, 1),
		terminated: make(chan struct{}),
	}
	if !adapter.beginActiveTurn(session.AgentSessionID, appTurn) {
		t.Fatal("beginActiveTurn failed")
	}
	adapter.setSessionActiveTurnID(session.AgentSessionID, appTurn, "turn-steer-stub")

	adapter.completeActiveTurn(session.AgentSessionID, map[string]any{"status": "completed"})

	if got := adapter.sessionActiveTurnID(session.AgentSessionID); got != "turn-steer-stub" {
		t.Fatalf("active turn id = %q, want turn-steer-stub after empty terminal id", got)
	}
	if active := adapter.sessionActiveTurn(session.AgentSessionID); active != appTurn {
		t.Fatalf("active turn = %#v, want original appTurn", active)
	}
	select {
	case terminal := <-appTurn.terminal:
		t.Fatalf("empty terminal id delivered terminal %#v, want drop", terminal)
	default:
	}
}

func TestCodexAppServerAdapterConfirmActiveTurnStartedScopedToBoundID(t *testing.T) {
	t.Parallel()

	adapter, _, session := startedAppServerAdapter(t)
	appTurn := &codexAppServerActiveTurn{}
	if !adapter.beginActiveTurn(session.AgentSessionID, appTurn) {
		t.Fatal("beginActiveTurn failed")
	}
	defer adapter.endActiveTurn(session.AgentSessionID, appTurn)
	adapter.setSessionActiveTurnID(session.AgentSessionID, appTurn, "turn-bound")

	// A turn/started for a different turn (e.g. racing with a steered
	// turn/start rebinding the id in between) must not confirm the current
	// binding — a stub confirmed by mistake would re-wedge the settle path.
	adapter.confirmSessionActiveTurnStarted(session.AgentSessionID, "turn-other")
	if adapter.sessionActiveTurnStartConfirmed(session.AgentSessionID) {
		t.Fatalf("confirmation with a stale provider turn id must not confirm the bound id")
	}

	adapter.confirmSessionActiveTurnStarted(session.AgentSessionID, "turn-bound")
	if !adapter.sessionActiveTurnStartConfirmed(session.AgentSessionID) {
		t.Fatalf("confirmation with the bound provider turn id should confirm")
	}
}

func TestCodexAppServerAdapterClientDeathSettlesTurn(t *testing.T) {
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

	_ = transport.conn.Close()

	select {
	case events := <-execDone:
		outcomes := 0
		for _, event := range events {
			if event.Type == activityshared.EventRootProviderTurnCompleted &&
				event.Payload.TurnOutcome == string(activityshared.TurnOutcomeFailed) {
				outcomes++
			}
		}
		if outcomes != 1 {
			t.Fatalf("turn outcome after client death = %#v, want one failed root provider outcome", events)
		}
	case <-time.After(5 * time.Second):
		t.Fatalf("Exec did not settle after client death")
	}
}

func TestCodexAppServerAdapterCancelInterruptsLinkedChildThreads(t *testing.T) {
	adapter, transport, session := startedAppServerAdapter(t)
	transport.conn.holdTurn = true
	_, _ = adapter.rememberAppServerChildThreads(session, "codex-thread-1", session.AgentSessionID, "turn-local-1", session.AgentSessionID, "turn-local-1", map[string]any{
		"type":              "collabAgentToolCall",
		"id":                "spawn-child-1",
		"receiverThreadIds": []any{"child-thread-1", "child-thread-2"},
	})

	execDone := make(chan []activityshared.Event, 1)
	go func() {
		events, _ := adapter.Exec(context.Background(), session, []PromptContentBlock{{
			Type: "text", Text: "long parent task",
		}}, "", "turn-local-1", nil, nil)
		execDone <- events
	}()

	waitForCondition(t, func() bool {
		return adapter.sessionActiveTurnID(session.AgentSessionID) == "turn-1"
	})
	childOne, _ := adapter.appServerChildThread(session.AgentSessionID, "child-thread-1")
	childTwo, _ := adapter.appServerChildThread(session.AgentSessionID, "child-thread-2")
	cancelResult, err := adapter.CancelTargets(context.Background(), session, []CancelTarget{
		{AgentSessionID: childOne.agentSessionID, TurnID: childOne.turnID},
		{AgentSessionID: childTwo.agentSessionID, TurnID: childTwo.turnID},
		{AgentSessionID: session.AgentSessionID, TurnID: "turn-local-1"},
	}, "user requested")
	if err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	if len(cancelResult.Events) != 2 {
		t.Fatalf("cancel events = %#v, want two child cancel-request transitions", cancelResult.Events)
	}
	for _, event := range cancelResult.Events {
		if event.Type != activityshared.EventTurnUpdated || event.Payload.Metadata["cancelRequested"] != true {
			t.Fatalf("cancel event = %#v, want non-terminal cancel request", event)
		}
	}
	if len(cancelResult.ConfirmedTargets) != 3 {
		t.Fatalf("confirmed targets = %#v, want both children and root", cancelResult.ConfirmedTargets)
	}
	waitForCondition(t, func() bool {
		return len(appServerRequestParamsList(t, transport.conn, appServerMethodTurnInterrupt)) == 3
	})
	requests := appServerRequestParamsList(t, transport.conn, appServerMethodTurnInterrupt)
	byThread := map[string]map[string]any{}
	for _, request := range requests {
		byThread[asString(request["threadId"])] = request
	}
	if asString(byThread["codex-thread-1"]["turnId"]) != "turn-1" {
		t.Fatalf("parent interrupt requests = %#v", requests)
	}
	if asString(byThread["child-thread-1"]["turnId"]) != "" ||
		asString(byThread["child-thread-2"]["turnId"]) != "" {
		t.Fatalf("child interrupt requests = %#v, want empty turnId startup interrupts", requests)
	}
	select {
	case <-execDone:
	case <-time.After(5 * time.Second):
		t.Fatalf("Exec did not finish after interrupt")
	}
}

func TestControllerCodexCancelInterruptsRootAndKnownChildBeforeLocalCleanup(t *testing.T) {
	t.Parallel()

	transport := newScriptedAppServerTransport()
	transport.conn.holdTurn = true
	adapter := NewCodexAppServerAdapter(transport)
	controller := NewController([]Adapter{adapter}, nil)
	started, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderCodex,
		CWD:            "/workspace/room-1",
		Title:          "Codex",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	execResult, err := controller.Exec(context.Background(), ExecInput{
		RoomID:         started.Session.RoomID,
		AgentSessionID: started.Session.AgentSessionID,
		Content:        textPrompt("spawn children serially"),
	})
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	waitForCondition(t, func() bool {
		return adapter.sessionActiveTurnID(started.Session.AgentSessionID) == "turn-1"
	})

	_, _ = adapter.rememberAppServerChildThreads(
		started.Session,
		started.Session.ProviderSessionID,
		started.Session.AgentSessionID,
		execResult.TurnID,
		started.Session.AgentSessionID,
		execResult.TurnID,
		map[string]any{
			"type":              "collabAgentToolCall",
			"id":                "spawn-child-1",
			"receiverThreadIds": []any{"child-thread-1"},
		},
	)
	child, ok := adapter.appServerChildThread(started.Session.AgentSessionID, "child-thread-1")
	if !ok {
		t.Fatal("known child thread was not registered")
	}

	cancelResult, err := controller.Cancel(context.Background(), CancelInput{
		RoomID:             started.Session.RoomID,
		RootAgentSessionID: started.Session.AgentSessionID,
		Targets: []CancelTarget{
			{AgentSessionID: child.agentSessionID, TurnID: child.turnID},
			{AgentSessionID: started.Session.AgentSessionID, TurnID: execResult.TurnID},
		},
		Reason: "user requested",
	})
	if err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	if len(cancelResult.ConfirmedTargets) != 2 {
		t.Fatalf("confirmed targets = %#v, want known child and root", cancelResult.ConfirmedTargets)
	}

	requests := appServerRequestParamsList(t, transport.conn, appServerMethodTurnInterrupt)
	if len(requests) != 2 {
		t.Fatalf("turn/interrupt requests = %#v, want child and root", requests)
	}
	if asString(requests[0]["threadId"]) != started.Session.ProviderSessionID ||
		asString(requests[1]["threadId"]) != "child-thread-1" {
		t.Fatalf("turn/interrupt order = %#v, want root before known child", requests)
	}
	byThread := map[string]map[string]any{}
	for _, request := range requests {
		byThread[asString(request["threadId"])] = request
	}
	if asString(byThread["child-thread-1"]["turnId"]) != "" {
		t.Fatalf("child interrupt = %#v, want startup interrupt without turn id", byThread["child-thread-1"])
	}
	if asString(byThread[started.Session.ProviderSessionID]["turnId"]) != "turn-1" {
		t.Fatalf("root interrupt = %#v, want live provider turn", byThread[started.Session.ProviderSessionID])
	}
}

func TestCodexAppServerAdapterCancelAfterTurnCompletedStillMarksChildrenCanceled(t *testing.T) {
	adapter, transport, session := startedAppServerAdapter(t)
	_, _ = adapter.rememberAppServerChildThreads(session, "codex-thread-1", session.AgentSessionID, "turn-local-1", session.AgentSessionID, "turn-local-1", map[string]any{
		"type":              "collabAgentToolCall",
		"id":                "spawn-child-1",
		"receiverThreadIds": []any{"child-thread-1"},
	})

	// Run a turn to completion so no active turn remains, but children keep
	// running (spawned agents outlive the parent turn).
	if _, err := adapter.Exec(context.Background(), session, []PromptContentBlock{{
		Type: "text", Text: "parent task",
	}}, "", "turn-local-1", nil, nil); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	waitForCondition(t, func() bool {
		return adapter.sessionActiveTurnID(session.AgentSessionID) == ""
	})
	if got := adapter.sessionActiveTurnID(session.AgentSessionID); got != "" {
		t.Fatalf("active turn id after completion = %q, want empty", got)
	}

	child, _ := adapter.appServerChildThread(session.AgentSessionID, "child-thread-1")
	cancelResult, err := adapter.CancelTargets(context.Background(), session, []CancelTarget{
		{AgentSessionID: child.agentSessionID, TurnID: child.turnID},
	}, "user requested")
	if err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	if len(cancelResult.Events) != 1 || cancelResult.Events[0].Type != activityshared.EventTurnUpdated || cancelResult.Events[0].Payload.Metadata["cancelRequested"] != true {
		t.Fatalf("cancel events = %#v, want one non-terminal child cancel request", cancelResult.Events)
	}
	if len(cancelResult.ConfirmedTargets) != 1 {
		t.Fatalf("confirmed targets = %#v, want child", cancelResult.ConfirmedTargets)
	}
	_ = transport
}

func TestCodexAppServerAdapterCancelInterruptsLateUnownedRootTurn(t *testing.T) {
	adapter, transport, session := startedAppServerAdapter(t)
	transport.conn.holdTurn = true

	execDone := make(chan struct{})
	go func() {
		_, _ = adapter.Exec(context.Background(), session, textPrompt("delegate work"), "", "root-turn-1", nil, nil)
		close(execDone)
	}()
	waitForCondition(t, func() bool {
		return adapter.sessionActiveTurnID(session.AgentSessionID) == "turn-1"
	})

	if _, err := adapter.CancelTargets(context.Background(), session, []CancelTarget{{
		AgentSessionID: session.AgentSessionID,
		TurnID:         "root-turn-1",
	}}, "user requested"); err != nil {
		t.Fatalf("CancelTargets: %v", err)
	}
	select {
	case <-execDone:
	case <-time.After(5 * time.Second):
		t.Fatal("Exec did not finish after cancellation")
	}

	appSession := adapter.getSession(session.AgentSessionID)
	reduction := newCodexAppServerReducer(adapter).ReduceNotification(appSession.client, session, "", acpMessage{
		Method: appServerNotifyTurnStarted,
		Params: mustJSONRawMessage(t, map[string]any{
			"threadId": session.ProviderSessionID,
			"turn":     map[string]any{"id": "turn-after-cancel", "status": "inProgress", "items": []any{}},
		}),
	}, nil, nil)
	if len(reduction.Events) != 0 {
		t.Fatalf("late unowned turn events = %#v, want none", reduction.Events)
	}
	if adapter.sessionActiveTurn(session.AgentSessionID) != nil {
		t.Fatal("late unowned turn was adopted after root cancellation")
	}
	waitForCondition(t, func() bool {
		for _, request := range appServerRequestParamsList(t, transport.conn, appServerMethodTurnInterrupt) {
			if asString(request["threadId"]) == session.ProviderSessionID && asString(request["turnId"]) == "turn-after-cancel" {
				return true
			}
		}
		return false
	})
}

func TestCodexAppServerAdapterCancelInterruptsLateChildWithoutCreatingSession(t *testing.T) {
	adapter, transport, session := startedAppServerAdapter(t)
	adapter.markRootTurnCanceled(session.AgentSessionID, "root-turn-1")
	appSession := adapter.getSession(session.AgentSessionID)

	reduction := newCodexAppServerReducer(adapter).ReduceNotification(appSession.client, session, "root-turn-1", acpMessage{
		Method: appServerNotifyItemCompleted,
		Params: mustJSONRawMessage(t, map[string]any{
			"threadId": session.ProviderSessionID,
			"turnId":   "provider-turn-1",
			"item": map[string]any{
				"type":              "collabAgentToolCall",
				"id":                "spawn-after-cancel",
				"tool":              "spawnAgent",
				"status":            "completed",
				"receiverThreadIds": []any{"child-after-cancel"},
			},
		}),
	}, newACPTurnNormalizer(), nil)
	if len(reduction.Events) != 0 {
		t.Fatalf("late child events = %#v, want none", reduction.Events)
	}
	if _, ok := adapter.appServerChildThread(session.AgentSessionID, "child-after-cancel"); ok {
		t.Fatal("late child received a canonical child session context")
	}
	waitForCondition(t, func() bool {
		for _, request := range appServerRequestParamsList(t, transport.conn, appServerMethodTurnInterrupt) {
			if asString(request["threadId"]) == "child-after-cancel" {
				return true
			}
		}
		return false
	})
}

func TestCodexAppServerAdapterNewCanonicalTurnClearsCancelBoundary(t *testing.T) {
	adapter, _, session := startedAppServerAdapter(t)
	adapter.markRootTurnCanceled(session.AgentSessionID, "root-turn-1")
	turn := &codexAppServerActiveTurn{turnID: "root-turn-2"}
	if !adapter.beginActiveTurn(session.AgentSessionID, turn) {
		t.Fatal("beginActiveTurn failed")
	}
	defer adapter.endActiveTurn(session.AgentSessionID, turn)
	if canceledRootTurnID, canceled := adapter.rootTurnCanceled(session.AgentSessionID); canceled {
		t.Fatalf("cancel boundary = %q, want cleared for a new canonical turn", canceledRootTurnID)
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
		completed := eventsOfType(events, activityshared.EventRootProviderTurnCompleted)
		if len(completed) != 1 ||
			completed[0].Payload.TurnOutcome != string(activityshared.TurnOutcomeCanceled) {
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

// TestCodexAppServerAdapterCancelRetriesInterruptOnStaleTurnID reproduces a
// real production incident: our own turn bookkeeping settles a turn locally
// as soon as its Go context is canceled (Cancel/interruptActiveTurn), without
// waiting for the app-server to confirm the turn actually stopped. When a
// slow-to-terminate tool call (live case: wait_agent blocking on several
// dispatched sub-agents) keeps the real app-server turn alive past that
// point, the *next* interrupt we send — aimed at the turn id we believe is
// active — gets rejected with "expected active turn id X but found Y"
// (live-captured, codex 0.142.5, JSON-RPC -32600). Left unhandled, the real
// stale turn is never actually interrupted and keeps running/emitting items
// on its own timeline, which is what left a session stuck reporting "regulat-
// ing next step" long after the visible conversation looked finished. The
// adapter must retry the interrupt against the turn id codex reports as
// actually active.
func TestCodexAppServerAdapterCancelRetriesInterruptOnStaleTurnID(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	transport.conn.holdTurn = true
	// codex reports "turn-stale" as its real active turn, not the "turn-1" id
	// our own bookkeeping expects — mirrors the daemon racing ahead of the
	// app-server's turn teardown.
	transport.conn.interruptTurnIDMismatch = "turn-stale"

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
	select {
	case err := <-cancelReturned:
		if err != nil {
			t.Fatalf("Cancel: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("Cancel did not return")
	}

	waitForCondition(t, func() bool {
		transport.conn.mu.Lock()
		defer transport.conn.mu.Unlock()
		return len(transport.conn.interruptAttempts) >= 2
	})
	transport.conn.mu.Lock()
	attempts := append([]string(nil), transport.conn.interruptAttempts...)
	transport.conn.mu.Unlock()
	if len(attempts) != 2 || attempts[0] != "turn-1" || attempts[1] != "turn-stale" {
		t.Fatalf("interrupt attempts = %#v, want [turn-1 turn-stale]", attempts)
	}

	select {
	case events := <-execDone:
		completed := eventsOfType(events, activityshared.EventRootProviderTurnCompleted)
		if len(completed) != 1 ||
			completed[0].Payload.TurnOutcome != string(activityshared.TurnOutcomeCanceled) {
			t.Fatalf("expected interrupted outcome, got %#v", events)
		}
	case <-time.After(5 * time.Second):
		t.Fatalf("Exec did not finish after retried interrupt")
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
		if completed := eventsOfType(events, activityshared.EventRootProviderTurnCompleted); len(completed) != 1 ||
			completed[0].Payload.TurnOutcome != string(activityshared.TurnOutcomeCanceled) {
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
	// The controller relies on this marker (turnSteeredIntoActiveTurn) to
	// settle the steer submission's turn record: no terminal event will ever
	// arrive for a steered turn id.
	if steered, ok := messages[0].Payload.Metadata["steered"].(bool); !ok || !steered {
		t.Fatalf("steer message metadata = %#v, want steered=true", messages[0].Payload.Metadata)
	}
	if guidance, ok := messages[0].Payload.Metadata["guidance"].(bool); !ok || !guidance {
		t.Fatalf("steer message metadata = %#v, want guidance=true", messages[0].Payload.Metadata)
	}

	transport.conn.completePendingTurn()
	select {
	case <-execDone:
	case <-time.After(5 * time.Second):
		t.Fatalf("original Exec did not finish")
	}
}

func TestCodexAppServerAdapterGuideActiveTurnUsesTurnSteer(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	transport.conn.holdTurn = true

	execDone := make(chan struct{})
	go func() {
		_, _ = adapter.Exec(context.Background(), session, textPrompt("long task"), "", "turn-local-1", nil, nil)
		close(execDone)
	}()
	waitForCondition(t, func() bool {
		return adapter.sessionActiveTurnID(session.AgentSessionID) == "turn-1"
	})

	events, err := adapter.GuideActiveTurn(context.Background(), session, textPrompt("guide current turn"), "", "turn-guidance", nil, nil)
	if err != nil {
		t.Fatalf("GuideActiveTurn: %v", err)
	}
	steer := appServerRequestParams(t, transport.conn, appServerMethodTurnSteer)
	if asString(steer["expectedTurnId"]) != "turn-1" {
		t.Fatalf("turn/steer params = %#v", steer)
	}
	messages := eventsOfType(events, activityshared.EventMessageAppended)
	if len(messages) != 1 {
		t.Fatalf("guidance events = %#v, want one message", events)
	}
	if guidance, ok := messages[0].Payload.Metadata["guidance"].(bool); !ok || !guidance {
		t.Fatalf("guidance metadata = %#v, want guidance=true", messages[0].Payload.Metadata)
	}

	transport.conn.completePendingTurn()
	select {
	case <-execDone:
	case <-time.After(5 * time.Second):
		t.Fatalf("Exec did not finish after guidance")
	}
}

func TestCodexAppServerAdapterGuidanceStartsProviderContinuationOnSameRootTurn(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	if _, err := adapter.Exec(context.Background(), session, textPrompt("delegate work"), "", "root-turn-1", nil, nil); err != nil {
		t.Fatalf("initial Exec: %v", err)
	}
	if got := adapter.sessionActiveTurnID(session.AgentSessionID); got != "" {
		t.Fatalf("provider turn id after completion = %q, want empty", got)
	}
	_, childEvents := adapter.rememberAppServerChildThreads(
		session,
		session.ProviderSessionID,
		session.AgentSessionID,
		"root-turn-1",
		session.AgentSessionID,
		"root-turn-1",
		map[string]any{
			"type":              "collabAgentToolCall",
			"id":                "spawn-child-1",
			"tool":              "spawnAgent",
			"receiverThreadIds": []any{"child-thread-1"},
		},
	)
	if len(childEvents) != 1 || childEvents[0].Type != activityshared.EventSessionStarted {
		t.Fatalf("child creation events = %#v", childEvents)
	}

	var mu sync.Mutex
	var streamed []activityshared.Event
	returned, err := adapter.GuideActiveTurn(
		context.Background(),
		session,
		textPrompt("include the child's findings"),
		"",
		"root-turn-1",
		func(events []activityshared.Event) {
			mu.Lock()
			streamed = append(streamed, events...)
			mu.Unlock()
		},
		nil,
	)
	if err != nil {
		t.Fatalf("GuideActiveTurn: %v", err)
	}
	if len(returned) != 1 || returned[0].Type != activityshared.EventRootProviderTurnStarted ||
		returned[0].Payload.TurnID != "root-turn-1" {
		t.Fatalf("guidance return events = %#v, want provisional provider continuation", returned)
	}

	waitForCondition(t, func() bool {
		mu.Lock()
		defer mu.Unlock()
		for _, event := range streamed {
			if event.Type == activityshared.EventRootProviderTurnCompleted && event.Payload.TurnID == "root-turn-1" {
				return true
			}
		}
		return false
	})
	if requests := appServerRequestParamsList(t, transport.conn, appServerMethodTurnStart); len(requests) < 2 {
		t.Fatalf("turn/start requests = %#v, want initial turn and same-root continuation", requests)
	}
}

func TestCodexAppServerAdapterSteerRoutesAgentTargetMention(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	transport.conn.holdTurn = true

	execDone := make(chan struct{})
	go func() {
		_, _ = adapter.Exec(context.Background(), session, textPrompt("long task"), "", "turn-local-1", nil, nil)
		close(execDone)
	}()
	waitForCondition(t, func() bool {
		return adapter.sessionActiveTurnID(session.AgentSessionID) == "turn-1"
	})

	prompt := "让 [@Codex](mention://agent-target/local:codex?workspaceId=workspace-1) 来看下"
	events, err := adapter.Exec(context.Background(), session, textPrompt(prompt), "", "turn-agent-target-steer", nil, nil)
	if err != nil {
		t.Fatalf("steer Exec: %v", err)
	}
	steer := appServerRequestParams(t, transport.conn, appServerMethodTurnSteer)
	if asString(steer["expectedTurnId"]) != "turn-1" {
		t.Fatalf("turn/steer params = %#v", steer)
	}
	input, _ := steer["input"].([]any)
	if len(input) != 2 {
		t.Fatalf("turn/steer input = %#v, want user prompt plus internal routing prompt", steer["input"])
	}
	first, _ := input[0].(map[string]any)
	if asString(first["text"]) != prompt {
		t.Fatalf("turn/steer user text = %q, want %q", asString(first["text"]), prompt)
	}
	last, _ := input[len(input)-1].(map[string]any)
	if asString(last["text"]) != tuttiAgentMentionRoutingReminder {
		t.Fatalf("turn/steer routing text = %q, want %q", asString(last["text"]), tuttiAgentMentionRoutingReminder)
	}

	userContent := firstUserMessageContent(t, events)
	if userContent != prompt || strings.Contains(userContent, "system-reminder") {
		t.Fatalf("user activity content = %q, want original prompt only", userContent)
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
		return adapter.getPendingRequest(session.AgentSessionID, "turn-local-1", "approval-1") != nil
	})
	state := adapter.SessionState(session)
	if state.PendingInteractive == nil || state.PendingInteractive.Kind != "approval" {
		t.Fatalf("pending interactive = %#v, want approval", state.PendingInteractive)
	}
	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := adapter.SubmitInteractive(canceled, session, SubmitInteractiveInput{
		TurnID:    "turn-local-1",
		RequestID: "approval-1",
		OptionID:  "approve",
	}); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled SubmitInteractive error = %v, want context canceled", err)
	}
	if pending := adapter.getPendingRequest(session.AgentSessionID, "turn-local-1", "approval-1"); pending == nil || pending.disposition() != pendingInteractiveRequestStatePending {
		t.Fatalf("pending disposition after canceled submit = %v, want pending", runtimeInteractiveDisposition(pending))
	}

	result, err := adapter.SubmitInteractive(context.Background(), session, SubmitInteractiveInput{
		TurnID:    "turn-local-1",
		RequestID: "approval-1",
		OptionID:  "approve",
	})
	if err != nil {
		t.Fatalf("SubmitInteractive: %v", err)
	}
	if !result.Accepted || result.OptionID != "approve" {
		t.Fatalf("submit result = %#v", result)
	}

	<-execDone
	waitForCondition(t, func() bool {
		transport.conn.mu.Lock()
		defer transport.conn.mu.Unlock()
		return transport.conn.approvalResponse != nil
	})
	waitForCondition(t, func() bool {
		streamedMu.Lock()
		defer streamedMu.Unlock()
		return len(eventsOfType(streamed, activityshared.EventCallCompleted)) > 0
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
	var sawRequested bool
	for _, event := range streamedCopy {
		if event.Type == activityshared.EventCallStarted &&
			asString(event.Payload.Metadata["callType"]) == "approval" {
			sawWaiting = true
		}
		if event.Type == activityshared.EventInteractionRequested &&
			event.Payload.Interaction != nil &&
			event.Payload.Interaction.RequestID == "approval-1" {
			sawRequested = true
		}
	}
	if !sawWaiting {
		t.Fatalf("approval call.started was not streamed: %#v", streamedCopy)
	}
	if !sawRequested {
		t.Fatalf("approval interaction.requested was not streamed: %#v", streamedCopy)
	}
	if completedCalls := eventsOfType(streamedCopy, activityshared.EventCallCompleted); len(completedCalls) == 0 {
		t.Fatalf("approval resolution missing call.completed: %#v", streamedCopy)
	}
}

func TestCodexAppServerAdapterServerRequestResolvedFailsPendingApprovalWithoutClaimingSuccess(t *testing.T) {
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
		return adapter.getPendingRequest(session.AgentSessionID, "turn-local-1", "approval-1") != nil
	})
	if state := adapter.SessionState(session); state.PendingInteractive == nil {
		t.Fatalf("pending interactive should be visible before serverRequest/resolved")
	}

	transport.conn.notify(appServerNotifyServerRequestResolved, map[string]any{
		"threadId":  "codex-thread-1",
		"requestId": "approval-1",
	})
	waitForCondition(t, func() bool {
		return adapter.InteractiveDisposition(session, "turn-local-1", "approval-1") == InteractiveDispositionSuperseded
	})
	// The provider resolved this request without ever telling tutti the
	// decision, so we must not claim the underlying call succeeded (that
	// previously rendered a phantom "completed" file-output card even
	// though nothing was actually written). It should surface as failed.
	waitForCondition(t, func() bool {
		streamedMu.Lock()
		defer streamedMu.Unlock()
		return len(eventsOfType(streamed, activityshared.EventCallFailed)) > 0
	})
	streamedMu.Lock()
	if completedCalls := eventsOfType(streamed, activityshared.EventCallCompleted); len(completedCalls) > 0 {
		streamedMu.Unlock()
		t.Fatalf("serverRequest/resolved with no known decision must not emit call.completed: %#v", completedCalls)
	}
	streamedMu.Unlock()
	if state := adapter.SessionState(session); state.PendingInteractive != nil {
		t.Fatalf("pending interactive after serverRequest/resolved = %#v, want nil", state.PendingInteractive)
	}
	transport.conn.mu.Lock()
	response := transport.conn.approvalResponse
	transport.conn.mu.Unlock()
	if response != nil {
		t.Fatalf("out-of-band resolved request should not send approval response, got %#v", response)
	}

	transport.conn.completePendingTurn()
	events := <-execDone
	if failedCalls := eventsOfType(events, activityshared.EventCallFailed); len(failedCalls) == 0 {
		t.Fatalf("serverRequest/resolved missing call.failed: %#v", events)
	}
	if completedCalls := eventsOfType(events, activityshared.EventCallCompleted); len(completedCalls) > 0 {
		t.Fatalf("serverRequest/resolved with no known decision must not emit call.completed: %#v", completedCalls)
	}
}

func TestCodexAppServerAdapterUnsupportedServerRequestFailsCall(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	transport.conn.holdTurn = true

	var streamed []activityshared.Event
	var streamedMu sync.Mutex
	execDone := make(chan []activityshared.Event, 1)
	go func() {
		events, _ := adapter.Exec(context.Background(), session, []PromptContentBlock{{
			Type: "text", Text: "run it",
		}}, "", "turn-local-1", func(next []activityshared.Event) {
			streamedMu.Lock()
			streamed = append(streamed, next...)
			streamedMu.Unlock()
		}, nil)
		execDone <- events
	}()
	waitForCondition(t, func() bool {
		return adapter.sessionActiveTurnID(session.AgentSessionID) == "turn-1"
	})

	transport.conn.sendJSON(map[string]any{
		"id":     "unsupported-1",
		"method": "item/unknown/requestApproval",
		"params": map[string]any{
			"threadId": "codex-thread-1",
			"turnId":   "turn-1",
		},
	})
	waitForCondition(t, func() bool {
		streamedMu.Lock()
		defer streamedMu.Unlock()
		return len(eventsOfType(streamed, activityshared.EventCallFailed)) > 0
	})

	events := <-execDone
	failedCalls := eventsOfType(events, activityshared.EventCallFailed)
	if len(failedCalls) == 0 {
		t.Fatalf("unsupported server request missing call.failed: %#v", events)
	}
	errorPayload := payloadObject(failedCalls[0].Payload.Metadata["error"])
	if got := asString(errorPayload["method"]); got != "item/unknown/requestApproval" {
		t.Fatalf("unsupported request error method = %q", got)
	}
	transport.conn.mu.Lock()
	response := transport.conn.approvalResponse
	transport.conn.mu.Unlock()
	if response == nil || payloadObject(response["error"]) == nil {
		t.Fatalf("unsupported server request response = %#v, want JSON-RPC error", response)
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
			return adapter.getPendingRequest(session.AgentSessionID, "turn-local-1", "approval-1") != nil
		})
		if _, err := adapter.SubmitInteractive(context.Background(), session, SubmitInteractiveInput{
			TurnID:    "turn-local-1",
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
		return adapter.getPendingRequest(session.AgentSessionID, "turn-local-1", "question-1") != nil
	})
	state := adapter.SessionState(session)
	if state.PendingInteractive == nil || state.PendingInteractive.Kind != "ask-user" {
		t.Fatalf("pending interactive = %#v, want ask-user", state.PendingInteractive)
	}

	// Mirror the GUI contract: `answers` is a flat display list and the
	// per-question map lives under answersByQuestionId.
	if _, err := adapter.SubmitInteractive(context.Background(), session, SubmitInteractiveInput{
		TurnID:    "turn-local-1",
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
	bannerIndex := -1
	progressIndex := -1
	terminalIndex := -1
	for index, event := range events {
		if event.Payload.Content == "Compacting context." && progressIndex == -1 {
			progressIndex = index
		}
		if event.Payload.Content == "Context compacted." {
			gotCompactedBanner = true
			bannerIndex = index
		}
		if event.Type == activityshared.EventTurnCompleted && terminalIndex == -1 {
			terminalIndex = index
		}
	}
	if !gotCompactedBanner {
		t.Fatalf("expected 'Context compacted.' banner in compact events; got %#v", events)
	}
	if progressIndex == -1 || progressIndex > bannerIndex {
		t.Fatalf("compacting progress banner index = %d, completed banner index = %d, events = %#v", progressIndex, bannerIndex, events)
	}
	if terminalIndex == -1 || bannerIndex == -1 || bannerIndex > terminalIndex {
		t.Fatalf("compact banner index = %d, terminal index = %d, events = %#v", bannerIndex, terminalIndex, events)
	}
	if completed := eventsOfType(events, activityshared.EventTurnCompleted); len(completed) != 1 {
		t.Fatalf("compact turn completed events = %d, want 1", len(completed))
	}
}

// Codex app-server frequently finishes thread/compact/start (turn/started →
// turn/completed) without ever streaming a contextCompaction item/started or
// item/completed notification. This used to leave /compact completely
// invisible in the transcript: no "Compacting context." banner (nothing
// rendered while it ran) and no "Context compacted." banner (nothing showed
// it finished either), because both banners were driven exclusively by the
// server's item notifications. The client must show the progress banner up
// front and settle it at turn completion even when the server stays silent.
func TestCodexAppServerAdapterSlashCompactWhenServerStaysSilent(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	transport.conn.compactSilent = true
	events, err := adapter.Exec(context.Background(), session, []PromptContentBlock{{
		Type: "text", Text: "/compact",
	}}, "", "turn-local-1", nil, nil)
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}

	var progressCount, completedCount int
	var progressMessageID, completedMessageID string
	for _, event := range events {
		switch event.Payload.Content {
		case "Compacting context.":
			progressCount++
			progressMessageID = asString(event.Payload.Metadata["messageId"])
		case "Context compacted.":
			completedCount++
			completedMessageID = asString(event.Payload.Metadata["messageId"])
		}
	}
	if progressCount != 1 {
		t.Fatalf("progress banners = %d, want exactly 1 (silent server must not leave /compact invisible); events = %#v", progressCount, events)
	}
	if completedCount != 1 {
		t.Fatalf("completed banners = %d, want exactly 1 (silent server must still settle the banner); events = %#v", completedCount, events)
	}
	if progressMessageID == "" || progressMessageID != completedMessageID {
		t.Fatalf("messageId mismatch: progress %q, completed %q", progressMessageID, completedMessageID)
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
	if completed := eventsOfType(events, activityshared.EventRootProviderTurnCompleted); len(completed) != 1 {
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

	if completed := eventsOfType(events, activityshared.EventRootProviderTurnCompleted); len(completed) != 1 {
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

func TestCodexAppServerAdapterSlashReviewUncommittedKeyword(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	if _, err := adapter.Exec(context.Background(), session, []PromptContentBlock{{
		Type: "text", Text: "/review uncommitted",
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
	if completed := eventsOfType(events, activityshared.EventRootProviderTurnCompleted); len(completed) != 1 {
		t.Fatalf("goal turn completed events = %d, want 1", len(completed))
	}
}

func TestCodexAppServerAdapterSlashGoalContinuesUntilTerminalGoal(t *testing.T) {
	adapter, transport, session := startedAppServerAdapter(t)
	adapter.replaceGoalOperationIdentity(session.AgentSessionID, "goal-op-continuation", 1, 0)
	adapter.goalContinuationGraceWindow = 50 * time.Millisecond
	transport.conn.goalStartsTurn = true
	transport.conn.goalNotificationsBeforeResponse = true
	transport.conn.goalCompletionAfterTurns = 2

	var sinkMu sync.Mutex
	sinkEvents := []activityshared.Event{}
	adapter.SetSessionEventSink(func(_ string, events []activityshared.Event) {
		sinkMu.Lock()
		defer sinkMu.Unlock()
		sinkEvents = append(sinkEvents, events...)
	})

	events, err := adapter.Exec(context.Background(), session, []PromptContentBlock{{
		Type: "text", Text: "/goal finish the DrawingML pass",
	}}, "", "turn-local-goal", nil, nil)
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}

	// Exec settles after the goal's FIRST turn; continuation turns are
	// codex-driven, nudged when codex does not self-continue, and adopted by
	// the reducer as their own turns.
	if completed := eventsOfType(events, activityshared.EventRootProviderTurnCompleted); len(completed) != 1 {
		t.Fatalf("first goal turn completed events = %d, want 1", len(completed))
	}
	firstMessages := []string{}
	for _, event := range eventsOfType(events, activityshared.EventMessageAppended) {
		if event.Payload.Role == activityshared.MessageRoleAssistant &&
			event.Payload.Metadata["streamState"] == messageStreamStateCompleted {
			firstMessages = append(firstMessages, event.Payload.Content)
		}
	}
	if strings.Join(firstMessages, "\n") != "I'll work on the goal." {
		t.Fatalf("first turn assistant messages = %#v", firstMessages)
	}

	// The continuation nudge re-sends goal/set; the mock then starts the
	// second turn, which must be adopted and stream through the session sink.
	deadline := time.Now().Add(15 * time.Second)
	for {
		sinkMu.Lock()
		adoptedCompleted := ""
		adoptedStarted := false
		for _, event := range sinkEvents {
			if event.Type == activityshared.EventTurnStarted && event.Payload.Metadata["goalContinuation"] == true {
				adoptedStarted = true
			}
			if event.Type == activityshared.EventMessageAppended &&
				event.Payload.Role == activityshared.MessageRoleAssistant &&
				event.Payload.Metadata["streamState"] == messageStreamStateCompleted {
				adoptedCompleted = event.Payload.Content
			}
		}
		sinkMu.Unlock()
		if adoptedStarted && adoptedCompleted == "Goal complete." {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("adopted continuation turn did not complete; started=%v message=%q", adoptedStarted, adoptedCompleted)
		}
		time.Sleep(10 * time.Millisecond)
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
}

// A mid-goal turn that settles failed (a transient tool/model error) while
// codex's own thread state still reports the goal active must not strand the
// goal: the continuation nudge has to fire on a failed settle exactly like it
// does on a clean completion, or the goal stops advancing for good with no
// further signal ("goal 执行一半不动了").
func TestCodexAppServerAdapterGoalContinuesAfterMidGoalTurnFailure(t *testing.T) {
	adapter, transport, session := startedAppServerAdapter(t)
	adapter.replaceGoalOperationIdentity(session.AgentSessionID, "goal-op-failure-continuation", 1, 0)
	adapter.goalContinuationGraceWindow = 50 * time.Millisecond
	transport.conn.goalStartsTurn = true
	transport.conn.goalNotificationsBeforeResponse = true
	transport.conn.goalTurnFailAtTurn = 2
	transport.conn.goalCompletionAfterTurns = 3

	var sinkMu sync.Mutex
	sinkEvents := []activityshared.Event{}
	adapter.SetSessionEventSink(func(_ string, events []activityshared.Event) {
		sinkMu.Lock()
		defer sinkMu.Unlock()
		sinkEvents = append(sinkEvents, events...)
	})

	events, err := adapter.Exec(context.Background(), session, []PromptContentBlock{{
		Type: "text", Text: "/goal finish the DrawingML pass",
	}}, "", "turn-local-goal", nil, nil)
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	if completed := eventsOfType(events, activityshared.EventRootProviderTurnCompleted); len(completed) != 1 {
		t.Fatalf("first goal turn completed events = %d, want 1", len(completed))
	}

	// The second turn (adopted, codex-driven) settles failed. Without the
	// fix, finalizeSettledTurn only nudged on a clean completion, so this
	// failed settle would never schedule a continuation and the goal would
	// hang here forever.
	deadline := time.Now().Add(15 * time.Second)
	for {
		sinkMu.Lock()
		failedSeen := false
		for _, event := range sinkEvents {
			if event.Type == activityshared.EventRootProviderTurnCompleted &&
				event.Payload.TurnOutcome == string(activityshared.TurnOutcomeFailed) {
				failedSeen = true
			}
		}
		sinkMu.Unlock()
		if failedSeen {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("adopted continuation turn did not settle failed")
		}
		time.Sleep(10 * time.Millisecond)
	}

	// The nudge must still fire after the failed settle and drive the goal to
	// its third, successful turn.
	deadline = time.Now().Add(15 * time.Second)
	for {
		sinkMu.Lock()
		adoptedCompleted := ""
		for _, event := range sinkEvents {
			if event.Type == activityshared.EventMessageAppended &&
				event.Payload.Role == activityshared.MessageRoleAssistant &&
				event.Payload.Metadata["streamState"] == messageStreamStateCompleted {
				adoptedCompleted = event.Payload.Content
			}
		}
		sinkMu.Unlock()
		if adoptedCompleted == "Goal complete." {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("goal did not continue past the failed turn to completion")
		}
		time.Sleep(10 * time.Millisecond)
	}

	// initial /goal (turn 1) + nudge after turn 1 (turn 2, fails) + nudge
	// after turn 2's failure (turn 3, completes the goal). The nudge
	// scheduled after turn 3 sees the goal already "complete" and returns
	// before sending a fourth RPC.
	goalSets := appServerRequestParamsList(t, transport.conn, appServerMethodThreadGoalSet)
	if len(goalSets) != 3 {
		t.Fatalf("goal/set requests = %d, want 3", len(goalSets))
	}
}

func TestCodexGoalContinuationNudgeDropsSupersededRevision(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	adapter.goalContinuationGraceWindow = 30 * time.Millisecond
	adapter.applyGoalUpdate(session.AgentSessionID, map[string]any{"objective": "first", "status": "active"})
	adapter.replaceGoalOperationIdentity(session.AgentSessionID, "goal-op-1", 1, 0)
	adapter.scheduleGoalContinuationNudge(session)

	// A newer desired revision wins before the old timer fires. The goal may
	// still be active, so only the revision guard prevents a stale RPC.
	adapter.replaceGoalOperationIdentity(session.AgentSessionID, "goal-op-2", 2, 0)
	time.Sleep(100 * time.Millisecond)
	if requests := appServerRequestParamsList(t, transport.conn, appServerMethodThreadGoalSet); len(requests) != 0 {
		t.Fatalf("superseded nudge emitted goal/set requests = %#v", requests)
	}
}

func TestCodexGoalSetAdoptsTurnWhenGoalUpdatedOmitsTurnID(t *testing.T) {
	adapter, transport, session := startedAppServerAdapter(t)
	adapter.goalContinuationGraceWindow = time.Hour
	transport.conn.mu.Lock()
	transport.conn.goalStartsTurn = true
	transport.conn.goalCompletionAfterTurns = 2
	transport.conn.goalUpdatedOmitsTurnID = true
	transport.conn.mu.Unlock()

	var sinkMu sync.Mutex
	var sinkEvents []activityshared.Event
	adapter.SetSessionEventSink(func(_ string, events []activityshared.Event) {
		sinkMu.Lock()
		defer sinkMu.Unlock()
		sinkEvents = append(sinkEvents, events...)
	})

	_, err := adapter.ApplyGoal(context.Background(), session, GoalApplyInput{
		Action: GoalControlSet, Objective: "ship the compatibility fix",
		OperationID: "goal-op-no-turn-id", Revision: 1,
	})
	if err != nil {
		t.Fatalf("ApplyGoal: %v", err)
	}

	waitForCondition(t, func() bool {
		sinkMu.Lock()
		defer sinkMu.Unlock()
		for _, event := range sinkEvents {
			if event.Type == activityshared.EventMessageAppended &&
				event.Payload.Role == activityshared.MessageRoleAssistant &&
				event.Payload.Content == "I'll work on the goal." {
				return true
			}
		}
		return false
	})

	sinkMu.Lock()
	foundClaimedTurn := false
	for _, event := range sinkEvents {
		if event.Type == activityshared.EventTurnStarted &&
			event.Payload.Metadata["sourceGoalOperationId"] == "goal-op-no-turn-id" &&
			event.Payload.Metadata["goalProvenanceMode"] == "ordered_goal_continuation_claim" {
			foundClaimedTurn = true
		}
	}
	sinkMu.Unlock()
	if !foundClaimedTurn {
		t.Fatalf("missing compatibility-provenance turn start: %#v", sinkEvents)
	}
	if requests := appServerRequestParamsList(t, transport.conn, appServerMethodTurnInterrupt); len(requests) != 0 {
		t.Fatalf("goal turn without notification turnId was interrupted: %#v", requests)
	}
}

func TestNormalizeCodexGoalObservationUsesCanonicalSessionFields(t *testing.T) {
	t.Parallel()

	goal := normalizedCodexGoal(map[string]any{
		"threadId":        "codex-thread-1",
		"objective":       "ship it",
		"status":          "usage_limited",
		"tokenBudget":     int64(200000),
		"tokensUsed":      int64(116818),
		"timeUsedSeconds": int64(163),
		"createdAt":       int64(1750000000),
		"updatedAt":       int64(1750000001),
	})

	if got := asString(goal["objective"]); got != "ship it" {
		t.Fatalf("objective = %q, want ship it", got)
	}
	if got := asString(goal["status"]); got != "usageLimited" {
		t.Fatalf("status = %q, want usageLimited", got)
	}
	if got, ok := int64Value(goal["durationMs"]); !ok || got != 163000 {
		t.Fatalf("durationMs = %#v, want 163000", goal["durationMs"])
	}
	if got, ok := int64Value(goal["tokens"]); !ok || got != 116818 {
		t.Fatalf("tokens = %#v, want 116818", goal["tokens"])
	}
	for _, providerField := range []string{
		"threadId", "tokenBudget", "tokensUsed", "timeUsedSeconds", "createdAt", "updatedAt",
	} {
		if _, exists := goal[providerField]; exists {
			t.Fatalf("canonical goal retained provider field %q: %#v", providerField, goal)
		}
	}

	// Normalization is idempotent because status-only local updates may pass a
	// previously normalized snapshot back through applyGoalUpdate.
	normalizedAgain := normalizedCodexGoal(goal)
	if got, ok := int64Value(normalizedAgain["durationMs"]); !ok || got != 163000 {
		t.Fatalf("idempotent durationMs = %#v, want 163000", normalizedAgain["durationMs"])
	}
	if got, ok := int64Value(normalizedAgain["tokens"]); !ok || got != 116818 {
		t.Fatalf("idempotent tokens = %#v, want 116818", normalizedAgain["tokens"])
	}
}

func TestCodexGoalContinuationClaimChainsAcrossSettledTurns(t *testing.T) {
	adapter, _, session := startedAppServerAdapter(t)
	identity := goalOperationIdentity{operationID: "goal-op-chain", revision: 3}
	adapter.replaceGoalOperationIdentity(session.AgentSessionID, identity.operationID, identity.revision, 0)
	adapter.applyGoalUpdate(session.AgentSessionID, map[string]any{
		"threadId":  session.ProviderSessionID,
		"objective": "finish the chain",
		"status":    "active",
	})
	adapter.armGoalContinuationClaim(session.AgentSessionID, identity)

	appSession := adapter.getSession(session.AgentSessionID)
	reducer := newCodexAppServerReducer(adapter)
	startTurn := func(providerTurnID string) {
		reducer.ReduceNotification(appSession.client, session, "", acpMessage{
			Method: appServerNotifyTurnStarted,
			Params: mustJSONRawMessage(t, map[string]any{
				"threadId": session.ProviderSessionID,
				"turn":     map[string]any{"id": providerTurnID, "status": "inProgress", "items": []any{}},
			}),
		}, nil, nil)
	}

	startTurn("provider-goal-chain-1")
	waitForCondition(t, func() bool {
		return adapter.sessionActiveTurnID(session.AgentSessionID) == "provider-goal-chain-1"
	})
	reducer.ReduceNotification(appSession.client, session, "", acpMessage{
		Method: appServerNotifyTurnCompleted,
		Params: mustJSONRawMessage(t, map[string]any{
			"threadId": session.ProviderSessionID,
			"turn":     map[string]any{"id": "provider-goal-chain-1", "status": "completed", "items": []any{}},
		}),
	}, nil, nil)
	waitForCondition(t, func() bool {
		return adapter.sessionActiveTurn(session.AgentSessionID) == nil
	})

	startTurn("provider-goal-chain-2")
	waitForCondition(t, func() bool {
		active := adapter.sessionActiveTurn(session.AgentSessionID)
		return active != nil &&
			adapter.sessionActiveTurnID(session.AgentSessionID) == "provider-goal-chain-2" &&
			active.goalIdentity == identity &&
			active.goalProvenance == "ordered_goal_continuation_claim"
	})
}

func TestCodexGoalContinuationClaimRejectsSupersededRevision(t *testing.T) {
	adapter, transport, session := startedAppServerAdapter(t)
	adapter.goalProvenanceGraceWindow = 10 * time.Millisecond
	oldIdentity := goalOperationIdentity{operationID: "goal-op-old-claim", revision: 1}
	adapter.replaceGoalOperationIdentity(session.AgentSessionID, oldIdentity.operationID, oldIdentity.revision, 0)
	adapter.applyGoalUpdate(session.AgentSessionID, map[string]any{
		"threadId":  session.ProviderSessionID,
		"objective": "old",
		"status":    "active",
	})
	adapter.armGoalContinuationClaim(session.AgentSessionID, oldIdentity)
	adapter.replaceGoalOperationIdentity(session.AgentSessionID, "goal-op-new-claim", 2, 0)

	appSession := adapter.getSession(session.AgentSessionID)
	reducer := newCodexAppServerReducer(adapter)
	reducer.ReduceNotification(appSession.client, session, "", acpMessage{
		Method: appServerNotifyTurnStarted,
		Params: mustJSONRawMessage(t, map[string]any{
			"threadId": session.ProviderSessionID,
			"turn":     map[string]any{"id": "provider-delayed-old", "status": "inProgress", "items": []any{}},
		}),
	}, nil, nil)

	waitForCondition(t, func() bool {
		for _, request := range appServerRequestParamsList(t, transport.conn, appServerMethodTurnInterrupt) {
			if asString(request["turnId"]) == "provider-delayed-old" {
				return true
			}
		}
		return false
	})
	if active := adapter.sessionActiveTurn(session.AgentSessionID); active != nil {
		t.Fatalf("superseded claim adopted delayed turn: %#v", active)
	}
}

func TestCodexPreparedGoalContinuationClaimDefersPendingTurnExpiry(t *testing.T) {
	adapter, transport, session := startedAppServerAdapter(t)
	adapter.goalProvenanceGraceWindow = 10 * time.Millisecond
	identity := goalOperationIdentity{operationID: "goal-op-preparing", revision: 1}
	adapter.replaceGoalOperationIdentity(session.AgentSessionID, identity.operationID, identity.revision, 0)
	adapter.applyGoalUpdate(session.AgentSessionID, map[string]any{
		"threadId":  session.ProviderSessionID,
		"objective": "wait for durable binding",
		"status":    "active",
	})
	adapter.prepareGoalContinuationClaim(session.AgentSessionID, identity)

	appSession := adapter.getSession(session.AgentSessionID)
	reducer := newCodexAppServerReducer(adapter)
	reducer.ReduceNotification(appSession.client, session, "", acpMessage{
		Method: appServerNotifyTurnStarted,
		Params: mustJSONRawMessage(t, map[string]any{
			"threadId": session.ProviderSessionID,
			"turn":     map[string]any{"id": "provider-preparing", "status": "inProgress", "items": []any{}},
		}),
	}, nil, nil)

	time.Sleep(35 * time.Millisecond)
	if requests := appServerRequestParamsList(t, transport.conn, appServerMethodTurnInterrupt); len(requests) != 0 {
		t.Fatalf("prepared claim allowed pending turn to expire: %#v", requests)
	}
	if active := adapter.sessionActiveTurn(session.AgentSessionID); active != nil {
		t.Fatalf("prepared claim adopted before durable binding: %#v", active)
	}

	adapter.armGoalContinuationClaim(session.AgentSessionID, identity)
	waitForCondition(t, func() bool {
		return adapter.sessionActiveTurnID(session.AgentSessionID) == "provider-preparing"
	})
}

// A server-initiated turn/started with no registered turn context and no goal
// keeps the legacy drop behavior (stray turns such as compaction).
func TestCodexAppServerAdapterUnownedTurnIgnoredWithoutGoal(t *testing.T) {
	t.Parallel()

	adapter, _, session := startedAppServerAdapter(t)
	var sinkMu sync.Mutex
	sinkEvents := []activityshared.Event{}
	adapter.SetSessionEventSink(func(_ string, events []activityshared.Event) {
		sinkMu.Lock()
		defer sinkMu.Unlock()
		sinkEvents = append(sinkEvents, events...)
	})

	reducer := newCodexAppServerReducer(adapter)
	reducer.ReduceNotification(nil, session, "", acpMessage{
		Method: appServerNotifyTurnStarted,
		Params: mustJSONRawMessage(t, map[string]any{
			"threadId": session.ProviderSessionID,
			"turn":     map[string]any{"id": "turn-stray", "status": "inProgress", "items": []any{}},
		}),
	}, nil, nil)

	if adapter.sessionActiveTurn(session.AgentSessionID) != nil {
		t.Fatalf("stray turn without goal must not be adopted")
	}
	sinkMu.Lock()
	defer sinkMu.Unlock()
	if len(sinkEvents) != 0 {
		t.Fatalf("stray turn without goal emitted events: %#v", sinkEvents)
	}
}

// A server-initiated turn/started while the goal is paused (Stop pressed) is
// interrupted instead of adopted, so codex cannot keep running a stopped goal.
func TestCodexAppServerAdapterUnownedTurnInterruptedForPausedGoal(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	adapter.applyGoalUpdate(session.AgentSessionID, map[string]any{
		"objective": "finish it",
		"status":    "paused",
	})

	appSession := adapter.getSession(session.AgentSessionID)
	reducer := newCodexAppServerReducer(adapter)
	reducer.ReduceNotification(appSession.client, session, "", acpMessage{
		Method: appServerNotifyTurnStarted,
		Params: mustJSONRawMessage(t, map[string]any{
			"threadId": session.ProviderSessionID,
			"turn":     map[string]any{"id": "turn-paused-goal", "status": "inProgress", "items": []any{}},
		}),
	}, nil, nil)

	if adapter.sessionActiveTurn(session.AgentSessionID) != nil {
		t.Fatalf("paused-goal turn must not be adopted")
	}
	waitForCondition(t, func() bool {
		requests := appServerRequestParamsList(t, transport.conn, appServerMethodTurnInterrupt)
		for _, request := range requests {
			if asString(request["turnId"]) == "turn-paused-goal" {
				return true
			}
		}
		return false
	})
}

// Cancel must pause an active goal before interrupting the turn, so codex does
// not auto-start the next goal turn right after the interrupt.
func TestCodexAppServerAdapterCancelPausesActiveGoal(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	transport.conn.holdTurn = true
	adapter.applyGoalUpdate(session.AgentSessionID, map[string]any{
		"objective": "finish it",
		"status":    "active",
	})

	execDone := make(chan struct{})
	go func() {
		defer close(execDone)
		_, _ = adapter.Exec(context.Background(), session, []PromptContentBlock{{
			Type: "text", Text: "long task",
		}}, "", "turn-local-1", nil, nil)
	}()
	waitForCondition(t, func() bool {
		return adapter.sessionActiveTurnID(session.AgentSessionID) == "turn-1"
	})

	events, err := adapter.Cancel(context.Background(), session, "user requested")
	if err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	goalSet := appServerRequestParams(t, transport.conn, appServerMethodThreadGoalSet)
	if asString(goalSet["status"]) != "paused" {
		t.Fatalf("goal/set params = %#v, want paused status", goalSet)
	}
	if status := asString(adapter.sessionGoal(session.AgentSessionID)["status"]); status != "paused" {
		t.Fatalf("in-memory goal status = %q, want paused", status)
	}
	foundGoalEvent := false
	for _, event := range events {
		if event.Type == activityshared.EventSessionUpdated &&
			event.Payload.Metadata["sessionUpdateKind"] == "thread_goal_update" {
			foundGoalEvent = true
		}
	}
	if !foundGoalEvent {
		t.Fatalf("Cancel events missing thread_goal_update, got %#v", events)
	}
	select {
	case <-execDone:
	case <-time.After(5 * time.Second):
		t.Fatalf("Exec did not finish after interrupt")
	}
}

// Mid-turn /goal commands are thread-level control operations: they must run
// the goal RPC instead of being steered into the active turn as prompt text.
func TestCodexAppServerAdapterMidTurnGoalClearDoesNotSteer(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	transport.conn.holdTurn = true
	adapter.applyGoalUpdate(session.AgentSessionID, map[string]any{
		"objective": "finish it",
		"status":    "active",
	})

	execDone := make(chan struct{})
	go func() {
		defer close(execDone)
		_, _ = adapter.Exec(context.Background(), session, []PromptContentBlock{{
			Type: "text", Text: "long task",
		}}, "", "turn-local-1", nil, nil)
	}()
	waitForCondition(t, func() bool {
		return adapter.sessionActiveTurnID(session.AgentSessionID) == "turn-1"
	})

	events, err := adapter.Exec(context.Background(), session, []PromptContentBlock{{
		Type: "text", Text: "/goal clear",
	}}, "", "turn-local-2", nil, nil)
	if err != nil {
		t.Fatalf("Exec /goal clear: %v", err)
	}
	if requests := appServerRequestParamsList(t, transport.conn, appServerMethodTurnSteer); len(requests) != 0 {
		t.Fatalf("mid-turn /goal clear must not steer, sent %#v", requests)
	}
	transport.conn.mu.Lock()
	cleared := transport.conn.goalCleared
	transport.conn.mu.Unlock()
	if !cleared {
		t.Fatalf("thread/goal/clear was not executed")
	}
	if goal := adapter.sessionGoal(session.AgentSessionID); len(goal) != 0 {
		t.Fatalf("in-memory goal not cleared: %#v", goal)
	}
	steered := false
	for _, event := range eventsOfType(events, activityshared.EventSessionAudit) {
		if event.Payload.Metadata["goalControl"] == true {
			steered = true
			if event.Payload.TurnID != "" {
				t.Fatalf("goal audit turn id = %q, want empty", event.Payload.TurnID)
			}
		}
	}
	if !steered {
		t.Fatalf("mid-turn /goal clear user message missing goalControl metadata: %#v", events)
	}

	transport.conn.completePendingTurn()
	select {
	case <-execDone:
	case <-time.After(5 * time.Second):
		t.Fatalf("held turn did not finish")
	}
}

// The controller no longer classifies typed goal commands. Service owns that
// boundary, so every Controller.Exec call has the normal Turn contract.
func TestControllerExecDoesNotBypassActiveTurnForTypedGoal(t *testing.T) {
	t.Parallel()

	transport := newScriptedAppServerTransport()
	transport.conn.holdTurn = true
	adapter := NewCodexAppServerAdapter(transport)
	controller := NewController([]Adapter{adapter}, nil)
	started, err := controller.Start(context.Background(), StartInput{
		RoomID:   "room-1",
		Provider: ProviderCodex,
		CWD:      "/workspace",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	agentSessionID := started.Session.AgentSessionID
	adapter.applyGoalUpdate(agentSessionID, map[string]any{
		"objective": "ship it",
		"status":    "active",
	})

	_, err = controller.Exec(context.Background(), ExecInput{
		RoomID:         "room-1",
		AgentSessionID: agentSessionID,
		Content:        textPrompt("long task"),
	})
	if err != nil {
		t.Fatalf("Exec long task: %v", err)
	}
	waitForCondition(t, func() bool {
		return adapter.sessionActiveTurnID(agentSessionID) == "turn-1"
	})
	// A typed goal sent below the Service boundary is an ordinary Turn input
	// and therefore cannot bypass the single-active-turn gate.
	if _, err := controller.Exec(context.Background(), ExecInput{
		RoomID:         "room-1",
		AgentSessionID: agentSessionID,
		Content:        textPrompt("/goal clear"),
	}); !errors.Is(err, ErrSessionActiveTurn) {
		t.Fatalf("mid-turn typed goal error = %v, want ErrSessionActiveTurn", err)
	}
	if goal := adapter.sessionGoal(agentSessionID); asString(goal["objective"]) != "ship it" {
		t.Fatalf("controller unexpectedly changed goal: %#v", goal)
	}
	if adapter.sessionActiveTurnID(agentSessionID) != "turn-1" {
		t.Fatalf("active turn changed after rejected input")
	}

	// Ordinary prompts use the same Turn gate.
	if _, err := controller.Exec(context.Background(), ExecInput{
		RoomID:         "room-1",
		AgentSessionID: agentSessionID,
		Content:        textPrompt("another prompt"),
	}); !errors.Is(err, ErrSessionActiveTurn) {
		t.Fatalf("mid-turn plain prompt error = %v, want ErrSessionActiveTurn", err)
	}

	transport.conn.completePendingTurn()
}

// Stop during a goal run: adapter.Cancel returns goal-pause events AFTER the
// interrupted turn already settled and stored the canceled session. Those
// events must apply to the CURRENT stored session — applying them to the
// pre-cancel snapshot would resurrect the working state and wedge the GUI in
// a permanent spinner (stop button dead, prompts queued forever).
func TestControllerCancelDuringGoalKeepsSettledState(t *testing.T) {
	t.Parallel()

	transport := newScriptedAppServerTransport()
	transport.conn.holdTurn = true
	adapter := NewCodexAppServerAdapter(transport)
	controller := NewController([]Adapter{adapter}, nil)
	started, err := controller.Start(context.Background(), StartInput{
		RoomID:   "room-1",
		Provider: ProviderCodex,
		CWD:      "/workspace",
		Title:    "Codex",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	agentSessionID := started.Session.AgentSessionID
	adapter.applyGoalUpdate(agentSessionID, map[string]any{
		"objective": "ship it",
		"status":    "active",
	})

	execResult, err := controller.Exec(context.Background(), ExecInput{
		RoomID:         "room-1",
		AgentSessionID: agentSessionID,
		Content:        textPrompt("long task"),
	})
	if err != nil {
		t.Fatalf("Exec long task: %v", err)
	}
	waitForCondition(t, func() bool {
		return adapter.sessionActiveTurnID(agentSessionID) == "turn-1"
	})

	cancelResult, err := controller.Cancel(context.Background(), rootCancelInput("room-1", agentSessionID, execResult.TurnID, "user requested"))
	if err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	if !cancelResult.Canceled {
		t.Fatalf("Cancel result = %#v, want provider confirmation", cancelResult)
	}
	if status := asString(adapter.sessionGoal(agentSessionID)["status"]); status != "paused" {
		t.Fatalf("goal status after stop = %q, want paused", status)
	}
	controller.ReconcileRootTurnSettlement(RootTurnSettlement{
		RoomID: "room-1", AgentSessionID: agentSessionID, TurnID: execResult.TurnID, Outcome: "canceled",
	})
	session, ok := controller.get("room-1", agentSessionID)
	if !ok || session.Status != SessionStatusCanceled || session.TurnLifecycle == nil || session.TurnLifecycle.Phase != "settled" {
		t.Fatalf("durable root settlement did not reconcile into controller: %#v", session)
	}
}

// Metadata-only session updates (usage/goal refreshes) must not flap an
// adopted turn's status back to ready mid-turn: adopted turns have no
// controller turn record, so they don't get preserveActiveTurnStatus's
// protection and rely on the sink's lifecycle guard.
func TestControllerAdoptedTurnStatusSurvivesMetadataEvents(t *testing.T) {
	t.Parallel()

	transport := newScriptedAppServerTransport()
	adapter := NewCodexAppServerAdapter(transport)
	controller := NewController([]Adapter{adapter}, nil)
	started, err := controller.Start(context.Background(), StartInput{
		RoomID:   "room-1",
		Provider: ProviderCodex,
		CWD:      "/workspace",
		Title:    "Codex",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	agentSessionID := started.Session.AgentSessionID
	adapter.SetGoalProvenanceDurableSink(&memoryGoalProvenanceLedger{bindings: make(map[string]GoalProvenanceBinding)})
	identity := goalOperationIdentity{operationID: "goal-op-metadata", revision: 1}
	adapter.replaceGoalOperationIdentity(agentSessionID, identity.operationID, identity.revision, identity.repairEpoch)
	goal := map[string]any{
		"threadId": "codex-thread-1", "objective": "ship it", "status": "active",
		"createdAt": int64(100), "updatedAt": int64(101),
	}
	adapter.applyGoalUpdate(agentSessionID, goal)
	if err := adapter.bindGoalGeneration(context.Background(), started.Session, goal, identity); err != nil {
		t.Fatalf("bindGoalGeneration: %v", err)
	}

	// Codex self-starts a goal continuation turn; the reducer adopts it.
	transport.conn.notify(appServerNotifyThreadGoalUpdated, map[string]any{
		"threadId": "codex-thread-1", "turnId": "turn-goal-1", "goal": goal,
	})
	transport.conn.notify(appServerNotifyTurnStarted, map[string]any{
		"threadId": "codex-thread-1",
		"turn":     map[string]any{"id": "turn-goal-1", "status": "inProgress", "items": []any{}},
	})
	waitForCondition(t, func() bool {
		session, ok := controller.get("room-1", agentSessionID)
		return ok && session.Status == SessionStatusWorking
	})
	rootTurnID := ""
	if live, ok := controller.get("room-1", agentSessionID); ok && live.TurnLifecycle != nil && live.TurnLifecycle.ActiveTurnID != nil {
		rootTurnID = strings.TrimSpace(*live.TurnLifecycle.ActiveTurnID)
	}
	if rootTurnID == "" {
		t.Fatal("adopted provider turn has no canonical root turn id")
	}

	// Usage and goal refreshes arrive every few seconds during a turn.
	transport.conn.notify(appServerNotifyTokenUsage, map[string]any{
		"threadId":   "codex-thread-1",
		"tokenUsage": map[string]any{"total": map[string]any{"totalTokens": 42}},
	})
	transport.conn.notify(appServerNotifyThreadGoalUpdated, map[string]any{
		"threadId": "codex-thread-1",
		"goal": map[string]any{
			"objective": "ship it marker",
			"status":    "active",
		},
	})
	waitForCondition(t, func() bool {
		return asStringRaw(adapter.sessionGoal(agentSessionID)["objective"]) == "ship it marker"
	})
	session, ok := controller.get("room-1", agentSessionID)
	if !ok || session.Status != SessionStatusWorking {
		t.Fatalf("status flapped during adopted turn: %q", session.Status)
	}

	transport.conn.notify(appServerNotifyTurnCompleted, map[string]any{
		"threadId": "codex-thread-1",
		"turn":     map[string]any{"id": "turn-goal-1", "status": "completed", "items": []any{}},
	})
	waitForCondition(t, func() bool {
		return adapter.sessionActiveTurnID(agentSessionID) == ""
	})
	controller.ReconcileRootTurnSettlement(RootTurnSettlement{
		RoomID: "room-1", AgentSessionID: agentSessionID,
		TurnID: rootTurnID, Outcome: "completed",
	})
	waitForCondition(t, func() bool {
		session, ok := controller.get("room-1", agentSessionID)
		return ok && session.Status != SessionStatusWorking
	})
}

// Direct goal control (banner buttons) is a session-level operation: no
// prompt, no turn, works whether or not a turn is running.
func TestControllerGoalControl(t *testing.T) {
	t.Parallel()

	transport := newScriptedAppServerTransport()
	transport.conn.holdTurn = true
	adapter := NewCodexAppServerAdapter(transport)
	reporter := &recordingReporter{}
	controller := NewController([]Adapter{adapter}, reporter)
	started, err := controller.Start(context.Background(), StartInput{
		RoomID:   "room-1",
		Provider: ProviderCodex,
		CWD:      "/workspace",
		Title:    "Codex",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	agentSessionID := started.Session.AgentSessionID
	adapter.applyGoalUpdate(agentSessionID, map[string]any{
		"objective": "ship it",
		"status":    "active",
	})

	// Pause with no turn running.
	result, err := controller.GoalControl(context.Background(), GoalControlInput{
		RoomID:         "room-1",
		AgentSessionID: agentSessionID,
		Action:         GoalControlPause,
	})
	if err != nil {
		t.Fatalf("GoalControl pause: %v", err)
	}
	if asString(result.Goal["status"]) != "paused" {
		t.Fatalf("pause result goal = %#v, want paused", result.Goal)
	}
	// Resume and edit the objective while a turn is running.
	if _, err := controller.Exec(context.Background(), ExecInput{
		RoomID:         "room-1",
		AgentSessionID: agentSessionID,
		Content:        textPrompt("long task"),
	}); err != nil {
		t.Fatalf("Exec long task: %v", err)
	}
	waitForCondition(t, func() bool {
		return adapter.sessionActiveTurnID(agentSessionID) == "turn-1"
	})
	if _, err := controller.GoalControl(context.Background(), GoalControlInput{
		RoomID:         "room-1",
		AgentSessionID: agentSessionID,
		Action:         GoalControlResume,
	}); err != nil {
		t.Fatalf("GoalControl resume: %v", err)
	}
	if status := asString(adapter.sessionGoal(agentSessionID)["status"]); status != "active" {
		t.Fatalf("goal status after resume = %q, want active", status)
	}
	result, err = controller.GoalControl(context.Background(), GoalControlInput{
		RoomID:         "room-1",
		AgentSessionID: agentSessionID,
		Action:         GoalControlSet,
		Objective:      "ship it faster",
	})
	if err != nil {
		t.Fatalf("GoalControl set: %v", err)
	}
	if asStringRaw(result.Goal["objective"]) != "ship it faster" {
		t.Fatalf("set result goal = %#v, want updated objective", result.Goal)
	}
	if adapter.sessionActiveTurnID(agentSessionID) != "turn-1" {
		t.Fatalf("running turn must survive goal control")
	}

	// Clear.
	result, err = controller.GoalControl(context.Background(), GoalControlInput{
		RoomID:         "room-1",
		AgentSessionID: agentSessionID,
		Action:         GoalControlClear,
	})
	if err != nil {
		t.Fatalf("GoalControl clear: %v", err)
	}
	if len(result.Goal) != 0 {
		t.Fatalf("clear result goal = %#v, want empty", result.Goal)
	}
	if goal := adapter.sessionGoal(agentSessionID); len(goal) != 0 {
		t.Fatalf("goal not cleared: %#v", goal)
	}

	transport.conn.completePendingTurn()
}

func TestCodexAdoptedGoalTurnCarriesDurableGoalIdentity(t *testing.T) {
	t.Parallel()

	adapter, _, session := startedAppServerAdapter(t)
	identity := goalOperationIdentity{operationID: "goal-op-9", revision: 9, repairEpoch: 4}
	adapter.replaceGoalOperationIdentity(session.AgentSessionID, identity.operationID, identity.revision, identity.repairEpoch)
	adapter.mu.Lock()
	adapter.sessions[session.AgentSessionID].pendingGoalTurns = map[string]*codexPendingGoalTurn{
		"provider-goal-turn-9": {providerTurnID: "provider-goal-turn-9", session: session, state: codexGoalTurnPending},
	}
	adapter.mu.Unlock()
	events := make(chan activityshared.Event, 4)
	adapter.SetSessionEventSink(func(_ string, batch []activityshared.Event) {
		for _, event := range batch {
			events <- event
		}
	})
	if !adapter.adoptServerInitiatedTurn(session, "provider-goal-turn-9", identity) {
		t.Fatal("goal turn was not adopted")
	}

	select {
	case event := <-events:
		metadata := event.Payload.Metadata
		if event.Type != activityshared.EventTurnStarted || metadata["turnOrigin"] != "goal_continuation" || metadata["sourceGoalOperationId"] != "goal-op-9" || metadata["sourceGoalRevision"] != int64(9) || metadata["sourceGoalRepairEpoch"] != int64(4) {
			t.Fatalf("adopted goal turn event = %#v", event)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for adopted goal turn")
	}
}

func TestCodexGoalProvenanceNotificationOverflowFailsClosedWithLateBinding(t *testing.T) {
	adapter, transport, session := startedAppServerAdapter(t)
	reconciled := make(chan struct{}, 1)
	adapter.SetSessionEventSink(func(_ string, events []activityshared.Event) {
		for _, event := range events {
			if event.Type == activityshared.EventGoalReconcileRequired {
				select {
				case reconciled <- struct{}{}:
				default:
				}
			}
		}
	})
	identity := goalOperationIdentity{operationID: "goal-overflow", revision: 1}
	adapter.replaceGoalOperationIdentity(session.AgentSessionID, identity.operationID, identity.revision, 0)
	adapter.mu.Lock()
	adapter.sessions[session.AgentSessionID].pendingGoalTurns = map[string]*codexPendingGoalTurn{
		"turn-overflow": {providerTurnID: "turn-overflow", session: session, state: codexGoalTurnPending},
	}
	adapter.mu.Unlock()
	message := acpMessage{Method: appServerNotifyWarning, Params: json.RawMessage(`{"turnId":"turn-overflow","message":"buffered"}`)}
	for i := 0; i < maxPendingGoalTurnNotifications; i++ {
		if !adapter.bufferPendingGoalTurnNotification(session.AgentSessionID, "turn-overflow", message) {
			t.Fatal("notification was not buffered")
		}
	}
	terminal := acpMessage{Method: appServerNotifyTurnCompleted, Params: json.RawMessage(`{"turnId":"turn-overflow","turn":{"id":"turn-overflow","status":"completed"}}`)}
	if !adapter.bufferPendingGoalTurnNotification(session.AgentSessionID, "turn-overflow", terminal) {
		t.Fatal("overflow terminal was not consumed")
	}
	goal := map[string]any{"threadId": session.ProviderSessionID, "objective": "old", "createdAt": int64(1), "updatedAt": int64(2)}
	if err := adapter.bindGoalGeneration(context.Background(), session, goal, identity); err == nil {
		t.Fatal("late binding unexpectedly revived degraded provenance")
	}
	adapter.observeGoalTurnGeneration(session, "turn-overflow", goal)
	adapter.mu.Lock()
	degraded := adapter.sessions[session.AgentSessionID].provenanceDegraded
	active := adapter.sessions[session.AgentSessionID].activeTurn
	adapter.mu.Unlock()
	if !degraded || active != nil {
		t.Fatalf("degraded=%v active=%#v", degraded, active)
	}
	deadline := time.Now().Add(2 * time.Second)
	interrupted, durableReconcile := false, false
	for time.Now().Before(deadline) {
		transport.conn.mu.Lock()
		attempts := append([]string(nil), transport.conn.interruptAttempts...)
		transport.conn.mu.Unlock()
		if len(attempts) > 0 {
			if attempts[0] != "turn-overflow" {
				t.Fatalf("interrupts=%v", attempts)
			}
			interrupted = true
		}
		select {
		case <-reconciled:
			durableReconcile = true
		default:
		}
		if interrupted && durableReconcile {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("overflow closure interrupted=%v durableReconcile=%v", interrupted, durableReconcile)
}

func TestCodexGoalProvenanceDoubleResolvePreservesAdoptingBuffer(t *testing.T) {
	adapter, _, session := startedAppServerAdapter(t)
	identity := goalOperationIdentity{operationID: "goal-double", revision: 2}
	adapter.replaceGoalOperationIdentity(session.AgentSessionID, identity.operationID, identity.revision, 0)
	fingerprint := "fingerprint-double"
	adapter.mu.Lock()
	app := adapter.sessions[session.AgentSessionID]
	app.pendingGoalTurns = map[string]*codexPendingGoalTurn{"turn-double": {providerTurnID: "turn-double", session: session, state: codexGoalTurnPending}}
	app.goalGenerationBindings = map[string]codexGoalGenerationBinding{fingerprint: {identity: identity}}
	app.goalTurnEvidence = map[string]*codexGoalTurnEvidence{"turn-double": {fingerprints: map[string]struct{}{fingerprint: {}}, identity: identity, bound: true}}
	adapter.mu.Unlock()
	ready := make(chan struct{}, 2)
	release := make(chan struct{})
	adapter.goalBeforeAdoptHook = func() { ready <- struct{}{}; <-release }
	var once sync.Once
	adapter.goalHandoffCommittedHook = func() {
		once.Do(func() {
			adapter.mu.Lock()
			quiesced := adapter.degradeGoalProvenanceLocked(adapter.sessions[session.AgentSessionID])
			adapter.mu.Unlock()
			if len(quiesced) != 0 {
				t.Errorf("adopting turn was degraded as pending: %#v", quiesced)
			}
			adapter.expirePendingGoalTurn(session.AgentSessionID, "turn-double")
			adapter.bufferPendingGoalTurnNotification(session.AgentSessionID, "turn-double", acpMessage{Method: appServerNotifyTurnCompleted, Params: json.RawMessage(`{"turnId":"turn-double","turn":{"id":"turn-double","status":"completed"}}`)})
		})
	}
	var wg sync.WaitGroup
	wg.Add(2)
	for i := 0; i < 2; i++ {
		go func() { defer wg.Done(); adapter.tryResolvePendingGoalTurn(session.AgentSessionID, "turn-double") }()
	}
	<-ready
	<-ready
	close(release)
	wg.Wait()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		adapter.mu.Lock()
		active := adapter.sessions[session.AgentSessionID].activeTurn
		_, pending := adapter.sessions[session.AgentSessionID].pendingGoalTurns["turn-double"]
		adapter.mu.Unlock()
		if active == nil && !pending {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("double resolve lost terminal or left adopting buffer")
}

func TestCodexGoalHandoffReplaysBufferedContentInOrderExactlyOnce(t *testing.T) {
	adapter, _, session := startedAppServerAdapter(t)
	identity := goalOperationIdentity{operationID: "goal-content", revision: 3}
	adapter.replaceGoalOperationIdentity(session.AgentSessionID, identity.operationID, identity.revision, 0)
	fingerprint := "fingerprint-content"
	notifications := []acpMessage{
		{Method: appServerNotifyReasoningDelta, Params: mustJSONRawMessage(t, map[string]any{"threadId": session.ProviderSessionID, "turnId": "turn-content", "delta": "think first"})},
		{Method: appServerNotifyAgentMessageDelta, Params: mustJSONRawMessage(t, map[string]any{"threadId": session.ProviderSessionID, "turnId": "turn-content", "delta": "hello second"})},
		{Method: appServerNotifyItemStarted, Params: mustJSONRawMessage(t, map[string]any{"threadId": session.ProviderSessionID, "turnId": "turn-content", "item": map[string]any{"type": "commandExecution", "id": "cmd-content", "command": "pwd", "status": "inProgress"}})},
		{Method: appServerNotifyItemCompleted, Params: mustJSONRawMessage(t, map[string]any{"threadId": session.ProviderSessionID, "turnId": "turn-content", "item": map[string]any{"type": "commandExecution", "id": "cmd-content", "command": "pwd", "status": "completed", "aggregatedOutput": "/workspace", "exitCode": 0}})},
		{Method: appServerNotifyTurnCompleted, Params: mustJSONRawMessage(t, map[string]any{"threadId": session.ProviderSessionID, "turnId": "turn-content", "turn": map[string]any{"id": "turn-content", "status": "completed"}})},
	}
	adapter.mu.Lock()
	app := adapter.sessions[session.AgentSessionID]
	app.pendingGoalTurns = map[string]*codexPendingGoalTurn{"turn-content": {providerTurnID: "turn-content", session: session, state: codexGoalTurnPending, notifications: notifications}}
	app.goalGenerationBindings = map[string]codexGoalGenerationBinding{fingerprint: {identity: identity}}
	app.goalTurnEvidence = map[string]*codexGoalTurnEvidence{"turn-content": {fingerprints: map[string]struct{}{fingerprint: {}}, identity: identity, bound: true}}
	adapter.mu.Unlock()
	var mu sync.Mutex
	var events []activityshared.Event
	adapter.SetSessionEventSink(func(_ string, batch []activityshared.Event) {
		mu.Lock()
		events = append(events, batch...)
		mu.Unlock()
	})
	if !adapter.tryResolvePendingGoalTurn(session.AgentSessionID, "turn-content") {
		t.Fatal("handoff was not resolved")
	}
	waitForCondition(t, func() bool {
		adapter.mu.Lock()
		active := adapter.sessions[session.AgentSessionID].activeTurn
		adapter.mu.Unlock()
		return active == nil
	})
	mu.Lock()
	got := append([]activityshared.Event(nil), events...)
	mu.Unlock()
	started, thinking, assistant, callStarted, callCompleted, providerTerminal := -1, -1, -1, -1, -1, -1
	for i, event := range got {
		if event.Payload.TurnID == "" {
			t.Fatalf("replayed event missing local turn id: %#v", event)
		}
		switch {
		case event.Type == activityshared.EventTurnStarted:
			started = i
		case strings.Contains(event.Payload.Content, "think first") && event.Payload.Metadata["streamState"] == messageStreamStateStreaming:
			if thinking >= 0 {
				t.Fatal("thinking replayed twice")
			}
			thinking = i
		case strings.Contains(event.Payload.Content, "hello second") && event.Payload.Metadata["streamState"] == messageStreamStateStreaming:
			if assistant >= 0 {
				t.Fatal("assistant replayed twice")
			}
			assistant = i
		case event.Type == activityshared.EventCallStarted:
			callStarted = i
		case event.Type == activityshared.EventCallCompleted:
			callCompleted = i
		case event.Type == activityshared.EventRootProviderTurnCompleted:
			providerTerminal = i
			if event.Payload.ProviderTurnID != "turn-content" {
				t.Fatalf("provider terminal id = %q, want turn-content", event.Payload.ProviderTurnID)
			}
		case event.Type == activityshared.EventTurnCompleted || event.Type == activityshared.EventTurnFailed || string(event.Type) == EventTurnCanceled:
			t.Fatalf("adapter emitted canonical terminal for provider completion: %#v", event)
		}
	}
	if started < 0 || started >= thinking || thinking >= assistant || assistant >= callStarted || callStarted >= callCompleted || callCompleted >= providerTerminal {
		t.Fatalf("replay order start=%d thinking=%d assistant=%d callStart=%d callComplete=%d providerTerminal=%d events=%#v", started, thinking, assistant, callStarted, callCompleted, providerTerminal, got)
	}
}

func TestCodexGoalAdoptingOverflowSettlesAndQuiesces(t *testing.T) {
	for _, tc := range []struct {
		name        string
		failQuiesce bool
		wantOutcome activityshared.TurnOutcome
	}{{"success", false, activityshared.TurnOutcomeCanceled}, {"failure", true, activityshared.TurnOutcomeFailed}} {
		t.Run(tc.name, func(t *testing.T) {
			adapter, transport, session := startedAppServerAdapter(t)
			identity := goalOperationIdentity{operationID: "goal-overflow-adopting", revision: 5}
			adapter.replaceGoalOperationIdentity(session.AgentSessionID, identity.operationID, 5, 0)
			if tc.failQuiesce {
				transport.conn.mu.Lock()
				transport.conn.interruptTurnIDMismatch = "newer-turn"
				transport.conn.mu.Unlock()
			}
			fingerprint := "fingerprint-adopting"
			adapter.mu.Lock()
			app := adapter.sessions[session.AgentSessionID]
			app.pendingGoalTurns = map[string]*codexPendingGoalTurn{"turn-adopting": {providerTurnID: "turn-adopting", session: session, state: codexGoalTurnPending}}
			app.goalGenerationBindings = map[string]codexGoalGenerationBinding{fingerprint: {identity: identity}}
			app.goalTurnEvidence = map[string]*codexGoalTurnEvidence{"turn-adopting": {fingerprints: map[string]struct{}{fingerprint: {}}, identity: identity, bound: true}}
			adapter.mu.Unlock()
			drainEntered := make(chan struct{})
			release := make(chan struct{})
			var drainOnce sync.Once
			adapter.goalHandoffDrainHook = func() { drainOnce.Do(func() { close(drainEntered); <-release }) }
			var mu sync.Mutex
			var events []activityshared.Event
			adapter.SetSessionEventSink(func(_ string, batch []activityshared.Event) {
				mu.Lock()
				events = append(events, batch...)
				mu.Unlock()
			})
			initial := acpMessage{Method: appServerNotifyAgentMessageDelta, Params: json.RawMessage(`{"turnId":"turn-adopting","delta":"before overflow"}`)}
			if !adapter.bufferPendingGoalTurnNotification(session.AgentSessionID, "turn-adopting", initial) {
				t.Fatal("initial adopting notification escaped buffer")
			}
			done := make(chan struct{})
			go func() { adapter.tryResolvePendingGoalTurn(session.AgentSessionID, "turn-adopting"); close(done) }()
			<-drainEntered
			message := acpMessage{Method: appServerNotifyWarning, Params: json.RawMessage(`{"turnId":"turn-adopting","message":"noise"}`)}
			for i := 0; i <= maxPendingGoalTurnNotifications; i++ {
				if !adapter.bufferPendingGoalTurnNotification(session.AgentSessionID, "turn-adopting", message) {
					t.Fatal("adopting notification escaped buffer")
				}
			}
			close(release)
			<-done
			waitForCondition(t, func() bool {
				adapter.mu.Lock()
				active := adapter.sessions[session.AgentSessionID].activeTurn
				adapter.mu.Unlock()
				return active == nil
			})
			late := acpMessage{Method: appServerNotifyTurnCompleted, Params: json.RawMessage(`{"turnId":"turn-adopting","turn":{"id":"turn-adopting","status":"completed"}}`)}
			if !adapter.bufferPendingGoalTurnNotification(session.AgentSessionID, "turn-adopting", late) {
				t.Fatal("late terminal escaped aborted handoff")
			}
			time.Sleep(20 * time.Millisecond)
			mu.Lock()
			snapshot := append([]activityshared.Event(nil), events...)
			mu.Unlock()
			providerTerminalCount, reconcileCount, assistantIndex, terminalIndex := 0, 0, -1, -1
			var reconcileID string
			phases := map[string]bool{}
			for index, event := range snapshot {
				if (event.Type == activityshared.EventMessageAppended || event.Type == activityshared.EventMessageCreated) && strings.Contains(event.Payload.Content, "before overflow") {
					assistantIndex = index
				}
				if event.Type == activityshared.EventRootProviderTurnCompleted {
					providerTerminalCount++
					terminalIndex = index
					if event.Payload.ProviderTurnID != "turn-adopting" {
						t.Fatalf("provider terminal id = %q, want turn-adopting", event.Payload.ProviderTurnID)
					}
					if event.Payload.TurnOutcome != string(tc.wantOutcome) {
						t.Fatalf("provider terminal outcome = %q, want %q", event.Payload.TurnOutcome, tc.wantOutcome)
					}
				}
				if event.Type == activityshared.EventGoalReconcileRequired {
					reconcileCount++
					if reconcileID == "" {
						reconcileID = event.EventID
					} else if reconcileID != event.EventID {
						t.Fatalf("two-phase reconcile changed request id: %#v", snapshot)
					}
					phases[asString(event.Payload.Metadata["phase"])] = true
				}
				if event.Type == activityshared.EventTurnCompleted || event.Type == activityshared.EventTurnFailed || string(event.Type) == EventTurnCanceled {
					t.Fatalf("adapter emitted canonical terminal for provider completion: %#v", snapshot)
				}
			}
			if providerTerminalCount != 1 || reconcileCount != 2 || !phases["quiesce_pending"] || !phases["finalized"] {
				t.Fatalf("providerTerminal=%d reconcile=%d phases=%v events=%#v", providerTerminalCount, reconcileCount, phases, snapshot)
			}
			if assistantIndex < 0 || terminalIndex <= assistantIndex {
				t.Fatalf("drained content/terminal order assistant=%d terminal=%d events=%#v", assistantIndex, terminalIndex, snapshot)
			}
			transport.conn.mu.Lock()
			attempts := append([]string(nil), transport.conn.interruptAttempts...)
			transport.conn.mu.Unlock()
			wantAttempts := 1
			if tc.failQuiesce {
				wantAttempts = 3
			}
			if len(attempts) != wantAttempts {
				t.Fatalf("interrupt attempts=%v want=%d", attempts, wantAttempts)
			}
			for _, id := range attempts {
				if id != "turn-adopting" {
					t.Fatalf("non-exact interrupt=%v", attempts)
				}
			}
		})
	}
}

func TestCodexGoalAdoptingPrepareFailureTerminatesLocalTurnAndProvider(t *testing.T) {
	adapter, transport, session := startedAppServerAdapter(t)
	adapter.SetGoalReconcileDurableSink(func(context.Context, Session, GoalReconcileDurableRequest) error {
		return errors.New("durable reporter unavailable")
	})
	identity := goalOperationIdentity{operationID: "goal-prepare-fail", revision: 5}
	adapter.replaceGoalOperationIdentity(session.AgentSessionID, identity.operationID, identity.revision, 0)
	fingerprint := "fingerprint-prepare-fail"
	adapter.mu.Lock()
	app := adapter.sessions[session.AgentSessionID]
	app.pendingGoalTurns = map[string]*codexPendingGoalTurn{"turn-adopting": {providerTurnID: "turn-adopting", session: session, state: codexGoalTurnPending}}
	app.goalGenerationBindings = map[string]codexGoalGenerationBinding{fingerprint: {identity: identity}}
	app.goalTurnEvidence = map[string]*codexGoalTurnEvidence{"turn-adopting": {fingerprints: map[string]struct{}{fingerprint: {}}, identity: identity, bound: true}}
	adapter.mu.Unlock()
	committed, release := make(chan struct{}), make(chan struct{})
	adapter.goalHandoffCommittedHook = func() { close(committed); <-release }
	var mu sync.Mutex
	var events []activityshared.Event
	adapter.SetSessionEventSink(func(_ string, batch []activityshared.Event) {
		mu.Lock()
		events = append(events, batch...)
		mu.Unlock()
	})
	done := make(chan struct{})
	go func() { adapter.tryResolvePendingGoalTurn(session.AgentSessionID, "turn-adopting"); close(done) }()
	<-committed
	message := acpMessage{Method: appServerNotifyWarning, Params: json.RawMessage(`{"turnId":"turn-adopting","message":"noise"}`)}
	for i := 0; i <= maxPendingGoalTurnNotifications; i++ {
		if !adapter.bufferPendingGoalTurnNotification(session.AgentSessionID, "turn-adopting", message) {
			t.Fatal("adopting notification escaped buffer")
		}
	}
	close(release)
	<-done
	waitForCondition(t, func() bool {
		adapter.mu.Lock()
		active := adapter.sessions[session.AgentSessionID].activeTurn
		adapter.mu.Unlock()
		return active == nil
	})
	select {
	case <-app.client.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("provider remained live after durable prepare failure")
	}
	mu.Lock()
	snapshot := append([]activityshared.Event(nil), events...)
	mu.Unlock()
	providerFailed := 0
	for _, event := range snapshot {
		if event.Type == activityshared.EventRootProviderTurnCompleted {
			providerFailed++
			if event.Payload.ProviderTurnID != "turn-adopting" {
				t.Fatalf("provider terminal id = %q, want turn-adopting", event.Payload.ProviderTurnID)
			}
			if event.Payload.TurnOutcome != string(activityshared.TurnOutcomeFailed) {
				t.Fatalf("provider terminal outcome = %q, want failed", event.Payload.TurnOutcome)
			}
		}
		if event.Type == activityshared.EventTurnCompleted || event.Type == activityshared.EventTurnFailed || string(event.Type) == EventTurnCanceled {
			t.Fatalf("adapter emitted canonical terminal for provider completion: %#v", event)
		}
	}
	transport.conn.mu.Lock()
	attempts := append([]string(nil), transport.conn.interruptAttempts...)
	transport.conn.mu.Unlock()
	if providerFailed != 1 || len(attempts) != 0 {
		t.Fatalf("providerFailed=%d interruptAttempts=%v events=%#v", providerFailed, attempts, snapshot)
	}
}

func TestCodexGoalProvenanceWorkingSetRemainsBoundedAfterManyGenerations(t *testing.T) {
	adapter, transport, session := startedAppServerAdapter(t)
	identity := goalOperationIdentity{operationID: "goal-cap", revision: 1}
	adapter.replaceGoalOperationIdentity(session.AgentSessionID, identity.operationID, 1, 0)
	for i := 0; i < 512; i++ {
		goal := map[string]any{"threadId": session.ProviderSessionID, "objective": fmt.Sprintf("goal-%d", i), "createdAt": int64(i + 1), "updatedAt": int64(i + 2)}
		if err := adapter.bindGoalGeneration(context.Background(), session, goal, identity); err != nil {
			t.Fatalf("bindGoalGeneration: %v", err)
		}
	}
	adapter.mu.Lock()
	degraded := adapter.sessions[session.AgentSessionID].provenanceDegraded
	bindings := len(adapter.sessions[session.AgentSessionID].goalGenerationBindings)
	adapter.mu.Unlock()
	if degraded || bindings > maxGoalGenerationBindings {
		t.Fatalf("degraded=%v bindings=%d", degraded, bindings)
	}
	_ = transport
}

func TestCodexGoalGenerationFingerprintIsStableFixedLengthDigest(t *testing.T) {
	goal := map[string]any{"threadId": "thread-1", "objective": "private objective", "createdAt": int64(10), "updatedAt": int64(11)}
	first := codexGoalGenerationFingerprint(goal)
	second := codexGoalGenerationFingerprint(clonePayload(goal))
	if first != second || len(first) != len("sha256:")+64 || strings.Contains(first, "private objective") {
		t.Fatalf("fingerprint first=%q second=%q", first, second)
	}
	changed := clonePayload(goal)
	changed["updatedAt"] = int64(12)
	if codexGoalGenerationFingerprint(changed) == first {
		t.Fatal("updated provider generation produced the same fingerprint")
	}
	for _, field := range []string{"threadId", "objective", "createdAt", "updatedAt"} {
		missing := clonePayload(goal)
		delete(missing, field)
		if got := codexGoalGenerationFingerprint(missing); got != "" {
			t.Fatalf("fingerprint missing %s = %q, want empty", field, got)
		}
	}
}

func TestCodexGoalApplyMissingGenerationFingerprintFailsClosed(t *testing.T) {
	adapter, transport, session := startedAppServerAdapter(t)
	transport.conn.mu.Lock()
	transport.conn.goalOmitUpdatedAt = true
	transport.conn.mu.Unlock()
	_, err := adapter.ApplyGoal(context.Background(), session, GoalApplyInput{
		Action: GoalControlSet, Objective: "ship safely", OperationID: "goal-missing-fingerprint", Revision: 1,
	})
	if err == nil || !strings.Contains(err.Error(), "missing immutable fingerprint fields") {
		t.Fatalf("ApplyGoal error = %v", err)
	}
	adapter.mu.Lock()
	appSession := adapter.sessions[session.AgentSessionID]
	degraded, client := appSession.provenanceDegraded, appSession.client
	goal := clonePayload(appSession.goal)
	adapter.mu.Unlock()
	if !degraded || len(goal) != 0 {
		t.Fatalf("degraded=%v localGoal=%#v", degraded, goal)
	}
	select {
	case <-client.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("provider stayed live after invalid Goal generation response")
	}
}

func TestCodexDurableGoalSetEmptyGenerationResponseFailsClosed(t *testing.T) {
	adapter, transport, session := startedAppServerAdapter(t)
	transport.conn.mu.Lock()
	transport.conn.goalEmptyResponse = true
	transport.conn.mu.Unlock()
	result, err := adapter.ApplyGoal(context.Background(), session, GoalApplyInput{
		Action: GoalControlSet, Objective: "ship safely", OperationID: "goal-empty-generation", Revision: 1,
	})
	if err == nil || !strings.Contains(err.Error(), "returned no Goal generation") {
		t.Fatalf("ApplyGoal result=%#v error=%v", result, err)
	}
	if result.ProviderPhase == "applied" {
		t.Fatalf("empty Goal generation was reported applied: %#v", result)
	}
	adapter.mu.Lock()
	appSession := adapter.sessions[session.AgentSessionID]
	degraded, client := appSession.provenanceDegraded, appSession.client
	goal := clonePayload(appSession.goal)
	adapter.mu.Unlock()
	if !degraded || len(goal) != 0 {
		t.Fatalf("degraded=%v localGoal=%#v", degraded, goal)
	}
	select {
	case <-client.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("provider stayed live after empty durable Goal set response")
	}
}

func TestCodexTurnScopedGoalObservationMissingFingerprintFailsClosed(t *testing.T) {
	adapter, _, session := startedAppServerAdapter(t)
	adapter.observeGoalTurnGeneration(session, "turn-missing-fingerprint", map[string]any{
		"threadId": session.ProviderSessionID, "objective": "ship safely", "createdAt": int64(1),
	})
	adapter.mu.Lock()
	appSession := adapter.sessions[session.AgentSessionID]
	degraded, client := appSession.provenanceDegraded, appSession.client
	adapter.mu.Unlock()
	if !degraded {
		t.Fatal("turn-scoped invalid generation did not degrade provenance")
	}
	select {
	case <-client.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("provider stayed live after invalid turn-scoped Goal generation")
	}
}

func TestCodexGoalProvenanceDurableLedgerSurvivesRestartAndAdoptsDelayedGeneration(t *testing.T) {
	ledger := &memoryGoalProvenanceLedger{bindings: make(map[string]GoalProvenanceBinding)}
	firstAdapter, _, session := startedAppServerAdapter(t)
	firstAdapter.SetGoalProvenanceDurableSink(ledger)
	oldIdentity := goalOperationIdentity{operationID: "goal-old", revision: 1}
	oldGoal := map[string]any{"threadId": session.ProviderSessionID, "objective": "old", "createdAt": int64(1), "updatedAt": int64(2)}
	firstAdapter.replaceGoalOperationIdentity(session.AgentSessionID, oldIdentity.operationID, oldIdentity.revision, 0)
	if err := firstAdapter.bindGoalGeneration(context.Background(), session, oldGoal, oldIdentity); err != nil {
		t.Fatalf("bind old generation: %v", err)
	}

	restarted, transport, restartedSession := startedAppServerAdapter(t)
	restarted.SetGoalProvenanceDurableSink(ledger)
	restarted.goalProvenanceGraceWindow = 10 * time.Millisecond
	newIdentity := goalOperationIdentity{operationID: "goal-new", revision: 2}
	newGoal := map[string]any{"threadId": restartedSession.ProviderSessionID, "objective": "new", "createdAt": int64(3), "updatedAt": int64(4)}
	restarted.replaceGoalOperationIdentity(restartedSession.AgentSessionID, newIdentity.operationID, newIdentity.revision, 0)
	if err := restarted.bindGoalGeneration(context.Background(), restartedSession, newGoal, newIdentity); err != nil {
		t.Fatalf("bind new generation: %v", err)
	}
	restarted.queueGoalTurnForProvenance(restartedSession, "turn-delayed-old-after-restart")
	restarted.observeGoalTurnGeneration(restartedSession, "turn-delayed-old-after-restart", oldGoal)
	waitForCondition(t, func() bool {
		restarted.mu.Lock()
		defer restarted.mu.Unlock()
		return restarted.sessions[restartedSession.AgentSessionID].activeTurn != nil
	})
	transport.conn.mu.Lock()
	interrupts := append([]string(nil), transport.conn.interruptAttempts...)
	transport.conn.mu.Unlock()
	if len(interrupts) != 0 {
		t.Fatalf("delayed proven generation was interrupted after restart: %#v", interrupts)
	}
}

func TestCodexGoalProvenanceUsesLiveThreadIDForPreStartCapturedSession(t *testing.T) {
	adapter, _, session := startedAppServerAdapter(t)
	ledger := &memoryGoalProvenanceLedger{bindings: make(map[string]GoalProvenanceBinding)}
	adapter.SetGoalProvenanceDurableSink(ledger)
	identity := goalOperationIdentity{operationID: "goal-live-thread", revision: 1}
	goal := map[string]any{"threadId": session.ProviderSessionID, "objective": "continue", "createdAt": int64(1), "updatedAt": int64(2)}
	adapter.replaceGoalOperationIdentity(session.AgentSessionID, identity.operationID, identity.revision, 0)
	if err := adapter.bindGoalGeneration(context.Background(), session, goal, identity); err != nil {
		t.Fatalf("bind generation: %v", err)
	}
	staleCapturedSession := session
	staleCapturedSession.ProviderSessionID = ""
	adapter.observeGoalTurnGeneration(staleCapturedSession, "provider-turn-live-thread", goal)
	adapter.mu.Lock()
	evidence := adapter.sessions[session.AgentSessionID].goalTurnEvidence["provider-turn-live-thread"]
	adapter.mu.Unlock()
	if evidence == nil || !evidence.bound || evidence.identity != identity {
		t.Fatalf("evidence=%#v, want durable identity %#v", evidence, identity)
	}
}

func TestCodexGoalProvenanceDurableCollisionRemainsAmbiguousAfterRestart(t *testing.T) {
	ledger := &memoryGoalProvenanceLedger{bindings: make(map[string]GoalProvenanceBinding)}
	first, _, session := startedAppServerAdapter(t)
	first.SetGoalProvenanceDurableSink(ledger)
	goal := map[string]any{"threadId": session.ProviderSessionID, "objective": "same", "createdAt": int64(1), "updatedAt": int64(2)}
	firstIdentity := goalOperationIdentity{operationID: "goal-first", revision: 1}
	first.replaceGoalOperationIdentity(session.AgentSessionID, firstIdentity.operationID, firstIdentity.revision, 0)
	if err := first.bindGoalGeneration(context.Background(), session, goal, firstIdentity); err != nil {
		t.Fatalf("bind first: %v", err)
	}

	restarted, transport, restartedSession := startedAppServerAdapter(t)
	restarted.SetGoalProvenanceDurableSink(ledger)
	secondIdentity := goalOperationIdentity{operationID: "goal-second", revision: 2}
	restarted.replaceGoalOperationIdentity(restartedSession.AgentSessionID, secondIdentity.operationID, secondIdentity.revision, 0)
	if err := restarted.bindGoalGeneration(context.Background(), restartedSession, goal, secondIdentity); err == nil {
		t.Fatal("durable collision did not fail closed")
	}
	restarted.mu.Lock()
	client := restarted.sessions[restartedSession.AgentSessionID].client
	restarted.mu.Unlock()
	select {
	case <-client.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("provider stayed live after durable provenance collision")
	}
	restarted.mu.Lock()
	appSession := restarted.sessions[restartedSession.AgentSessionID]
	degraded, active := appSession.provenanceDegraded, appSession.activeTurn
	restarted.mu.Unlock()
	if !degraded || active != nil {
		t.Fatalf("degraded=%v active=%#v", degraded, active)
	}
	_ = transport
}

func TestCodexGoalProvenanceWorkingSetStaysBoundedAcrossManyContinuations(t *testing.T) {
	adapter, _, session := startedAppServerAdapter(t)
	ledger := &memoryGoalProvenanceLedger{bindings: make(map[string]GoalProvenanceBinding)}
	adapter.SetGoalProvenanceDurableSink(ledger)
	for i := 1; i <= 320; i++ {
		identity := goalOperationIdentity{operationID: fmt.Sprintf("goal-op-%d", i), revision: int64(i)}
		goal := map[string]any{"threadId": session.ProviderSessionID, "objective": fmt.Sprintf("goal-%d", i), "createdAt": int64(i), "updatedAt": int64(i + 1)}
		providerTurnID := fmt.Sprintf("provider-turn-%d", i)
		adapter.replaceGoalOperationIdentity(session.AgentSessionID, identity.operationID, identity.revision, 0)
		if err := adapter.bindGoalGeneration(context.Background(), session, goal, identity); err != nil {
			t.Fatalf("bind generation %d: %v", i, err)
		}
		adapter.observeGoalTurnGeneration(session, providerTurnID, goal)
		adapter.mu.Lock()
		if adapter.sessions[session.AgentSessionID].pendingGoalTurns == nil {
			adapter.sessions[session.AgentSessionID].pendingGoalTurns = make(map[string]*codexPendingGoalTurn)
		}
		adapter.sessions[session.AgentSessionID].pendingGoalTurns[providerTurnID] = &codexPendingGoalTurn{
			providerTurnID: providerTurnID, session: session, state: codexGoalTurnPending,
		}
		adapter.mu.Unlock()
		appTurn := &codexAppServerActiveTurn{turnID: fmt.Sprintf("local-turn-%d", i)}
		if !adapter.beginGoalTurnHandoff(session.AgentSessionID, providerTurnID, appTurn, identity) {
			t.Fatalf("begin handoff %d", i)
		}
		adapter.drainGoalTurnHandoff(session.AgentSessionID, providerTurnID, appTurn)
		adapter.endActiveTurn(session.AgentSessionID, appTurn)
	}
	adapter.mu.Lock()
	appSession := adapter.sessions[session.AgentSessionID]
	degraded, evidence, bindings := appSession.provenanceDegraded, len(appSession.goalTurnEvidence), len(appSession.goalGenerationBindings)
	adapter.mu.Unlock()
	if degraded || evidence != 0 || bindings > maxGoalGenerationBindings {
		t.Fatalf("degraded=%v evidence=%d bindings=%d", degraded, evidence, bindings)
	}
}

type memoryGoalProvenanceLedger struct {
	mu       sync.Mutex
	bindings map[string]GoalProvenanceBinding
}

type blockingGoalProvenanceLedger struct {
	*memoryGoalProvenanceLedger
	lookupStarted chan struct{}
	releaseLookup chan struct{}
}

func (l *blockingGoalProvenanceLedger) LookupGoalProvenance(ctx context.Context, session Session, fingerprint string) (GoalProvenanceBinding, bool, error) {
	select {
	case <-l.lookupStarted:
	default:
		close(l.lookupStarted)
	}
	select {
	case <-l.releaseLookup:
	case <-ctx.Done():
		return GoalProvenanceBinding{}, false, ctx.Err()
	}
	return l.memoryGoalProvenanceLedger.LookupGoalProvenance(ctx, session, fingerprint)
}

func TestCodexGoalProvenanceGraceWaitsForDurableLookup(t *testing.T) {
	adapter, transport, session := startedAppServerAdapter(t)
	adapter.goalProvenanceGraceWindow = 10 * time.Millisecond
	ledger := &blockingGoalProvenanceLedger{
		memoryGoalProvenanceLedger: &memoryGoalProvenanceLedger{bindings: make(map[string]GoalProvenanceBinding)},
		lookupStarted:              make(chan struct{}), releaseLookup: make(chan struct{}),
	}
	adapter.SetGoalProvenanceDurableSink(ledger)
	identity := goalOperationIdentity{operationID: "goal-op-slow", revision: 1}
	goal := map[string]any{"threadId": session.ProviderSessionID, "objective": "ship", "createdAt": int64(1), "updatedAt": int64(2)}
	adapter.replaceGoalOperationIdentity(session.AgentSessionID, identity.operationID, identity.revision, 0)
	if err := adapter.bindGoalGeneration(context.Background(), session, goal, identity); err != nil {
		t.Fatal(err)
	}
	adapter.queueGoalTurnForProvenance(session, "provider-turn-slow")
	done := make(chan struct{})
	go func() {
		adapter.observeGoalTurnGeneration(session, "provider-turn-slow", goal)
		close(done)
	}()
	<-ledger.lookupStarted
	time.Sleep(35 * time.Millisecond)
	adapter.mu.Lock()
	_, pending := adapter.sessions[session.AgentSessionID].pendingGoalTurns["provider-turn-slow"]
	adapter.mu.Unlock()
	if !pending {
		t.Fatal("pending Goal turn expired while durable lookup was in flight")
	}
	if requests := appServerRequestParamsList(t, transport.conn, appServerMethodTurnInterrupt); len(requests) != 0 {
		t.Fatalf("Goal turn was interrupted during durable lookup: %#v", requests)
	}
	close(ledger.releaseLookup)
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("durable lookup did not finish")
	}
}

func (l *memoryGoalProvenanceLedger) BindGoalProvenance(_ context.Context, session Session, fingerprint string, proposed GoalProvenanceBinding) (GoalProvenanceBinding, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	key := session.RoomID + "\x00" + session.AgentSessionID + "\x00" + session.ProviderSessionID + "\x00" + fingerprint
	existing, found := l.bindings[key]
	if !found {
		l.bindings[key] = proposed
		return proposed, nil
	}
	if existing.Ambiguous {
		return existing, nil
	}
	if existing.OperationID != proposed.OperationID || existing.Revision != proposed.Revision || existing.RepairEpoch != proposed.RepairEpoch {
		existing = GoalProvenanceBinding{Ambiguous: true}
		l.bindings[key] = existing
	}
	return existing, nil
}

func (l *memoryGoalProvenanceLedger) LookupGoalProvenance(_ context.Context, session Session, fingerprint string) (GoalProvenanceBinding, bool, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	key := session.RoomID + "\x00" + session.AgentSessionID + "\x00" + session.ProviderSessionID + "\x00" + fingerprint
	binding, found := l.bindings[key]
	return binding, found, nil
}

func TestCodexLateSupersededGoalTurnKeepsOriginalIdentityAndContinues(t *testing.T) {
	adapter, transport, session := startedAppServerAdapter(t)
	adapter.goalProvenanceGraceWindow = 10 * time.Millisecond
	var sinkMu sync.Mutex
	var sinkEvents []activityshared.Event
	adapter.SetSessionEventSink(func(_ string, batch []activityshared.Event) {
		sinkMu.Lock()
		defer sinkMu.Unlock()
		sinkEvents = append(sinkEvents, batch...)
	})

	if _, err := adapter.ApplyGoal(context.Background(), session, GoalApplyInput{
		Action: GoalControlSet, Objective: "old objective", OperationID: "goal-op-1", Revision: 1,
	}); err != nil {
		t.Fatalf("set1: %v", err)
	}
	// Keep the provider-authored generation payload for the delayed
	// notification. sessionGoal intentionally exposes only canonical public
	// fields and therefore omits immutable provenance fields.
	transport.conn.mu.Lock()
	oldGoal := clonePayload(transport.conn.goal)
	transport.conn.mu.Unlock()
	if _, err := adapter.ApplyGoal(context.Background(), session, GoalApplyInput{
		Action: GoalControlClear, OperationID: "goal-clear", Revision: 2,
	}); err != nil {
		t.Fatalf("clear: %v", err)
	}
	if _, err := adapter.ApplyGoal(context.Background(), session, GoalApplyInput{
		Action: GoalControlSet, Objective: "new objective", OperationID: "goal-op-2", Revision: 3, RepairEpoch: 2,
	}); err != nil {
		t.Fatalf("set2: %v", err)
	}

	appSession := adapter.getSession(session.AgentSessionID)
	reducer := newCodexAppServerReducer(adapter)
	reducer.ReduceNotification(appSession.client, session, "", acpMessage{
		Method: appServerNotifyThreadGoalUpdated,
		Params: mustJSONRawMessage(t, map[string]any{
			"threadId": session.ProviderSessionID, "turnId": "provider-old-turn", "goal": oldGoal,
		}),
	}, nil, nil)
	reducer.ReduceNotification(appSession.client, session, "", acpMessage{
		Method: appServerNotifyTurnStarted,
		Params: mustJSONRawMessage(t, map[string]any{
			"threadId": session.ProviderSessionID,
			"turn":     map[string]any{"id": "provider-old-turn", "status": "inProgress", "items": []any{}},
		}),
	}, nil, nil)

	waitForCondition(t, func() bool {
		sinkMu.Lock()
		defer sinkMu.Unlock()
		for _, event := range sinkEvents {
			if event.Type == activityshared.EventTurnStarted && event.Payload.Metadata["sourceGoalOperationId"] == "goal-op-2" {
				t.Fatalf("late old provider turn inherited op2: %#v", event)
			}
			if event.Type == activityshared.EventTurnStarted &&
				event.Payload.Metadata["sourceGoalOperationId"] == "goal-op-1" &&
				event.Payload.Metadata["sourceGoalRevision"] == int64(1) {
				return true
			}
		}
		return false
	})
	if requests := appServerRequestParamsList(t, transport.conn, appServerMethodTurnInterrupt); len(requests) != 0 {
		t.Fatalf("superseding Goal state interrupted current provider Turn: %#v", requests)
	}
}

func TestCodexRestartedActiveGoalTurnDoesNotGuessProvenance(t *testing.T) {
	adapter, transport, session := startedAppServerAdapter(t)
	adapter.goalProvenanceGraceWindow = 10 * time.Millisecond
	adapter.applyGoalUpdate(session.AgentSessionID, map[string]any{
		"threadId": session.ProviderSessionID, "objective": "resumed provider goal", "status": "active",
		"createdAt": int64(100), "updatedAt": int64(101),
	})
	var sinkMu sync.Mutex
	var sinkEvents []activityshared.Event
	adapter.SetSessionEventSink(func(_ string, batch []activityshared.Event) {
		sinkMu.Lock()
		defer sinkMu.Unlock()
		sinkEvents = append(sinkEvents, batch...)
	})

	appSession := adapter.getSession(session.AgentSessionID)
	newCodexAppServerReducer(adapter).ReduceNotification(appSession.client, session, "", acpMessage{
		Method: appServerNotifyTurnStarted,
		Params: mustJSONRawMessage(t, map[string]any{
			"threadId": session.ProviderSessionID,
			"turn":     map[string]any{"id": "provider-restart-turn", "status": "inProgress", "items": []any{}},
		}),
	}, nil, nil)

	waitForCondition(t, func() bool {
		requests := appServerRequestParamsList(t, transport.conn, appServerMethodTurnInterrupt)
		return len(requests) > 0 && asString(requests[len(requests)-1]["turnId"]) == "provider-restart-turn"
	})
	waitForCondition(t, func() bool {
		sinkMu.Lock()
		defer sinkMu.Unlock()
		for _, event := range sinkEvents {
			if event.Type == activityshared.EventTurnStarted {
				t.Fatalf("restart turn was adopted without operation evidence: %#v", event)
			}
			if event.Type == activityshared.EventGoalReconcileRequired && event.Payload.Metadata["phase"] == "finalized" {
				return event.Payload.Metadata["fenceMode"] == "current_durable" &&
					event.Payload.Metadata["expectedGoalOperationId"] == "" &&
					event.Payload.Metadata["expectedGoalRevision"] == int64(0) &&
					event.Payload.Metadata["quiesceSucceeded"] == true
			}
		}
		return false
	})
}

func TestCodexUnprovenGoalTurnQuiesceFailureRemainsExplicitAndExact(t *testing.T) {
	adapter, transport, session := startedAppServerAdapter(t)
	adapter.goalProvenanceGraceWindow = 10 * time.Millisecond
	transport.conn.interruptTurnIDMismatch = "provider-newer-turn"
	adapter.applyGoalUpdate(session.AgentSessionID, map[string]any{
		"threadId": session.ProviderSessionID, "objective": "resumed provider goal", "status": "active",
		"createdAt": int64(100), "updatedAt": int64(101),
	})
	events := make(chan activityshared.Event, 4)
	adapter.SetSessionEventSink(func(_ string, batch []activityshared.Event) {
		for _, event := range batch {
			events <- event
		}
	})
	appSession := adapter.getSession(session.AgentSessionID)
	newCodexAppServerReducer(adapter).ReduceNotification(appSession.client, session, "", acpMessage{
		Method: appServerNotifyTurnStarted,
		Params: mustJSONRawMessage(t, map[string]any{
			"threadId": session.ProviderSessionID,
			"turn":     map[string]any{"id": "provider-old-turn", "status": "inProgress", "items": []any{}},
		}),
	}, nil, nil)

	deadline := time.After(5 * time.Second)
	for {
		select {
		case event := <-events:
			if event.Type != activityshared.EventGoalReconcileRequired || event.Payload.Metadata["phase"] != "finalized" {
				continue
			}
			if event.Payload.Metadata["quiesceSucceeded"] != false || strings.TrimSpace(asString(event.Payload.Metadata["quiesceError"])) == "" {
				t.Fatalf("failed quiesce evidence = %#v", event.Payload.Metadata)
			}
			transport.conn.mu.Lock()
			attempts := append([]string(nil), transport.conn.interruptAttempts...)
			transport.conn.mu.Unlock()
			if len(attempts) != 3 {
				t.Fatalf("exact quiesce attempts = %#v, want 3", attempts)
			}
			for _, attempt := range attempts {
				if attempt != "provider-old-turn" {
					t.Fatalf("quiesce retargeted a different provider turn: %#v", attempts)
				}
			}
			return
		case <-deadline:
			t.Fatal("timed out waiting for failed quiesce evidence")
		}
	}
}

func TestCodexUnprovenGoalTurnDurablyPreparesBeforeExactInterrupt(t *testing.T) {
	transport := newScriptedAppServerTransport()
	adapter := NewCodexAppServerAdapter(transport)
	adapter.goalProvenanceGraceWindow = 10 * time.Millisecond
	reporter := &goalPrepareBarrierReporter{prepared: make(chan struct{}), release: make(chan struct{})}
	controller := NewController([]Adapter{adapter}, reporter)
	started, err := controller.Start(context.Background(), StartInput{RoomID: "room-1", Provider: ProviderCodex, CWD: "/workspace", Title: "Codex"})
	if err != nil {
		t.Fatal(err)
	}
	session := started.Session
	adapter.applyGoalUpdate(session.AgentSessionID, map[string]any{
		"threadId": session.ProviderSessionID, "objective": "restart", "status": "active",
		"createdAt": int64(100), "updatedAt": int64(101),
	})
	appSession := adapter.getSession(session.AgentSessionID)
	newCodexAppServerReducer(adapter).ReduceNotification(appSession.client, session, "", acpMessage{
		Method: appServerNotifyTurnStarted,
		Params: mustJSONRawMessage(t, map[string]any{
			"threadId": session.ProviderSessionID,
			"turn":     map[string]any{"id": "provider-unproven", "status": "inProgress", "items": []any{}},
		}),
	}, nil, nil)
	select {
	case <-reporter.prepared:
	case <-time.After(5 * time.Second):
		t.Fatal("pending reconcile was not reported")
	}
	transport.conn.mu.Lock()
	beforeCommit := append([]string(nil), transport.conn.interruptAttempts...)
	transport.conn.mu.Unlock()
	if len(beforeCommit) != 0 {
		t.Fatalf("exact interrupt raced ahead of durable prepare: %v", beforeCommit)
	}
	close(reporter.release)
	waitForCondition(t, func() bool {
		transport.conn.mu.Lock()
		defer transport.conn.mu.Unlock()
		return len(transport.conn.interruptAttempts) == 1 && transport.conn.interruptAttempts[0] == "provider-unproven"
	})
	waitForCondition(t, func() bool {
		phases := reporter.phaseSnapshot()
		return len(phases) >= 2 && phases[0] == "quiesce_pending" && phases[1] == "finalized"
	})
}

func TestCodexUnprovenGoalTurnPrepareFailureForceClosesProvider(t *testing.T) {
	transport := newScriptedAppServerTransport()
	adapter := NewCodexAppServerAdapter(transport)
	adapter.goalProvenanceGraceWindow = 10 * time.Millisecond
	adapter.goalReconcileAckTimeout = 20 * time.Millisecond
	controller := NewController([]Adapter{adapter}, blockingGoalReconcileReporter{})
	started, err := controller.Start(context.Background(), StartInput{RoomID: "room-1", Provider: ProviderCodex, CWD: "/workspace", Title: "Codex"})
	if err != nil {
		t.Fatal(err)
	}
	session := started.Session
	adapter.applyGoalUpdate(session.AgentSessionID, map[string]any{"threadId": session.ProviderSessionID, "objective": "restart", "status": "active"})
	appSession := adapter.getSession(session.AgentSessionID)
	newCodexAppServerReducer(adapter).ReduceNotification(appSession.client, session, "", acpMessage{
		Method: appServerNotifyTurnStarted,
		Params: mustJSONRawMessage(t, map[string]any{"threadId": session.ProviderSessionID,
			"turn": map[string]any{"id": "provider-unproven", "status": "inProgress", "items": []any{}}}),
	}, nil, nil)
	waitForCondition(t, func() bool {
		transport.conn.mu.Lock()
		defer transport.conn.mu.Unlock()
		return transport.conn.closeCount > 0
	})
	select {
	case <-appSession.client.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("provider client did not terminate after durable prepare failure")
	}
	transport.conn.mu.Lock()
	attempts := append([]string(nil), transport.conn.interruptAttempts...)
	transport.conn.mu.Unlock()
	if len(attempts) != 0 {
		t.Fatalf("unprotected exact interrupt continued after durable prepare failure: %v", attempts)
	}
}

// thread/goal/updated notifications must reach the GUI as session events even
// while no turn is running (the banner refreshes off this signal).
func TestCodexAppServerAdapterGoalUpdateNotificationEmitsSessionEvent(t *testing.T) {
	t.Parallel()

	adapter, _, session := startedAppServerAdapter(t)
	var sinkMu sync.Mutex
	sinkEvents := []activityshared.Event{}
	adapter.SetSessionEventSink(func(_ string, events []activityshared.Event) {
		sinkMu.Lock()
		defer sinkMu.Unlock()
		sinkEvents = append(sinkEvents, events...)
	})

	reducer := newCodexAppServerReducer(adapter)
	reducer.ReduceNotification(nil, session, "turn-1", acpMessage{
		Method: appServerNotifyThreadGoalUpdated,
		Params: mustJSONRawMessage(t, map[string]any{
			"threadId": session.ProviderSessionID,
			"goal": map[string]any{
				"objective": "finish it",
				"status":    "usageLimited",
			},
		}),
	}, nil, nil)

	sinkMu.Lock()
	defer sinkMu.Unlock()
	foundUpdate := false
	foundNotice := false
	for _, event := range sinkEvents {
		if event.Type == activityshared.EventSessionUpdated &&
			event.Payload.Metadata["sessionUpdateKind"] == "thread_goal_update" {
			foundUpdate = true
		}
		if event.Type == activityshared.EventMessageAppended &&
			strings.Contains(event.Payload.Content, "usage limit") {
			foundNotice = true
		}
	}
	if !foundUpdate {
		t.Fatalf("missing thread_goal_update session event, got %#v", sinkEvents)
	}
	if !foundNotice {
		t.Fatalf("missing usage-limited status notice, got %#v", sinkEvents)
	}
}

// Start/Resume restore the thread's persisted goal so the banner survives
// daemon restarts.
func TestCodexAppServerAdapterStartRestoresGoal(t *testing.T) {
	t.Parallel()

	transport := newScriptedAppServerTransport()
	adapter := NewCodexAppServerAdapter(transport)
	adapter.SetSessionEventSink(func(string, []activityshared.Event) {})
	transport.conn.mu.Lock()
	transport.conn.goal = map[string]any{
		"threadId":  "codex-thread-1",
		"objective": "finish it",
		"status":    "active",
	}
	transport.conn.mu.Unlock()
	session := testAppServerSession()
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	waitForCondition(t, func() bool {
		return asString(adapter.sessionGoal(session.AgentSessionID)["status"]) == "active"
	})
	goalGet := appServerRequestParams(t, transport.conn, appServerMethodThreadGoalGet)
	if asString(goalGet["threadId"]) != "codex-thread-1" {
		t.Fatalf("goal/get params = %#v", goalGet)
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
		{name: "uncommitted keyword", args: "uncommitted", want: map[string]any{"type": "uncommittedChanges"}},
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
	if got := countNotice("contextCompaction", "Compacting context."); got != 1 {
		t.Fatalf("context compaction progress banners = %d, want exactly 1", got)
	}
}

// The in-progress banner and the completed banner must share one messageId so
// the completed notice replaces the progress notice in place instead of
// leaving a stale "Compacting context." row in the transcript.
func TestCodexAppServerAdapterCompactionBannersShareMessageID(t *testing.T) {
	t.Parallel()

	adapter := &CodexAppServerAdapter{}
	session := Session{Provider: "codex", AgentSessionID: "agent-compact", RoomID: "room-compact"}
	normalizer := newACPTurnNormalizer()
	item := map[string]any{"type": "contextCompaction", "id": "item-compact-1"}

	started := adapter.appServerItemEvents(session, "turn-1", item, false, normalizer)
	completed := adapter.appServerItemEvents(session, "turn-1", item, true, normalizer)
	if len(started) != 1 || len(completed) != 1 {
		t.Fatalf("compaction events = %d started, %d completed, want 1 each", len(started), len(completed))
	}
	if got := started[0].Payload.Content; got != "Compacting context." {
		t.Fatalf("started banner = %q, want %q", got, "Compacting context.")
	}
	if got := completed[0].Payload.Content; got != "Context compacted." {
		t.Fatalf("completed banner = %q, want %q", got, "Context compacted.")
	}
	if got := asString(completed[0].Payload.Metadata["noticeCommandStatus"]); got != "completed" {
		t.Fatalf("completed banner status = %q, want completed", got)
	}
	startedID := asString(started[0].Payload.Metadata["messageId"])
	completedID := asString(completed[0].Payload.Metadata["messageId"])
	if startedID == "" || startedID != completedID {
		t.Fatalf("messageId mismatch: started %q, completed %q", startedID, completedID)
	}
	// The explicit provider terminal won first, so a later synthesized turn
	// terminal must not rewrite the lifecycle to canceled.
	for _, event := range normalizer.FinishInterrupted(session, "turn-1", "interrupted") {
		if asString(event.Payload.Metadata["noticeCommand"]) == "compact" {
			t.Fatalf("completed compaction was overwritten by turn interruption: %#v", event)
		}
	}
}

// A turn that dies mid-compaction must settle the in-progress banner in place;
// otherwise the transcript keeps a live "Compacting context." row ticking
// forever after the failure.
func TestCodexAppServerAdapterCompactionBannerSettlesOnInterrupt(t *testing.T) {
	t.Parallel()

	adapter := &CodexAppServerAdapter{}
	session := Session{Provider: "codex", AgentSessionID: "agent-compact", RoomID: "room-compact"}
	normalizer := newACPTurnNormalizer()
	item := map[string]any{"type": "contextCompaction", "id": "item-compact-1"}

	started := adapter.appServerItemEvents(session, "turn-1", item, false, normalizer)
	if len(started) != 1 {
		t.Fatalf("compaction started events = %d, want 1", len(started))
	}
	terminal := normalizer.FinishInterrupted(session, "turn-1", "interrupted")
	var settled *activityshared.Event
	for index := range terminal {
		if terminal[index].Payload.Content == "Context compaction interrupted." {
			settled = &terminal[index]
		}
	}
	if settled == nil {
		t.Fatalf("expected interrupted compaction banner in terminal events; got %#v", terminal)
	}
	if got, want := asString(settled.Payload.Metadata["messageId"]), asString(started[0].Payload.Metadata["messageId"]); got != want || got == "" {
		t.Fatalf("interrupted banner messageId = %q, want %q", got, want)
	}
	if got := asString(settled.Payload.Metadata["noticeCommand"]); got != "compact" {
		t.Fatalf("interrupted banner command = %q, want compact", got)
	}
	if got := asString(settled.Payload.Metadata["noticeCommandStatus"]); got != "canceled" {
		t.Fatalf("interrupted banner status = %q, want canceled", got)
	}
	// The synthesized canceled terminal won first. A provider completion that
	// was already in flight must be ignored rather than replacing it.
	if late := adapter.appServerItemEvents(session, "turn-1", item, true, normalizer); len(late) != 0 {
		t.Fatalf("late compaction completion emitted after cancellation: %#v", late)
	}
	// Once settled, later terminal calls must not emit the banner again.
	if again := normalizer.FinishFailed(session, "turn-1"); len(again) != 0 {
		for _, event := range again {
			if event.Payload.Content == "Context compaction interrupted." {
				t.Fatalf("compaction banner settled twice: %#v", again)
			}
		}
	}
}

func TestCodexAppServerAdapterCompactionBannerSettlesOnFailure(t *testing.T) {
	t.Parallel()

	adapter := &CodexAppServerAdapter{}
	session := Session{Provider: "codex", AgentSessionID: "agent-compact", RoomID: "room-compact"}
	normalizer := newACPTurnNormalizer()
	item := map[string]any{"type": "contextCompaction", "id": "item-compact-1"}

	if started := adapter.appServerItemEvents(session, "turn-1", item, false, normalizer); len(started) != 1 {
		t.Fatalf("compaction started events = %d, want 1", len(started))
	}
	terminal := normalizer.FinishFailed(session, "turn-1")
	var settled *activityshared.Event
	for index := range terminal {
		if asString(terminal[index].Payload.Metadata["noticeCommand"]) == "compact" {
			settled = &terminal[index]
		}
	}
	if settled == nil {
		t.Fatalf("expected failed compaction banner in terminal events; got %#v", terminal)
	}
	if got := asString(settled.Payload.Metadata["noticeCommandStatus"]); got != "failed" {
		t.Fatalf("failed banner status = %q, want failed", got)
	}
	if late := adapter.appServerItemEvents(session, "turn-1", item, true, normalizer); len(late) != 0 {
		t.Fatalf("late compaction completion emitted after failure: %#v", late)
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
	if numTurns, _ := int64Value(rollback["numTurns"]); numTurns != 1 {
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
	if !containsString(capabilities, CapabilityActiveTurnGuidance) || !containsString(capabilities, CapabilityRateLimits) {
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

func TestCodexAppServerAdapterStartSkipsSlowStartupProbesWhenReasoningNeedsNoValidation(t *testing.T) {
	t.Parallel()

	transport := newScriptedAppServerTransport()
	adapter := NewCodexAppServerAdapter(transport)
	session := testAppServerSession()
	session.Settings = &SessionSettings{Model: "gpt-5.3-codex-spark"}
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
	if resetsAt, _ := int64Value(sessionQuota["resetsAtUnixMs"]); resetsAt != 1750003600000 {
		t.Fatalf("session quota resetsAt = %#v", sessionQuota)
	}
}

func TestCodexAppServerAdapterClassifiesPrimaryWeeklyRateLimitFromDuration(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	transport.conn.notify(appServerNotifyRateLimitsUpdated, map[string]any{
		"rateLimits": map[string]any{
			"primary": map[string]any{
				"resetsAt":           1784604546,
				"usedPercent":        14,
				"windowDurationMins": 7 * 24 * 60,
			},
			"secondary": nil,
		},
	})
	waitForCondition(t, func() bool {
		state := adapter.SessionState(session)
		usage, _ := state.RuntimeContext["usage"].(map[string]any)
		quotas, _ := usage["quotas"].([]map[string]any)
		if len(quotas) != 1 || asString(quotas[0]["quotaType"]) != "weekly" {
			return false
		}
		remaining, _ := acpFloatValue(quotas[0]["percentRemaining"])
		return remaining == 86
	})
	state := adapter.SessionState(session)
	usage, _ := state.RuntimeContext["usage"].(map[string]any)
	quotas, _ := usage["quotas"].([]map[string]any)
	if len(quotas) != 1 {
		t.Fatalf("quotas = %#v, want one weekly quota", quotas)
	}
	if resetsAt, _ := int64Value(quotas[0]["resetsAtUnixMs"]); resetsAt != 1784604546000 {
		t.Fatalf("weekly quota resetsAt = %#v", quotas[0])
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

func TestCodexAppServerAdapterApplySessionSettingsRefreshesModelReasoningOptions(t *testing.T) {
	t.Parallel()

	adapter, _, session := startedAppServerAdapter(t)
	adapter.mu.Lock()
	appSession := adapter.sessions[session.AgentSessionID]
	appSession.models = []map[string]any{
		{
			"id":                        "gpt-5.6-sol",
			"supportedReasoningEfforts": []any{"low", "medium", "high", "xhigh", "max", "ultra"},
		},
		{
			"id":                        "gpt-5.6-luna",
			"defaultReasoningEffort":    "high",
			"supportedReasoningEfforts": []any{"low", "medium", "high", "xhigh", "max"},
		},
	}
	adapter.mu.Unlock()
	session.Settings = &SessionSettings{Model: "gpt-5.6-luna", ReasoningEffort: "ultra"}
	model := "gpt-5.6-luna"

	if err := adapter.ApplySessionSettings(context.Background(), session, SessionSettingsPatch{
		Model: &model,
	}); err != nil {
		t.Fatalf("ApplySessionSettings: %v", err)
	}
	state := adapter.SessionState(session)
	options, _ := state.RuntimeContext["configOptions"].([]map[string]any)
	modelConfig := configOptionByID(options, "model")
	modelOptions := configOptionEntries(modelConfig["options"])
	if len(modelOptions) != 2 {
		t.Fatalf("model options = %#v, want two capability-bearing models", modelOptions)
	}
	firstModelEfforts := configOptionEntries(modelOptions[0]["reasoningEfforts"])
	gotModelEfforts := make([]string, 0, len(firstModelEfforts))
	for _, effort := range firstModelEfforts {
		gotModelEfforts = append(gotModelEfforts, asString(effort["value"]))
	}
	if !slices.Equal(gotModelEfforts, []string{"low", "medium", "high", "xhigh", "max", "ultra"}) {
		t.Fatalf("first model reasoning options = %#v, want full Sol profile; raw=%#v", gotModelEfforts, firstModelEfforts)
	}
	if modelOptions[0]["supportsReasoningEffort"] != true || asString(modelOptions[0]["reasoningEffort"]) != "low" {
		t.Fatalf("first model reasoning metadata = %#v", modelOptions[0])
	}
	reasoning := configOptionByID(options, "reasoning_effort")
	if got := configOptionValues(reasoning); !slices.Equal(got, []string{"low", "medium", "high", "xhigh", "max"}) {
		t.Fatalf("reasoning options = %#v, want Luna efforts without ultra", got)
	}
	if got := asString(reasoning["currentValue"]); got != "high" {
		t.Fatalf("reasoning current value = %q, want high", got)
	}
}

func TestCodexAppServerAdapterExecStateSnapshotOwnsMutableSettings(t *testing.T) {
	t.Parallel()

	adapter, _, session := startedAppServerAdapter(t)
	adapter.mu.Lock()
	appSession := adapter.sessions[session.AgentSessionID]
	appSession.models = []map[string]any{{
		"model":                     "gpt-5.6-sol",
		"supportedReasoningEfforts": []any{"high", "ultra"},
	}}
	appSession.configOptions = map[string]any{
		"model":            "gpt-5.6-sol",
		"reasoning_effort": "ultra",
		"nested":           map[string]any{"value": "original"},
	}
	appSession.defaultModel = "gpt-5.6-sol"
	adapter.mu.Unlock()

	snapshot, ok := adapter.snapshotExecState(session.AgentSessionID)
	if !ok {
		t.Fatal("snapshotExecState = false, want live session")
	}

	adapter.mu.Lock()
	appSession.models[0]["model"] = "changed-model"
	efforts, _ := appSession.models[0]["supportedReasoningEfforts"].([]any)
	efforts[0] = "changed-effort"
	appSession.configOptions["model"] = "changed-model"
	nested, _ := appSession.configOptions["nested"].(map[string]any)
	nested["value"] = "changed"
	appSession.defaultModel = "changed-model"
	adapter.mu.Unlock()

	if got := asString(snapshot.models[0]["model"]); got != "gpt-5.6-sol" {
		t.Fatalf("snapshot model = %q, want gpt-5.6-sol", got)
	}
	snapshotEfforts, _ := snapshot.models[0]["supportedReasoningEfforts"].([]any)
	if got := asString(snapshotEfforts[0]); got != "high" {
		t.Fatalf("snapshot reasoning effort = %q, want high", got)
	}
	if got := asString(snapshot.config["model"]); got != "gpt-5.6-sol" {
		t.Fatalf("snapshot config model = %q, want gpt-5.6-sol", got)
	}
	snapshotNested, _ := snapshot.config["nested"].(map[string]any)
	if got := asString(snapshotNested["value"]); got != "original" {
		t.Fatalf("snapshot nested config = %q, want original", got)
	}
	if snapshot.defaultModel != "gpt-5.6-sol" {
		t.Fatalf("snapshot default model = %q, want gpt-5.6-sol", snapshot.defaultModel)
	}
}

func TestCodexAppServerAdapterExecStateSnapshotConcurrentSettingsUpdates(t *testing.T) {
	t.Parallel()

	adapter, _, session := startedAppServerAdapter(t)
	const iterations = 500
	start := make(chan struct{})
	errCh := make(chan error, 1)
	report := func(err error) {
		select {
		case errCh <- err:
		default:
		}
	}

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		<-start
		for i := range iterations {
			model := "gpt-5.1-codex"
			effort := "high"
			speed := "standard"
			if i%2 == 1 {
				model = "gpt-5.1-codex-mini"
				effort = "low"
				speed = "fast"
			}
			updated := session
			updated.Settings = &SessionSettings{Model: model, ReasoningEffort: effort, Speed: speed}
			if err := adapter.ApplySessionSettings(context.Background(), updated, SessionSettingsPatch{
				Model:           &model,
				ReasoningEffort: &effort,
				Speed:           &speed,
			}); err != nil {
				report(fmt.Errorf("ApplySessionSettings: %w", err))
				return
			}
		}
	}()
	go func() {
		defer wg.Done()
		<-start
		for range iterations {
			snapshot, ok := adapter.snapshotExecState(session.AgentSessionID)
			if !ok {
				report(errors.New("snapshotExecState lost live session"))
				return
			}
			for _, model := range snapshot.models {
				_ = fmt.Sprint(model)
			}
			_ = fmt.Sprint(snapshot.config)
			_ = snapshot.defaultModel
		}
	}()
	close(start)
	wg.Wait()
	select {
	case err := <-errCh:
		t.Fatal(err)
	default:
	}
}

func TestCodexAppServerAdapterLateModelListPreservesUpdatedSettings(t *testing.T) {
	t.Parallel()

	adapter, _, session := startedAppServerAdapter(t)
	adapter.mu.Lock()
	adapter.sessions[session.AgentSessionID].models = nil
	adapter.mu.Unlock()
	model := "gpt-5.6-luna"
	effort := "high"
	updatedSession := session
	updatedSession.Settings = &SessionSettings{Model: model, ReasoningEffort: effort}
	if err := adapter.ApplySessionSettings(context.Background(), updatedSession, SessionSettingsPatch{
		Model:           &model,
		ReasoningEffort: &effort,
	}); err != nil {
		t.Fatalf("ApplySessionSettings: %v", err)
	}

	startupSession := session
	startupSession.Settings = &SessionSettings{Model: "gpt-5.6-sol", ReasoningEffort: "ultra"}
	if applied := adapter.applyStartupModels(session.AgentSessionID, startupSession, nil, []map[string]any{
		{
			"id":                        "gpt-5.6-sol",
			"defaultReasoningEffort":    "high",
			"supportedReasoningEfforts": []any{"low", "medium", "high", "xhigh", "max", "ultra"},
		},
		{
			"id":                        "gpt-5.6-luna",
			"defaultReasoningEffort":    "high",
			"supportedReasoningEfforts": []any{"low", "medium", "high", "xhigh", "max"},
		},
	}); !applied {
		t.Fatal("applyStartupModels = false, want true")
	}

	state := adapter.SessionState(updatedSession)
	config, _ := state.RuntimeContext["config"].(map[string]any)
	if got := asString(config["model"]); got != model {
		t.Fatalf("late model/list model = %q, want %q", got, model)
	}
	if got := asString(config["reasoning_effort"]); got != effort {
		t.Fatalf("late model/list reasoning effort = %q, want %q", got, effort)
	}
}

func TestCodexAppServerAdapterClearedSettingsOverrideStaleLiveConfigBeforeModels(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	adapter.mu.Lock()
	appSession := adapter.sessions[session.AgentSessionID]
	appSession.models = nil
	appSession.configOptions = map[string]any{
		"model":            "gpt-stale",
		"reasoning_effort": "ultra",
	}
	adapter.mu.Unlock()
	empty := ""
	updatedSession := session
	updatedSession.Settings = &SessionSettings{}
	if err := adapter.ApplySessionSettings(context.Background(), updatedSession, SessionSettingsPatch{
		Model:           &empty,
		ReasoningEffort: &empty,
	}); err != nil {
		t.Fatalf("ApplySessionSettings: %v", err)
	}
	state := adapter.SessionState(updatedSession)
	if state.Settings == nil || state.Settings.Model != "" || state.Settings.ReasoningEffort != "" {
		t.Fatalf("cleared live settings = %#v, want empty model and reasoning", state.Settings)
	}

	if _, err := adapter.Exec(context.Background(), updatedSession, []PromptContentBlock{{
		Type: "text", Text: "go",
	}}, "", "turn-clear-before-models", nil, nil); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	turnStart := appServerRequestParams(t, transport.conn, appServerMethodTurnStart)
	if got := asString(turnStart["model"]); got == "gpt-stale" {
		t.Fatalf("turn/start model = %q, stale explicit model was restored", got)
	}
	if got := asString(turnStart["effort"]); got != "" {
		t.Fatalf("turn/start effort = %q, want cleared", got)
	}
}

func TestCodexAppServerAdapterModelWithoutReasoningClearsEffectiveState(t *testing.T) {
	t.Parallel()

	adapter, _, session := startedAppServerAdapter(t)
	adapter.mu.Lock()
	adapter.sessions[session.AgentSessionID].models = []map[string]any{
		{
			"model":                     "gpt-reasoning",
			"defaultReasoningEffort":    "high",
			"supportedReasoningEfforts": []any{"low", "high"},
		},
		{
			"model":                     "gpt-no-reasoning",
			"supportedReasoningEfforts": []any{},
		},
	}
	adapter.mu.Unlock()
	updatedSession := session
	updatedSession.Settings = &SessionSettings{Model: "gpt-no-reasoning", ReasoningEffort: "high"}
	model := "gpt-no-reasoning"
	if err := adapter.ApplySessionSettings(context.Background(), updatedSession, SessionSettingsPatch{
		Model: &model,
	}); err != nil {
		t.Fatalf("ApplySessionSettings: %v", err)
	}

	state := adapter.SessionState(updatedSession)
	if state.Settings == nil || state.Settings.Model != model || state.Settings.ReasoningEffort != "" {
		t.Fatalf("effective settings = %#v, want no-reasoning model with empty effort", state.Settings)
	}
	options, _ := state.RuntimeContext["configOptions"].([]map[string]any)
	reasoning := configOptionByID(options, "reasoning_effort")
	if reasoning == nil || len(configOptionValues(reasoning)) != 0 || reasoning["currentValue"] != nil {
		t.Fatalf("reasoning option = %#v, want explicit empty live profile", reasoning)
	}
}

func TestCodexAppServerAdapterLateModelListHonorsClearedSettings(t *testing.T) {
	t.Parallel()

	adapter, _, session := startedAppServerAdapter(t)
	adapter.mu.Lock()
	appSession := adapter.sessions[session.AgentSessionID]
	appSession.models = nil
	appSession.configOptions = map[string]any{
		"model":            "gpt-stale",
		"reasoning_effort": "ultra",
	}
	adapter.mu.Unlock()
	empty := ""
	updatedSession := session
	updatedSession.Settings = &SessionSettings{}
	if err := adapter.ApplySessionSettings(context.Background(), updatedSession, SessionSettingsPatch{
		Model:           &empty,
		ReasoningEffort: &empty,
	}); err != nil {
		t.Fatalf("ApplySessionSettings: %v", err)
	}

	startupSession := session
	startupSession.Settings = &SessionSettings{Model: "gpt-stale", ReasoningEffort: "ultra"}
	if applied := adapter.applyStartupModels(session.AgentSessionID, startupSession, nil, []map[string]any{
		{
			"model":                     "gpt-default",
			"isDefault":                 true,
			"defaultReasoningEffort":    "medium",
			"supportedReasoningEfforts": []any{"low", "medium", "high"},
		},
		{
			"model":                     "gpt-stale",
			"defaultReasoningEffort":    "high",
			"supportedReasoningEfforts": []any{"high", "ultra"},
		},
	}); !applied {
		t.Fatal("applyStartupModels = false, want true")
	}

	state := adapter.SessionState(updatedSession)
	config, _ := state.RuntimeContext["config"].(map[string]any)
	if got := asString(config["model"]); got != "gpt-default" {
		t.Fatalf("late model/list model = %q, want provider default", got)
	}
	if got := asString(config["reasoning_effort"]); got != "medium" {
		t.Fatalf("late model/list reasoning = %q, want provider default", got)
	}
}

func TestCodexAppServerAdapterLateModelListClampsProviderDefaultReasoning(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	adapter.mu.Lock()
	appSession := adapter.sessions[session.AgentSessionID]
	appSession.models = nil
	appSession.configOptions = map[string]any{"reasoning_effort": "ultra"}
	adapter.mu.Unlock()
	session.Settings = &SessionSettings{ReasoningEffort: "ultra"}
	models := []map[string]any{{
		"id":                        "gpt-default",
		"isDefault":                 true,
		"defaultReasoningEffort":    "high",
		"supportedReasoningEfforts": []any{"low", "medium", "high"},
	}}

	if applied := adapter.applyStartupModels(session.AgentSessionID, session, nil, models); !applied {
		t.Fatal("applyStartupModels = false, want true")
	}
	state := adapter.SessionState(session)
	config, _ := state.RuntimeContext["config"].(map[string]any)
	if got := asString(config["model"]); got != "gpt-default" {
		t.Fatalf("late model/list model = %q, want gpt-default", got)
	}
	if got := asString(config["reasoning_effort"]); got != "high" {
		t.Fatalf("late model/list reasoning effort = %q, want high", got)
	}
	if state.Settings == nil || state.Settings.Model != "gpt-default" || state.Settings.ReasoningEffort != "high" {
		t.Fatalf("late model/list settings = %#v, want gpt-default/high", state.Settings)
	}

	if _, err := adapter.Exec(context.Background(), session, []PromptContentBlock{{
		Type: "text", Text: "go",
	}}, "", "turn-default-model", nil, nil); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	turnStart := appServerRequestParams(t, transport.conn, appServerMethodTurnStart)
	if got := asString(turnStart["model"]); got != "gpt-default" {
		t.Fatalf("turn/start model = %q, want gpt-default", got)
	}
	if got := asString(turnStart["effort"]); got != "high" {
		t.Fatalf("turn/start effort = %q, want high", got)
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

// TestCodexAppServerAdapterApplyPermissionModeSucceedsMidTurnAndAppliesNextTurn
// locks in the contract the composer UI's live permission-mode switch now
// relies on: the app-server protocol has no RPC to change approval/sandbox
// policy for a turn that's already running, so ApplyPermissionMode must still
// succeed while a turn is in flight (rather than error or block), and the
// new policy must only take effect starting with the *next* turn/start --
// matching the "applies starting with your next message" copy shown to the
// user when they change permission mode mid-turn.
func TestCodexAppServerAdapterApplyPermissionModeSucceedsMidTurnAndAppliesNextTurn(t *testing.T) {
	t.Parallel()

	transport := newScriptedAppServerTransport()
	adapter := NewCodexAppServerAdapterWithHostMetadataAndOptions(
		transport,
		LegacyHostMetadata(),
		CodexAppServerAdapterOptions{CommandNetworkAccess: true},
	)
	session := testAppServerSession()
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	session.ProviderSessionID = "codex-thread-1"
	session.PermissionModeID = "read-only"
	transport.conn.holdTurn = true

	execDone := make(chan struct{})
	go func() {
		_, _ = adapter.Exec(context.Background(), session, []PromptContentBlock{{
			Type: "text", Text: "go",
		}}, "", "turn-local-1", nil, nil)
		close(execDone)
	}()
	waitForCondition(t, func() bool {
		return adapter.sessionActiveTurnID(session.AgentSessionID) == "turn-1"
	})

	firstTurnStart := appServerRequestParams(t, transport.conn, appServerMethodTurnStart)
	if asString(firstTurnStart["approvalPolicy"]) != "on-request" {
		t.Fatalf("first turn/start approvalPolicy = %#v, want on-request", firstTurnStart["approvalPolicy"])
	}
	firstPolicy, _ := firstTurnStart["sandboxPolicy"].(map[string]any)
	if asString(firstPolicy["type"]) != "readOnly" {
		t.Fatalf("first turn/start sandboxPolicy = %#v, want readOnly", firstPolicy)
	}
	if enabled, _ := firstPolicy["networkAccess"].(bool); !enabled {
		t.Fatalf("first turn/start sandboxPolicy = %#v, want networkAccess=true", firstPolicy)
	}

	session.PermissionModeID = "full-access"
	if err := adapter.ApplyPermissionMode(context.Background(), session); err != nil {
		t.Fatalf("ApplyPermissionMode mid-turn: %v", err)
	}

	transport.conn.completePendingTurn()
	<-execDone

	// The turn that was already running is unaffected by the change: exactly
	// one turn/start was sent for it.
	if turnStarts := appServerRequestParamsList(t, transport.conn, appServerMethodTurnStart); len(turnStarts) != 1 {
		t.Fatalf("turn/start calls = %d, want 1 before the next turn", len(turnStarts))
	}

	transport.conn.holdTurn = false
	if _, err := adapter.Exec(context.Background(), session, []PromptContentBlock{{
		Type: "text", Text: "go again",
	}}, "", "turn-local-2", nil, nil); err != nil {
		t.Fatalf("Exec (second turn): %v", err)
	}

	turnStarts := appServerRequestParamsList(t, transport.conn, appServerMethodTurnStart)
	if len(turnStarts) != 2 {
		t.Fatalf("turn/start calls = %d, want 2 after the next turn", len(turnStarts))
	}
	if asString(turnStarts[1]["approvalPolicy"]) != "never" {
		t.Fatalf("second turn/start approvalPolicy = %#v, want never", turnStarts[1]["approvalPolicy"])
	}
	secondPolicy, _ := turnStarts[1]["sandboxPolicy"].(map[string]any)
	if asString(secondPolicy["type"]) != "dangerFullAccess" {
		t.Fatalf("second turn/start sandboxPolicy = %#v, want dangerFullAccess", secondPolicy)
	}
	if _, ok := secondPolicy["networkAccess"]; ok {
		t.Fatalf("second turn/start sandboxPolicy = %#v, want implicit full-access networking", secondPolicy)
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

func TestCodexAppServerAdapterTerminalErrorNotificationFailsTurn(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	transport.conn.holdTurn = true

	var events []activityshared.Event
	var execErr error
	execDone := make(chan struct{})
	go func() {
		events, execErr = adapter.Exec(context.Background(), session, []PromptContentBlock{{
			Type: "text", Text: "go",
		}}, "", "turn-local-1", nil, nil)
		close(execDone)
	}()
	waitForCondition(t, func() bool {
		return adapter.sessionActiveTurnID(session.AgentSessionID) == "turn-1"
	})

	transport.conn.notify(appServerNotifyError, map[string]any{
		"threadId":  "codex-thread-1",
		"turnId":    "turn-1",
		"willRetry": false,
		"error":     map[string]any{"message": "model overloaded"},
	})

	select {
	case <-execDone:
	case <-time.After(2 * time.Second):
		t.Fatal("Exec did not unblock after terminal error notification")
	}
	if execErr != nil {
		t.Fatalf("Exec: %v", execErr)
	}
	failed := eventsOfType(events, activityshared.EventRootProviderTurnCompleted)
	if len(failed) != 1 || failed[0].Payload.TurnOutcome != string(activityshared.TurnOutcomeFailed) {
		t.Fatalf("root provider failed events = %#v, want one failed outcome; events = %#v", failed, events)
	}
	if got := asString(failed[0].Payload.Metadata["error"]); got != "model overloaded" {
		t.Fatalf("turn failure error = %q, want model overloaded", got)
	}
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
	} else if _, ok := nexight.(*standardACPAdapter); !ok {
		t.Fatalf("nexight adapter = %T, want standard ACP adapter", nexight)
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
	if value := asString(settings["developer_instructions"]); value != testAppServerPlanCollaborationInstructions {
		t.Fatalf("collaborationMode settings = %#v, want plan developer_instructions", settings)
	}

	defaultAdapter, defaultTransport, defaultSession := startedAppServerAdapter(t)
	defaultSession.Settings = &SessionSettings{PlanMode: false}
	if _, err := defaultAdapter.Exec(context.Background(), defaultSession, []PromptContentBlock{{
		Type: "text", Text: "now build",
	}}, "", "turn-plan-2", nil, nil); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	defaultTurnStart := appServerRequestParams(t, defaultTransport.conn, appServerMethodTurnStart)
	exitMode, _ := defaultTurnStart["collaborationMode"].(map[string]any)
	if asString(exitMode["mode"]) != "default" {
		t.Fatalf("turn/start collaborationMode = %#v, want explicit default mode", defaultTurnStart["collaborationMode"])
	}
	exitSettings, _ := exitMode["settings"].(map[string]any)
	if asString(exitSettings["model"]) != "gpt-5.1-codex" {
		t.Fatalf("default collaborationMode settings = %#v, want default model", exitSettings)
	}
	if value := asString(exitSettings["developer_instructions"]); value != testAppServerDefaultCollaborationInstructions {
		t.Fatalf("default collaborationMode settings = %#v, want default developer_instructions", exitSettings)
	}

	overrideAdapter, overrideTransport, overrideSession := startedAppServerAdapter(t)
	overrideSession.Settings = &SessionSettings{PlanMode: true, Model: "gpt-5.1-codex-mini", ReasoningEffort: "low"}
	if _, err := overrideAdapter.Exec(context.Background(), overrideSession, []PromptContentBlock{{
		Type: "text", Text: "plan again",
	}}, "", "turn-plan-3", nil, nil); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	overrideTurnStart := appServerRequestParams(t, overrideTransport.conn, appServerMethodTurnStart)
	overrideMode, _ := overrideTurnStart["collaborationMode"].(map[string]any)
	overrideSettings, _ := overrideMode["settings"].(map[string]any)
	if asString(overrideSettings["model"]) != "gpt-5.1-codex-mini" || asString(overrideSettings["reasoning_effort"]) != "low" {
		t.Fatalf("collaborationMode settings = %#v, want session overrides", overrideSettings)
	}
	if value := asString(overrideSettings["developer_instructions"]); value != testAppServerPlanCollaborationInstructions {
		t.Fatalf("plan collaborationMode settings = %#v, want plan developer_instructions", overrideSettings)
	}
}

func TestCodexAppServerAdapterDoesNotSendConversationDetailModeInstructionsPerTurn(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	session.Settings = &SessionSettings{ConversationDetailMode: AgentConversationDetailModeGeneral}
	if _, err := adapter.Exec(context.Background(), session, []PromptContentBlock{{
		Type: "text", Text: "summarize this",
	}}, "", "turn-general-1", nil, nil); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	turnStart := appServerRequestParams(t, transport.conn, appServerMethodTurnStart)
	collaborationMode, _ := turnStart["collaborationMode"].(map[string]any)
	if asString(collaborationMode["mode"]) != "default" {
		t.Fatalf("turn/start collaborationMode = %#v, want default mode", turnStart["collaborationMode"])
	}
	settings, _ := collaborationMode["settings"].(map[string]any)
	if value := asString(settings["developer_instructions"]); value != testAppServerDefaultCollaborationInstructions {
		t.Fatalf("collaborationMode settings = %#v, want default collaboration mode developer_instructions", settings)
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
