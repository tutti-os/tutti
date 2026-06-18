package agentcontext

import (
	"context"
	"strings"

	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
	"github.com/tutti-os/tutti/services/tuttid/service/cli/framework"
)

var sessionColumns = []cliservice.TableColumn{
	{Key: "id", Label: "ID"},
	{Key: "provider", Label: "Provider"},
	{Key: "status", Label: "Status"},
	{Key: "title", Label: "Title"},
}

type sessionSummaryInput struct {
	SessionID    string `cli:"session-id" validate:"required" description:"Agent session id to inspect."`
	Limit        int    `cli:"limit" validate:"min=0" description:"Maximum number of recent messages to return."`
	AfterVersion int64  `cli:"after-version" validate:"min=0" description:"Return messages after this message version."`
}

type sessionSummaryResult struct {
	Page    agentservice.SessionMessagesPage
	Session agentservice.Session
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

func (p Provider) runSessionSummary(ctx context.Context, invoke framework.InvokeContext, input sessionSummaryInput) (any, error) {
	if err := p.requireSessions(); err != nil {
		return nil, err
	}
	page, err := p.sessions.ListMessages(ctx, invoke.WorkspaceID, input.SessionID, agentservice.ListMessagesInput{
		AfterVersion: uint64(input.AfterVersion),
		Limit:        input.Limit,
	})
	if err != nil {
		return nil, err
	}
	session, err := p.sessions.Get(ctx, invoke.WorkspaceID, input.SessionID)
	if err != nil {
		return nil, err
	}
	return sessionSummaryResult{Page: page, Session: session}, nil
}

func sessionSummaryJSONValue(result any) map[string]any {
	summary := result.(sessionSummaryResult)
	return map[string]any{
		"agentSessionId": summary.Page.AgentSessionID,
		"session":        sessionInspectValue(summary.Session),
		"messages":       messageCompactValues(summary.Page.Messages),
		"latestVersion":  summary.Page.LatestVersion,
		"hasMore":        summary.Page.HasMore,
	}
}

func sessionRows(sessions []agentservice.Session) []map[string]any {
	rows := make([]map[string]any, 0, len(sessions))
	for _, session := range sessions {
		title := ""
		if session.Title != nil {
			title = *session.Title
		}
		rows = append(rows, map[string]any{
			"id":       session.ID,
			"provider": session.Provider,
			"status":   session.Status,
			"title":    strings.TrimSpace(title),
		})
	}
	return rows
}
