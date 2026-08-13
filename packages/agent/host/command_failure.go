package agenthost

import (
	"context"
	"strings"
	"sync"
	"time"
)

// commandPreconditionStage names the boundary emission for a command that
// failed before it reached any observable lifecycle step: argument validation,
// submit-claim preparation, send fences, and lock acquisition.
const commandPreconditionStage = "precondition"

// commandTerminalFailure aggregates one Host command into at most one
// TerminalFailure. LifecycleStep stays diagnostic; it only records the first
// failing stage so the command boundary can name where the command broke.
// A more specific emission inside the command (guidance target, goal control,
// durable delta) marks the aggregation as already reported.
type commandTerminalFailure struct {
	flow string

	mu             sync.Mutex
	workspaceID    string
	agentSessionID string
	operationID    string
	requestID      string
	clientSubmitID string
	turnID         string
	provider       string
	stage          string
	startedAt      time.Time
	emitted        bool
}

type commandTerminalFailureInput struct {
	flow           string
	workspaceID    string
	agentSessionID string
	operationID    string
	requestID      string
	clientSubmitID string
	turnID         string
}

type commandTerminalFailureKey struct{}

// beginCommand scopes a terminal-failure aggregation to one Host command. A
// nested command scopes its own aggregation for its callees only.
func (h *Host) beginCommand(
	ctx context.Context,
	input commandTerminalFailureInput,
) (context.Context, *commandTerminalFailure) {
	command := &commandTerminalFailure{
		flow:           strings.TrimSpace(input.flow),
		workspaceID:    strings.TrimSpace(input.workspaceID),
		agentSessionID: strings.TrimSpace(input.agentSessionID),
		operationID:    strings.TrimSpace(input.operationID),
		requestID:      strings.TrimSpace(input.requestID),
		clientSubmitID: strings.TrimSpace(input.clientSubmitID),
		turnID:         strings.TrimSpace(input.turnID),
	}
	if h != nil {
		command.startedAt = h.now()
	}
	if h == nil || h.terminalFailure == nil {
		return ctx, command
	}
	return context.WithValue(ctx, commandTerminalFailureKey{}, command), command
}

func commandTerminalFailureFrom(ctx context.Context) *commandTerminalFailure {
	command, _ := ctx.Value(commandTerminalFailureKey{}).(*commandTerminalFailure)
	return command
}

// recordCommandFailureStage keeps the first failing stage of the running
// command. Steps from a different flow (notably session_create_cleanup, which
// runs only after a primary failure) never claim the stage.
func recordCommandFailureStage(ctx context.Context, flow, workspaceID, agentSessionID, provider, stage string, err error) {
	command := commandTerminalFailureFrom(ctx)
	if command == nil || err == nil || command.flow != flow {
		return
	}
	command.mu.Lock()
	defer command.mu.Unlock()
	if command.stage != "" {
		return
	}
	command.stage = stage
	if value := strings.TrimSpace(workspaceID); value != "" {
		command.workspaceID = value
	}
	if value := strings.TrimSpace(agentSessionID); value != "" {
		command.agentSessionID = value
	}
	if value := strings.TrimSpace(provider); value != "" {
		command.provider = value
	}
}

func markCommandTerminalFailureEmitted(ctx context.Context) {
	command := commandTerminalFailureFrom(ctx)
	if command == nil {
		return
	}
	command.mu.Lock()
	command.emitted = true
	command.mu.Unlock()
}

// finish emits the single aggregated failure for a command that returned err.
func (c *commandTerminalFailure) finish(ctx context.Context, h *Host, err error) {
	if c == nil || err == nil {
		return
	}
	c.mu.Lock()
	emitted, stage := c.emitted, c.stage
	failure := TerminalFailure{
		Flow:           c.flow,
		WorkspaceID:    c.workspaceID,
		AgentSessionID: c.agentSessionID,
		OperationID:    c.operationID,
		RequestID:      c.requestID,
		ClientSubmitID: c.clientSubmitID,
		TurnID:         c.turnID,
		Provider:       c.provider,
	}
	startedAt := c.startedAt
	c.mu.Unlock()
	if emitted {
		return
	}
	if stage == "" {
		stage = commandPreconditionStage
	}
	failure.FailureStage = stage
	failure.ErrorCode = terminalFailureCode(err)
	failure.ErrorMessage = err.Error()
	failure.Retryable = isRetryableRuntimeOperationError(err)
	if duration := h.now().Sub(startedAt).Milliseconds(); duration > 0 {
		failure.DurationMS = duration
	}
	h.observeTerminalFailure(ctx, failure)
}
