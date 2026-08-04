// Package browser exposes the daemon-owned browser session to agents as
// `tutti browser ...` CLI commands. Agents drive a browser through these
// pre-approved commands instead of a per-provider MCP server.
package browser

import (
	"context"
	"errors"
	"strings"

	browsersvc "github.com/tutti-os/tutti/services/tuttid/service/browser"
	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
	"github.com/tutti-os/tutti/services/tuttid/service/cli/framework"
)

const appID = "browser"

var errBrowserUnavailable = errors.New("browser service is unavailable")

// BrowserService is the subset of the daemon browser service the CLI needs.
type BrowserService interface {
	CallToolForAgent(ctx context.Context, workspaceID, cwd, agentSessionID, agentTurnID, tool string, args map[string]any) (browsersvc.ToolResult, error)
}

type AgentTurnReader interface {
	PersistedActiveTurnID(ctx context.Context, workspaceID, agentSessionID string) (string, error)
}

type Provider struct {
	workspaces cliservice.WorkspaceCatalog
	browser    BrowserService
	agentTurns AgentTurnReader
}

func NewProvider(workspaces cliservice.WorkspaceCatalog, browser BrowserService, agentTurns ...AgentTurnReader) Provider {
	var turnReader AgentTurnReader
	if len(agentTurns) > 0 {
		turnReader = agentTurns[0]
	}
	return Provider{workspaces: workspaces, browser: browser, agentTurns: turnReader}
}

func (Provider) AppID() string { return appID }

func (p Provider) Commands() []cliservice.Command {
	return []cliservice.Command{
		p.newNavigateCommand(),
		p.newSnapshotCommand(),
		p.newScreenshotCommand(),
		p.newClickCommand(),
		p.newFillCommand(),
		p.newEvalCommand(),
		p.newListPagesCommand(),
		p.newOpenCommand(),
		p.newPageCommand(),
		p.newSelectPageCommand(),
		p.newClosePageCommand(),
	}
}

// call invokes the mapped chrome-devtools-mcp tool and returns its text. The
// browser service surfaces
// tool errors (e.g. "Chrome not installed", "browser MCP failed to start") as
// Go errors, which the CLI renders to the agent.
func (p Provider) call(ctx context.Context, invoke framework.InvokeContext, tool string, args map[string]any) (string, error) {
	if p.browser == nil {
		return "", errBrowserUnavailable
	}
	agentSessionID := strings.TrimSpace(invoke.Request.Context.AgentSessionID)
	agentTurnID := ""
	if tool == "new_page" && agentSessionID != "" && p.agentTurns != nil {
		resolvedTurnID, err := p.agentTurns.PersistedActiveTurnID(
			ctx,
			invoke.WorkspaceID,
			agentSessionID,
		)
		if err == nil {
			agentTurnID = strings.TrimSpace(resolvedTurnID)
		}
	}
	result, err := p.browser.CallToolForAgent(
		ctx,
		invoke.WorkspaceID,
		"",
		agentSessionID,
		agentTurnID,
		tool,
		args,
	)
	if err != nil {
		return "", err
	}
	return result.Text, nil
}
