// Package browser exposes the daemon-owned browser session to agents as
// `tutti browser ...` CLI commands. Agents drive a browser through these
// pre-approved commands instead of a per-provider MCP server.
package browser

import (
	"context"
	"errors"

	browsersvc "github.com/tutti-os/tutti/services/tuttid/service/browser"
	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
)

const appID = "browser"

var errBrowserUnavailable = errors.New("browser service is unavailable")

// BrowserService is the subset of the daemon browser service the CLI needs.
type BrowserService interface {
	CallTool(ctx context.Context, workspaceID, cwd, tool string, args map[string]any) (browsersvc.ToolResult, error)
}

type Provider struct {
	workspaces cliservice.WorkspaceCatalog
	browser    BrowserService
}

func NewProvider(workspaces cliservice.WorkspaceCatalog, browser BrowserService) Provider {
	return Provider{workspaces: workspaces, browser: browser}
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
	}
}

func (p Provider) workspaceID(ctx context.Context, request cliservice.InvokeRequest) (string, error) {
	return cliservice.ResolveWorkspaceID(ctx, p.workspaces, request.Context.WorkspaceID)
}

// call resolves the workspace, invokes the mapped chrome-devtools-mcp tool, and
// returns the tool's text as plain CLI output. The browser service surfaces
// tool errors (e.g. "Chrome not installed", "browser MCP failed to start") as
// Go errors, which the CLI renders to the agent.
func (p Provider) call(ctx context.Context, request cliservice.InvokeRequest, tool string, args map[string]any) (cliservice.CommandOutput, error) {
	if p.browser == nil {
		return cliservice.CommandOutput{}, errBrowserUnavailable
	}
	workspaceID, err := p.workspaceID(ctx, request)
	if err != nil {
		return cliservice.CommandOutput{}, err
	}
	result, err := p.browser.CallTool(ctx, workspaceID, "", tool, args)
	if err != nil {
		return cliservice.CommandOutput{}, err
	}
	return cliservice.CommandOutput{Kind: cliservice.OutputModePlain, Text: result.Text}, nil
}
