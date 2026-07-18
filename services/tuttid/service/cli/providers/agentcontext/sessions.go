package agentcontext

import (
	"context"
	"fmt"
	"strings"
	"time"

	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
	"github.com/tutti-os/tutti/services/tuttid/service/cli/framework"
)

var sessionColumns = []cliservice.TableColumn{
	{Key: "id", Label: "ID"},
	{Key: "provider", Label: "Provider"},
	{Key: "activeTurnId", Label: "Active Turn"},
	{Key: "latestTurnPhase", Label: "Latest Phase"},
	{Key: "latestTurnOutcome", Label: "Latest Outcome"},
	{Key: "title", Label: "Title"},
}

type sessionSummaryInput struct {
	SessionID     string `cli:"session-id" validate:"required" description:"Agent session id to inspect."`
	Limit         int    `cli:"limit" validate:"min=0" description:"Maximum number of recent messages to return."`
	AfterVersion  int64  `cli:"after-version" validate:"min=0" description:"Return messages after this message version."`
	BeforeVersion int64  `cli:"before-version" validate:"min=0" description:"Return messages before this message version when order is desc."`
	Order         string `cli:"order" description:"Message order: asc or desc."`
}

type waitInput struct {
	SessionID    string `cli:"session-id" validate:"required" description:"Agent session id to await."`
	AfterVersion *int64 `cli:"after-version" validate:"min=0" description:"Wait for a stop point after this message version."`
	TimeoutMS    int    `cli:"timeout-ms" validate:"min=0" description:"Maximum time to wait in milliseconds before returning a timeout result."`
}

type turnResourcesInput struct {
	SessionID string `cli:"session-id" validate:"required" description:"Agent session id to inspect."`
	TurnID    string `cli:"turn-id" validate:"required" description:"Turn id whose resources should be returned."`
	Limit     int    `cli:"limit" validate:"min=0" description:"Maximum number of messages from the turn to inspect."`
}

type sessionSummaryResult struct {
	ImageLocalPath imageLocalPathResolver
	Page           agentservice.SessionMessagesPage
	Session        agentservice.Session
}

type waitCommandResult struct {
	Result agentservice.WaitResult
}

type turnResourcesResult struct {
	ImageLocalPath imageLocalPathResolver
	Page           agentservice.SessionMessagesPage
	TurnID         string
}

func (p Provider) newSessionsCommand(path []string, id string) cliservice.Command {
	return framework.Register(framework.CommandSpec[struct{}]{
		ID:          id,
		Path:        path,
		Summary:     "List agent sessions",
		Description: "List agent sessions in the current workspace. JSON output returns compact session summaries.",
		Kind:        framework.KindList,
		Workspace:   framework.WorkspaceRequired,
		Workspaces:  p.workspaces,
		Inputs:      framework.FromStruct[struct{}](),
		Output: framework.OutputSpec{
			DefaultMode: cliservice.OutputModeTable,
			DefaultView: framework.ViewSummary,
			JSON:        true,
			Table: &framework.TableOutputSpec{
				Columns: sessionColumns,
				Rows: func(result any) []map[string]any {
					return sessionRows(result.([]agentservice.Session))
				},
			},
			JSONViews: map[framework.OutputView]func(any) map[string]any{
				framework.ViewSummary: func(result any) map[string]any {
					return map[string]any{"sessions": sessionSummaryValues(result.([]agentservice.Session))}
				},
			},
			ListCompact: true,
		},
		Run: p.runSessions,
	})
}

func (p Provider) runSessions(ctx context.Context, invoke framework.InvokeContext, _ struct{}) (any, error) {
	if err := p.requireSessions(); err != nil {
		return nil, err
	}
	return p.sessions.List(ctx, invoke.WorkspaceID)
}

func (p Provider) newSessionSummaryCommand() cliservice.Command {
	return framework.Register(framework.CommandSpec[sessionSummaryInput]{
		ID:          appID + ".agent.session-summary",
		Path:        []string{"agent", "session-summary"},
		Summary:     "Get agent session summary",
		Description: "Get compact session context and recent messages for agent-session mentions.",
		Kind:        framework.KindAction,
		Workspace:   framework.WorkspaceRequired,
		Workspaces:  p.workspaces,
		Inputs:      framework.FromStruct[sessionSummaryInput](),
		Output: framework.OutputSpec{
			DefaultMode: cliservice.OutputModeJSON,
			DefaultView: framework.ViewSummary,
			JSON:        true,
			JSONViews:   map[framework.OutputView]func(any) map[string]any{framework.ViewSummary: sessionSummaryJSONValue},
		},
		Run: p.runSessionSummary,
	})
}

