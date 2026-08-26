package agentruntime

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"sync"
)

type standardACPTransport struct {
	mu    sync.Mutex
	specs []ProcessSpec
	conn  *standardACPConnection
}

type multiProcStandardACPTransport struct {
	mu                       sync.Mutex
	agentTitle               string
	sessionID                string
	supportsLoadSession      bool
	supportsAgentLoadSession bool
	promptImage              bool
	configOptions            []map[string]any
	initializeError          *acpError
	newSessionError          *acpError
	newSessionErrors         []*acpError
	loadSessionError         *acpError
	closeFailures            int
	specs                    []ProcessSpec
	conns                    []*standardACPConnection
}

func newStandardACPTransport(agentTitle string, sessionID string) *standardACPTransport {
	return &standardACPTransport{
		conn: &standardACPConnection{
			recv:            make(chan ProcessFrame, 32),
			agentTitle:      agentTitle,
			sessionID:       sessionID,
			supportsHTTPMCP: true,
		},
	}
}

func (t *standardACPTransport) Start(_ context.Context, spec ProcessSpec) (ProcessConnection, error) {
	t.mu.Lock()
	t.specs = append(t.specs, spec)
	t.mu.Unlock()
	return t.conn, nil
}

func (t *multiProcStandardACPTransport) Start(_ context.Context, spec ProcessSpec) (ProcessConnection, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	configOptions := make([]map[string]any, 0, len(t.configOptions))
	for _, option := range t.configOptions {
		configOptions = append(configOptions, clonePayloadDeep(option))
	}
	conn := &standardACPConnection{
		recv:                     make(chan ProcessFrame, 32),
		agentTitle:               t.agentTitle,
		sessionID:                t.sessionID,
		supportsLoadSession:      t.supportsLoadSession,
		supportsAgentLoadSession: t.supportsAgentLoadSession,
		promptImage:              t.promptImage,
		supportsHTTPMCP:          true,
		configOptions:            configOptions,
		initializeError:          t.initializeError,
		newSessionError:          t.newSessionError,
		newSessionErrors:         append([]*acpError(nil), t.newSessionErrors...),
		loadSessionError:         t.loadSessionError,
		closeFailures:            t.closeFailures,
	}
	t.specs = append(t.specs, spec)
	t.conns = append(t.conns, conn)
	return conn, nil
}

func (t *multiProcStandardACPTransport) snapshot() (spawned int, live []*standardACPConnection) {
	t.mu.Lock()
	conns := append([]*standardACPConnection(nil), t.conns...)
	t.mu.Unlock()
	for _, conn := range conns {
		conn.mu.Lock()
		closed := conn.isClosed
		conn.mu.Unlock()
		if !closed {
			live = append(live, conn)
		}
	}
	return len(conns), live
}

type standardACPConnection struct {
	mu                            sync.Mutex
	closeOnce                     sync.Once
	recv                          chan ProcessFrame
	agentTitle                    string
	sessionID                     string
	lastInitializeParamsSnapshot  map[string]any
	commandUpdateOnNewSession     bool
	commandUpdateOnLoadSession    bool
	availableCommands             []AgentSessionCommand
	promptPermission              bool
	promptKind                    string
	pauseBeforePromptResult       chan struct{}
	pauseBeforeToolCallCompletion chan struct{}
	pauseBeforeAskUserToolUpdate  chan struct{}
	pauseSettingsRPCStarted       chan struct{}
	pauseSettingsRPCRelease       chan struct{}
	pendingPermissionCallID       json.RawMessage
	selectedPermissionOption      string
	selectedInteractiveResult     map[string]any
	selectedInteractiveError      *acpError
	appliedModeID                 string
	lastSetModeParamsSnapshot     map[string]any
	lastAuthenticatedMethodID     string
	setModeError                  *acpError
	setModelError                 *acpError
	loadSessionError              *acpError
	closeSessionError             *acpError
	rejectModelValue              string
	supportsLoadSession           bool
	supportsAgentLoadSession      bool
	promptImage                   bool
	supportsHTTPMCP               bool
	supportsCloseSession          bool
	closeSessionExits             bool
	isClosed                      bool
	lastNewSessionParams          map[string]any
	newSessionCallCount           int
	newSessionErrors              []*acpError
	lastLoadSessionParams         map[string]any
	lastCloseSessionParams        map[string]any
	lastPromptParamsSnapshot      map[string]any
	promptParamsSnapshots         []map[string]any
	promptCallCount               int
	// deferFirstPromptUntilCancel emulates an ACP provider that accepts
	// session/cancel asynchronously and only then settles session/prompt.
	deferFirstPromptUntilCancel bool
	// canceledDeferredPromptRetriableTail makes the deferred prompt settle with
	// Cursor's retriable-tail shape when session/cancel arrives. It exercises
	// the race where cancellation and auto-continue become observable together.
	canceledDeferredPromptRetriableTail bool
	promptStarted                       chan struct{}
	pendingPromptID                     json.RawMessage
	cancelCalls                         int
	lastCancelParams                    map[string]any
	// promptFinalContent attaches final assistant content blocks to the
	// session/prompt result so tests can exercise final snapshot projection.
	promptFinalContent []map[string]any
	// retriableErrorPrompts makes the first N session/prompt calls emulate
	// cursor-agent's transient-failure shape: an "Error: RetriableError: ..."
	// text chunk followed by a normal end_turn result.
	retriableErrorPrompts int
	// retriableErrorPriorText, when set, is streamed as an agent_message_chunk
	// before the RetriableError tail so tests can exercise mid-task
	// auto-continue wording (useful progress before the drop).
	retriableErrorPriorText string
	// planLimitPromptError makes session/prompt fail with Cursor's plan-gate
	// copy so the adapter can soft-settle instead of emitting a red failure.
	planLimitPromptError bool
	// omitAssistantTextInPromptResults drops the agent_message_chunk from
	// normal prompt results, emulating a tool-calls-only turn.
	omitAssistantTextInPromptResults bool
	// emptyPromptResult returns a normal ACP end_turn without any session
	// updates, matching providers that hide a model/account failure.
	emptyPromptResult bool
	// promptResultUpdates replaces the normal prompt stream with only these
	// session updates followed by end_turn.
	promptResultUpdates      []map[string]any
	setConfigOptionSnapshots []map[string]any
	setModelSnapshots        []map[string]any
	configOptions            []map[string]any
	models                   map[string]any
	modes                    map[string]any
	authMethods              []map[string]any
	authenticateResult       map[string]any
	authenticateError        *acpError
	initializeError          *acpError
	newSessionError          *acpError
	requireAuthentication    bool
	closeFailures            int
	closeCalls               int
}

func (c *standardACPConnection) Recv() (ProcessFrame, error) {
	frame, ok := <-c.recv
	if !ok {
		return ProcessFrame{}, io.EOF
	}
	return frame, nil
}

func (c *standardACPConnection) Close() error {
	c.mu.Lock()
	c.closeCalls++
	if c.closeFailures > 0 {
		c.closeFailures--
		c.mu.Unlock()
		return errors.New("injected transport close failure")
	}
	c.isClosed = true
	c.mu.Unlock()
	c.closeRecv()
	return nil
}

func (c *standardACPConnection) closeRecv() {
	c.closeOnce.Do(func() {
		close(c.recv)
	})
}

func (c *standardACPConnection) sendJSON(value any) {
	raw, _ := json.Marshal(value)
	raw = append(raw, '\n')
	c.recv <- ProcessFrame{Stdout: raw}
}
