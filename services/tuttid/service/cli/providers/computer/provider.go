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

func (p Provider) workspaceID(ctx context.Context, request cliservice.InvokeRequest) (string, error) {
	return cliservice.ResolveWorkspaceID(ctx, p.workspaces, request.Context.WorkspaceID)
}

// call resolves the workspace, invokes the mapped cua-driver tool, and returns
// the tool's text as plain CLI output.
func (p Provider) call(ctx context.Context, request cliservice.InvokeRequest, tool string, args map[string]any) (cliservice.CommandOutput, error) {
	if p.computer == nil {
		return cliservice.CommandOutput{}, errComputerUnavailable
	}
	workspaceID, err := p.workspaceID(ctx, request)
	if err != nil {
		return cliservice.CommandOutput{}, err
	}
	result, err := p.computer.CallTool(ctx, workspaceID, "", tool, args)
	if err != nil {
		return cliservice.CommandOutput{}, err
	}
	return cliservice.CommandOutput{Kind: cliservice.OutputModePlain, Text: result.Text}, nil
}

// callWithResult resolves the workspace and invokes the tool, returning the
// full ToolResult for commands that need image data (e.g. screenshot).
func (p Provider) callWithResult(ctx context.Context, request cliservice.InvokeRequest, tool string, args map[string]any) (computersvc.ToolResult, error) {
	if p.computer == nil {
		return computersvc.ToolResult{}, errComputerUnavailable
	}
	workspaceID, err := p.workspaceID(ctx, request)
	if err != nil {
		return computersvc.ToolResult{}, err
	}
	return p.computer.CallTool(ctx, workspaceID, "", tool, args)
}
