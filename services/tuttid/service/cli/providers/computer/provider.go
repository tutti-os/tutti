// Package computer exposes the daemon-owned computer session to agents as
// `tutti computer ...` CLI commands. Agents automate the macOS desktop through
// these pre-approved commands instead of a per-provider MCP server.
package computer

import (
	"context"
	"errors"

	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
	computersvc "github.com/tutti-os/tutti/services/tuttid/service/computer"
)

const appID = "computer"

var errComputerUnavailable = errors.New("computer service is unavailable")

// ComputerService is the subset of the daemon computer service the CLI needs.
type ComputerService interface {
	CallTool(ctx context.Context, workspaceID, cwd, tool string, args map[string]any) (computersvc.ToolResult, error)
}

type Provider struct {
	workspaces cliservice.WorkspaceCatalog
	computer   ComputerService
}

func NewProvider(workspaces cliservice.WorkspaceCatalog, computer ComputerService) Provider {
	return Provider{workspaces: workspaces, computer: computer}
}

func (Provider) AppID() string { return appID }

func (p Provider) Commands() []cliservice.Command {
	return []cliservice.Command{
		p.newScreenshotCommand(),
		p.newClickCommand(),
		p.newDoubleClickCommand(),
		p.newRightClickCommand(),
		p.newTypeCommand(),
		p.newPressKeyCommand(),
		p.newScrollCommand(),
		p.newMoveCursorCommand(),
	}
}

// call invokes the mapped cua-driver tool and returns the tool's text.
func (p Provider) call(ctx context.Context, workspaceID string, tool string, args map[string]any) (string, error) {
	if p.computer == nil {
		return "", errComputerUnavailable
	}
	result, err := p.computer.CallTool(ctx, workspaceID, "", tool, args)
	if err != nil {
		return "", err
	}
	return result.Text, nil
}
