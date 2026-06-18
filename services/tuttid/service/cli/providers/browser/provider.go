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

// call invokes the mapped chrome-devtools-mcp tool and returns its text. The
// browser service surfaces
// tool errors (e.g. "Chrome not installed", "browser MCP failed to start") as
// Go errors, which the CLI renders to the agent.
func (p Provider) call(ctx context.Context, workspaceID string, tool string, args map[string]any) (string, error) {
	if p.browser == nil {
		return "", errBrowserUnavailable
	}
	result, err := p.browser.CallTool(ctx, workspaceID, "", tool, args)
	if err != nil {
		return "", err
	}
	return result.Text, nil
}
