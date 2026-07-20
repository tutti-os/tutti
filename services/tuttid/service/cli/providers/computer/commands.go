package computer

import (
	"context"
	"fmt"

	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
	"github.com/tutti-os/tutti/services/tuttid/service/cli/framework"
	computersvc "github.com/tutti-os/tutti/services/tuttid/service/computer"
)

type coordinatesInput struct {
	X        int `cli:"x" validate:"required" description:"X coordinate in screenshot pixels."`
	Y        int `cli:"y" validate:"required" description:"Y coordinate in screenshot pixels."`
	PID      int `cli:"pid" validate:"min=1" description:"Target process ID; defaults to the selected visible window."`
	WindowID int `cli:"window-id" validate:"min=1" description:"Target window ID; defaults to the selected visible window."`
}

type cursorCoordinatesInput struct {
	X int `cli:"x" validate:"required" description:"X coordinate in screen points."`
	Y int `cli:"y" validate:"required" description:"Y coordinate in screen points."`
}

type screenshotInput struct {
	PID      int `cli:"pid" validate:"min=1" description:"Target process ID; defaults to the selected visible window."`
	WindowID int `cli:"window-id" validate:"min=1" description:"Target window ID; defaults to the selected visible window."`
}

type typeInput struct {
	Text     string `cli:"text" validate:"required"`
	PID      int    `cli:"pid" validate:"min=1" description:"Target process ID; defaults to the selected visible window."`
	WindowID int    `cli:"window-id" validate:"min=1" description:"Target window ID; defaults to the selected visible window."`
}

type pressKeyInput struct {
	Key      string `cli:"key" validate:"required"`
	PID      int    `cli:"pid" validate:"min=1" description:"Target process ID; defaults to the selected visible window."`
	WindowID int    `cli:"window-id" validate:"min=1" description:"Target window ID; defaults to the selected visible window."`
}

type scrollInput struct {
	X         int    `cli:"x" validate:"required" description:"X coordinate in screenshot pixels."`
	Y         int    `cli:"y" validate:"required" description:"Y coordinate in screenshot pixels."`
	Direction string `cli:"direction" validate:"required" enum:"up,down,left,right"`
	Amount    int    `cli:"amount" validate:"min=1,max=50"`
	PID       int    `cli:"pid" validate:"min=1" description:"Target process ID; defaults to the selected visible window."`
	WindowID  int    `cli:"window-id" validate:"min=1" description:"Target window ID; defaults to the selected visible window."`
}

func plainOutputSpec() framework.OutputSpec {
	return framework.OutputSpec{
		DefaultMode: cliservice.OutputModePlain,
		DefaultView: framework.ViewSummary,
		JSON:        true,
		PlainText: func(result any) string {
			return result.(computersvc.ToolResult).Text
		},
		JSONViews: map[framework.OutputView]func(any) map[string]any{
			framework.ViewSummary: func(result any) map[string]any {
				return plainToolResultJSON(result.(computersvc.ToolResult))
			},
		},
	}
}

func plainToolResultJSON(toolResult computersvc.ToolResult) map[string]any {
	output := map[string]any{"text": toolResult.Text}
	if len(toolResult.StructuredContent) > 0 {
		output["structuredContent"] = toolResult.StructuredContent
	}
	if len(toolResult.Images) > 0 {
		images := make([]map[string]any, 0, len(toolResult.Images))
		for _, image := range toolResult.Images {
			images = append(images, map[string]any{"mimeType": image.MimeType})
		}
		output["images"] = images
	}
	return output
}

func (p Provider) newScreenshotCommand() cliservice.Command {
	return framework.Register(framework.CommandSpec[screenshotInput]{
		ID:          "computer.screenshot",
		Path:        []string{"computer", "screenshot"},
		Summary:     "Take a screenshot of a macOS window",
		Description: "Capture the selected visible window, save it as a PNG file, and return its path.",
		Kind:        framework.KindAction,
		Workspace:   framework.WorkspaceRequired,
		Workspaces:  p.workspaces,
		Inputs:      framework.FromStruct[screenshotInput](),
		Output:      plainOutputSpec(),
		Run: func(ctx context.Context, invoke framework.InvokeContext, input screenshotInput) (any, error) {
			args, err := targetArgs(input.PID, input.WindowID)
			if err != nil {
				return nil, err
			}
			return p.call(ctx, invoke.WorkspaceID, "screenshot", args)
		},
	})
}