func (p Provider) newWaitCommand() cliservice.Command {
	return framework.Register(framework.CommandSpec[waitInput]{
		ID:          appID + ".agent.wait",
		Path:        []string{"agent", "wait"},
		Summary:     "Wait for an agent session stop point",
		Description: "Block until the session reaches a stop point and return its final answer or pending interactions inline.",
		Kind:        framework.KindAction,
		Workspace:   framework.WorkspaceRequired,
		Workspaces:  p.workspaces,
		Inputs:      framework.FromStruct[waitInput](),
		Output: framework.OutputSpec{
			DefaultMode: cliservice.OutputModeJSON,
			DefaultView: framework.ViewSummary,
			JSON:        true,
			JSONViews:   map[framework.OutputView]func(any) map[string]any{framework.ViewSummary: waitJSONValue},
		},
		Run: p.runWait,
	})
}

func (p Provider) newTurnResourcesCommand() cliservice.Command {
	return framework.Register(framework.CommandSpec[turnResourcesInput]{
		ID:          appID + ".agent.turn-resources",
		Path:        []string{"agent", "turn-resources"},
		Summary:     "Get agent turn resources",
		Description: "Get image resources from a specific agent session turn. JSON output keeps images grouped by source user message.",
		Kind:        framework.KindAction,
		Workspace:   framework.WorkspaceRequired,
		Workspaces:  p.workspaces,
		Inputs:      framework.FromStruct[turnResourcesInput](),
		Output: framework.OutputSpec{
			DefaultMode: cliservice.OutputModeJSON,
			DefaultView: framework.ViewSummary,
			JSON:        true,
			JSONViews:   map[framework.OutputView]func(any) map[string]any{framework.ViewSummary: turnResourcesJSONValue},
		},
		Run: p.runTurnResources,
	})
}

func (p Provider) runSessionSummary(ctx context.Context, invoke framework.InvokeContext, input sessionSummaryInput) (any, error) {
	if err := p.requireSessions(); err != nil {
		return nil, err
	}
	order, err := normalizeSessionSummaryOrder(input.Order)
	if err != nil {
		return nil, err
	}
	page, err := p.sessions.ListMessages(ctx, invoke.WorkspaceID, input.SessionID, agentservice.ListMessagesInput{
		AfterVersion:  uint64(input.AfterVersion),
		BeforeVersion: uint64(input.BeforeVersion),
		Limit:         input.Limit,
		Order:         order,
	})
	if err != nil {
		return nil, err
	}
	session, err := p.sessions.Get(ctx, invoke.WorkspaceID, input.SessionID)
	if err != nil {
		return nil, err
	}
	return sessionSummaryResult{
		ImageLocalPath: p.imageLocalPathResolver(ctx, invoke.WorkspaceID),
		Page:           page,
		Session:        session,
	}, nil
}

func (p Provider) runWait(ctx context.Context, invoke framework.InvokeContext, input waitInput) (any, error) {
	if err := p.requireSessions(); err != nil {
		return nil, err
	}
	timeout := time.Duration(input.TimeoutMS) * time.Millisecond
	if input.TimeoutMS == 0 {
		timeout = 5 * time.Minute
	}
	var afterVersion *uint64
	if input.AfterVersion != nil {
		value := uint64(*input.AfterVersion)
		afterVersion = &value
	}
	result, err := p.sessions.Wait(ctx, agentservice.WaitInput{
		WorkspaceID:    invoke.WorkspaceID,
		AgentSessionID: input.SessionID,
		AfterVersion:   afterVersion,
		Timeout:        timeout,
		SkipMessages:   true,
	})
	if err != nil {
		return nil, err
	}
	return waitCommandResult{Result: result}, nil
}

func (p Provider) runTurnResources(ctx context.Context, invoke framework.InvokeContext, input turnResourcesInput) (any, error) {
	if err := p.requireSessions(); err != nil {
		return nil, err
	}
	turnID := strings.TrimSpace(input.TurnID)
	if turnID == "" {
		return nil, fmt.Errorf("%w: turn-id is required", cliservice.ErrInvalidInput)
	}
	page, err := p.sessions.ListMessages(ctx, invoke.WorkspaceID, input.SessionID, agentservice.ListMessagesInput{
		TurnID: turnID,
		Limit:  input.Limit,
		Order:  agentactivitybiz.MessageOrderAsc,
	})
	if err != nil {
		return nil, err
	}
	return turnResourcesResult{
		ImageLocalPath: p.imageLocalPathResolver(ctx, invoke.WorkspaceID),
		Page:           page,
		TurnID:         turnID,
	}, nil
}

