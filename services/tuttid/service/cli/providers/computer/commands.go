package computer

import (
	"context"

	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
	"github.com/tutti-os/tutti/services/tuttid/service/cli/framework"
)

type coordinatesInput struct {
	X string `cli:"x" validate:"required"`
	Y string `cli:"y" validate:"required"`
}

type typeInput struct {
	Text string `cli:"text" validate:"required"`
}

type pressKeyInput struct {
	Key string `cli:"key" validate:"required"`
}

type scrollInput struct {
	X         string `cli:"x" validate:"required"`
	Y         string `cli:"y" validate:"required"`
	Direction string `cli:"direction" validate:"required"`
	Amount    string `cli:"amount"`
}

func plainOutputSpec() framework.OutputSpec {
	return framework.OutputSpec{
		DefaultMode: cliservice.OutputModePlain,
		PlainText: func(result any) string {
			return result.(string)
		},
	}
}

func (p Provider) newScreenshotCommand() cliservice.Command {
	return framework.Register(framework.CommandSpec[struct{}]{
		ID:          "computer.screenshot",
		Path:        []string{"computer", "screenshot"},
		Summary:     "Take a screenshot of the macOS desktop",
		Description: "Capture the current screen, save it as a PNG file, and return its path.",
		Kind:        framework.KindAction,
		Workspace:   framework.WorkspaceRequired,
		Workspaces:  p.workspaces,
		Inputs:      framework.FromStruct[struct{}](),
		Output:      plainOutputSpec(),
		Run: func(ctx context.Context, invoke framework.InvokeContext, _ struct{}) (any, error) {
			return p.call(ctx, invoke.WorkspaceID, "screenshot", map[string]any{})
		},
	})
}

func (p Provider) newClickCommand() cliservice.Command {
	return p.coordinatesCommand("computer.click", []string{"computer", "click"}, "Left-click at screen coordinates", "Left-click at the given (x, y) screen coordinates.", "left_click")
}

func (p Provider) newDoubleClickCommand() cliservice.Command {
	return p.coordinatesCommand("computer.double-click", []string{"computer", "double-click"}, "Double-click at screen coordinates", "Double-click at the given (x, y) screen coordinates.", "double_click")
}

func (p Provider) newRightClickCommand() cliservice.Command {
	return p.coordinatesCommand("computer.right-click", []string{"computer", "right-click"}, "Right-click at screen coordinates", "Right-click at the given (x, y) screen coordinates.", "right_click")
}

func (p Provider) newMoveCursorCommand() cliservice.Command {
	return p.coordinatesCommand("computer.move-cursor", []string{"computer", "move-cursor"}, "Move the cursor without clicking", "Move the mouse cursor to the given (x, y) screen coordinates without clicking.", "move_cursor")
}

func (p Provider) coordinatesCommand(id string, path []string, summary string, description string, tool string) cliservice.Command {
	return framework.Register(framework.CommandSpec[coordinatesInput]{
		ID:          id,
		Path:        path,
		Summary:     summary,
		Description: description,
		Kind:        framework.KindAction,
		Workspace:   framework.WorkspaceRequired,
		Workspaces:  p.workspaces,
		Inputs:      framework.FromStruct[coordinatesInput](),
		Output:      plainOutputSpec(),
		Run: func(ctx context.Context, invoke framework.InvokeContext, input coordinatesInput) (any, error) {
			return p.call(ctx, invoke.WorkspaceID, tool, map[string]any{"x": input.X, "y": input.Y})
		},
	})
}

func (p Provider) newTypeCommand() cliservice.Command {
	return framework.Register(framework.CommandSpec[typeInput]{
		ID:          "computer.type",
		Path:        []string{"computer", "type"},
		Summary:     "Type text",
		Description: "Type a string of characters at the current cursor position.",
		Kind:        framework.KindAction,
		Workspace:   framework.WorkspaceRequired,
		Workspaces:  p.workspaces,
		Inputs:      framework.FromStruct[typeInput](),
		Output:      plainOutputSpec(),
		Run: func(ctx context.Context, invoke framework.InvokeContext, input typeInput) (any, error) {
			return p.call(ctx, invoke.WorkspaceID, "type_text", map[string]any{"text": input.Text})
		},
	})
}

func (p Provider) newPressKeyCommand() cliservice.Command {
	return framework.Register(framework.CommandSpec[pressKeyInput]{
		ID:          "computer.press-key",
		Path:        []string{"computer", "press-key"},
		Summary:     "Press a key or keyboard shortcut",
		Description: "Press a key or shortcut, e.g. \"cmd+c\", \"return\", \"escape\".",
		Kind:        framework.KindAction,
		Workspace:   framework.WorkspaceRequired,
		Workspaces:  p.workspaces,
		Inputs:      framework.FromStruct[pressKeyInput](),
		Output:      plainOutputSpec(),
		Run: func(ctx context.Context, invoke framework.InvokeContext, input pressKeyInput) (any, error) {
			return p.call(ctx, invoke.WorkspaceID, "press_key", map[string]any{"key": input.Key})
		},
	})
}

func (p Provider) newScrollCommand() cliservice.Command {
	return framework.Register(framework.CommandSpec[scrollInput]{
		ID:          "computer.scroll",
		Path:        []string{"computer", "scroll"},
		Summary:     "Scroll at screen coordinates",
		Description: "Scroll at the given (x, y) coordinates in the given direction.",
		Kind:        framework.KindAction,
		Workspace:   framework.WorkspaceRequired,
		Workspaces:  p.workspaces,
		Inputs:      framework.FromStruct[scrollInput](),
		Output:      plainOutputSpec(),
		Run:         p.runScroll,
	})
}

func (p Provider) runScroll(ctx context.Context, invoke framework.InvokeContext, input scrollInput) (any, error) {
	args := map[string]any{"x": input.X, "y": input.Y, "direction": input.Direction}
	if input.Amount != "" {
		args["amount"] = input.Amount
	}
	return p.call(ctx, invoke.WorkspaceID, "scroll", args)
}