func (p Provider) newClickCommand() cliservice.Command {
	return p.coordinatesCommand("computer.click", []string{"computer", "click"}, "Left-click at window coordinates", "Left-click at the given (x, y) coordinates from a window screenshot.", map[string]any{})
}

func (p Provider) newDoubleClickCommand() cliservice.Command {
	return p.coordinatesCommand("computer.double-click", []string{"computer", "double-click"}, "Double-click at window coordinates", "Double-click at the given (x, y) coordinates from a window screenshot.", map[string]any{"count": 2})
}

func (p Provider) newRightClickCommand() cliservice.Command {
	return p.coordinatesCommand("computer.right-click", []string{"computer", "right-click"}, "Right-click at window coordinates", "Right-click at the given (x, y) coordinates from a window screenshot.", map[string]any{"button": "right"})
}

func (p Provider) newMoveCursorCommand() cliservice.Command {
	return framework.Register(framework.CommandSpec[cursorCoordinatesInput]{
		ID:          "computer.move-cursor",
		Path:        []string{"computer", "move-cursor"},
		Summary:     "Move the agent cursor without clicking",
		Description: "Move the visible agent cursor to the given (x, y) screen coordinates without clicking.",
		Kind:        framework.KindAction,
		Workspace:   framework.WorkspaceRequired,
		Workspaces:  p.workspaces,
		Inputs:      framework.FromStruct[cursorCoordinatesInput](),
		Output:      plainOutputSpec(),
		Run: func(ctx context.Context, invoke framework.InvokeContext, input cursorCoordinatesInput) (any, error) {
			return p.call(ctx, invoke.WorkspaceID, "move_cursor", map[string]any{"x": input.X, "y": input.Y})
		},
	})
}

func (p Provider) coordinatesCommand(id string, path []string, summary string, description string, actionArgs map[string]any) cliservice.Command {
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
			args, err := targetArgs(input.PID, input.WindowID)
			if err != nil {
				return nil, err
			}
			args["x"] = input.X
			args["y"] = input.Y
			for key, value := range actionArgs {
				args[key] = value
			}
			return p.call(ctx, invoke.WorkspaceID, "click", args)
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
			args, err := targetArgs(input.PID, input.WindowID)
			if err != nil {
				return nil, err
			}
			args["text"] = input.Text
			return p.call(ctx, invoke.WorkspaceID, "type_text", args)
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
			args, err := targetArgs(input.PID, input.WindowID)
			if err != nil {
				return nil, err
			}
			args["key"] = input.Key
			return p.call(ctx, invoke.WorkspaceID, "press_key", args)
		},
	})
}

func (p Provider) newScrollCommand() cliservice.Command {
	return framework.Register(framework.CommandSpec[scrollInput]{
		ID:          "computer.scroll",
		Path:        []string{"computer", "scroll"},
		Summary:     "Scroll the selected window",
		Description: "Scroll the selected window in the given direction; coordinates identify the source window screenshot.",
		Kind:        framework.KindAction,
		Workspace:   framework.WorkspaceRequired,
		Workspaces:  p.workspaces,
		Inputs:      framework.FromStruct[scrollInput](),
		Output:      plainOutputSpec(),
		Run:         p.runScroll,
	})
}

func (p Provider) runScroll(ctx context.Context, invoke framework.InvokeContext, input scrollInput) (any, error) {
	args, err := targetArgs(input.PID, input.WindowID)
	if err != nil {
		return nil, err
	}
	args["x"] = input.X
	args["y"] = input.Y
	args["direction"] = input.Direction
	if input.Amount != 0 {
		args["amount"] = input.Amount
	}
	return p.call(ctx, invoke.WorkspaceID, "scroll", args)
}

func targetArgs(pid, windowID int) (map[string]any, error) {
	if (pid == 0) != (windowID == 0) {
		return nil, fmt.Errorf("%w: pid and window-id must be provided together", cliservice.ErrInvalidInput)
	}
	args := map[string]any{}
	if pid != 0 {
		args["pid"] = pid
		args["window_id"] = windowID
	}
	return args, nil
}