func (p Provider) imageLocalPathResolver(ctx context.Context, workspaceID string) imageLocalPathResolver {
	return func(agentSessionID string, attachmentID string, mimeType string) (string, bool) {
		path, err := p.sessions.LocalAttachmentPath(ctx, workspaceID, agentSessionID, attachmentID, mimeType)
		return path, err == nil && strings.TrimSpace(path) != ""
	}
}

func sessionSummaryJSONValue(result any) map[string]any {
	summary := result.(sessionSummaryResult)
	return map[string]any{
		"agentSessionId": summary.Page.AgentSessionID,
		"session":        sessionInspectValue(summary.Session),
		"messages":       messageCompactValues(summary.Page.Messages, summary.ImageLocalPath),
		"latestVersion":  summary.Page.LatestVersion,
		"hasMore":        summary.Page.HasMore,
	}
}

func turnResourcesJSONValue(result any) map[string]any {
	resources := result.(turnResourcesResult)
	return map[string]any{
		"agentSessionId": resources.Page.AgentSessionID,
		"turnId":         resources.TurnID,
		"messages":       turnResourceMessageValues(resources.Page.Messages, resources.ImageLocalPath),
		"latestVersion":  resources.Page.LatestVersion,
		"hasMore":        resources.Page.HasMore,
	}
}

func waitJSONValue(result any) map[string]any {
	waited := result.(waitCommandResult)
	value := map[string]any{
		"agentSessionId": waited.Result.Session.ID,
		"session":        sessionSummaryValue(waited.Result.Session),
		"latestVersion":  waited.Result.LatestVersion,
		"effectiveAfter": waited.Result.EffectiveAfter,
		"timedOut":       waited.Result.TimedOut,
		"reason":         string(waited.Result.Reason),
	}
	if (waited.Result.Reason == agentservice.WaitReasonCompleted || waited.Result.Reason == agentservice.WaitReasonFailed) && waited.Result.FinalMessage != nil {
		value["finalMessage"] = map[string]any{
			"turnId": waited.Result.FinalMessage.TurnID,
			"text":   waited.Result.FinalMessage.Text,
		}
	}
	if waited.Result.Reason == agentservice.WaitReasonWaitingApproval || waited.Result.Reason == agentservice.WaitReasonWaitingInput {
		value["interactions"] = waitInteractionValues(waited.Result.Interactions)
	}
	return value
}

func waitInteractionValues(interactions []agentservice.WaitInteraction) []any {
	values := make([]any, 0, len(interactions))
	for _, interaction := range interactions {
		actions := make([]any, 0, len(interaction.Actions))
		for _, action := range interaction.Actions {
			actions = append(actions, map[string]any{
				"id": action.ID, "label": action.Label, "semantic": action.Semantic,
			})
		}
		values = append(values, map[string]any{
			"requestId": interaction.RequestID, "turnId": interaction.TurnID,
			"kind": interaction.Kind, "toolName": interaction.ToolName, "actions": actions,
			"input": map[string]any{"summary": interaction.InputSummary, "truncated": interaction.InputTruncated},
		})
	}
	return values
}

func turnResourceMessageValues(messages []agentservice.SessionMessage, imageLocalPath imageLocalPathResolver) []any {
	values := make([]any, 0, len(messages))
	for _, message := range messages {
		if strings.TrimSpace(message.Role) != "user" {
			continue
		}
		value := messageCompactValue(message, imageLocalPath)
		images, ok := value["images"].([]any)
		if !ok || len(images) == 0 {
			continue
		}
		values = append(values, value)
	}
	return values
}

func normalizeSessionSummaryOrder(value string) (agentactivitybiz.MessageOrder, error) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "", string(agentactivitybiz.MessageOrderAsc):
		return agentactivitybiz.MessageOrderAsc, nil
	case string(agentactivitybiz.MessageOrderDesc):
		return agentactivitybiz.MessageOrderDesc, nil
	default:
		return "", fmt.Errorf("%w: order must be asc or desc", cliservice.ErrInvalidInput)
	}
}

func sessionRows(sessions []agentservice.Session) []map[string]any {
	rows := make([]map[string]any, 0, len(sessions))
	for _, session := range sessions {
		title := ""
		if session.Title != nil {
			title = *session.Title
		}
		latestTurnPhase := ""
		latestTurnOutcome := ""
		if session.LatestTurn != nil {
			latestTurnPhase = session.LatestTurn.Phase
			latestTurnOutcome = session.LatestTurn.Outcome
		}
		rows = append(rows, map[string]any{
			"id":                session.ID,
			"provider":          session.Provider,
			"activeTurnId":      strings.TrimSpace(session.ActiveTurnID),
			"latestTurnPhase":   latestTurnPhase,
			"latestTurnOutcome": latestTurnOutcome,
			"title":             strings.TrimSpace(title),
		})
	}
	return rows
}
