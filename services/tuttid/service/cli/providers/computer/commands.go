package computer

import (
	"context"
	"encoding/base64"
	"fmt"
	"os"

	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
)

func textOutput() cliservice.CapabilityOutput {
	return cliservice.CapabilityOutput{DefaultMode: cliservice.OutputModePlain}
}

func (p Provider) newScreenshotCommand() cliservice.Command {
	return cliservice.Command{
		Capability: cliservice.Capability{
			ID:          "computer.screenshot",
			Path:        []string{"computer", "screenshot"},
			Summary:     "Take a screenshot of the macOS desktop",
			Description: "Capture the current screen, save it as a PNG file, and return its path.",
			Output:      textOutput(),
		},
		Handler: func(ctx context.Context, request cliservice.InvokeRequest) (cliservice.CommandOutput, error) {
			file, err := os.CreateTemp("", "tutti-computer-*.png")
			if err != nil {
				return cliservice.CommandOutput{}, err
			}
			path := file.Name()
			_ = file.Close()
			result, err := p.callWithResult(ctx, request, "screenshot", map[string]any{})
			if err != nil {
				return cliservice.CommandOutput{}, err
			}
			if len(result.Images) > 0 {
				data, err := base64.StdEncoding.DecodeString(result.Images[0].Data)
				if err != nil {
					return cliservice.CommandOutput{}, fmt.Errorf("decode screenshot: %w", err)
				}
				if err := os.WriteFile(path, data, 0o644); err != nil {
					return cliservice.CommandOutput{}, fmt.Errorf("write screenshot: %w", err)
				}
			}
			return cliservice.CommandOutput{Kind: cliservice.OutputModePlain, Text: fmt.Sprintf("Screenshot saved to %s", path)}, nil
		},
	}
}

func (p Provider) newClickCommand() cliservice.Command {
	return cliservice.Command{
		Capability: cliservice.Capability{
			ID:          "computer.click",
			Path:        []string{"computer", "click"},
			Summary:     "Left-click at screen coordinates",
			Description: "Left-click at the given (x, y) screen coordinates.",
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"x": map[string]any{"type": "string"},
					"y": map[string]any{"type": "string"},
				},
				"required": []string{"x", "y"},
			},
			Output: textOutput(),
		},
		Handler: func(ctx context.Context, request cliservice.InvokeRequest) (cliservice.CommandOutput, error) {
			x, err := cliservice.RequiredStringInput(request.Input, "x")
			if err != nil {
				return cliservice.CommandOutput{}, err
			}
			y, err := cliservice.RequiredStringInput(request.Input, "y")
			if err != nil {
				return cliservice.CommandOutput{}, err
			}
			return p.call(ctx, request, "left_click", map[string]any{"x": x, "y": y})
		},
	}
}

func (p Provider) newDoubleClickCommand() cliservice.Command {
	return cliservice.Command{
		Capability: cliservice.Capability{
			ID:          "computer.double-click",
			Path:        []string{"computer", "double-click"},
			Summary:     "Double-click at screen coordinates",
			Description: "Double-click at the given (x, y) screen coordinates.",
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"x": map[string]any{"type": "string"},
					"y": map[string]any{"type": "string"},
				},
				"required": []string{"x", "y"},
			},
			Output: textOutput(),
		},
		Handler: func(ctx context.Context, request cliservice.InvokeRequest) (cliservice.CommandOutput, error) {
			x, err := cliservice.RequiredStringInput(request.Input, "x")
			if err != nil {
				return cliservice.CommandOutput{}, err
			}
			y, err := cliservice.RequiredStringInput(request.Input, "y")
			if err != nil {
				return cliservice.CommandOutput{}, err
			}
			return p.call(ctx, request, "double_click", map[string]any{"x": x, "y": y})
		},
	}
}

func (p Provider) newRightClickCommand() cliservice.Command {
	return cliservice.Command{
		Capability: cliservice.Capability{
			ID:          "computer.right-click",
			Path:        []string{"computer", "right-click"},
			Summary:     "Right-click at screen coordinates",
			Description: "Right-click at the given (x, y) screen coordinates.",
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"x": map[string]any{"type": "string"},
					"y": map[string]any{"type": "string"},
				},
				"required": []string{"x", "y"},
			},
			Output: textOutput(),
		},
		Handler: func(ctx context.Context, request cliservice.InvokeRequest) (cliservice.CommandOutput, error) {
			x, err := cliservice.RequiredStringInput(request.Input, "x")
			if err != nil {
				return cliservice.CommandOutput{}, err
			}
			y, err := cliservice.RequiredStringInput(request.Input, "y")
			if err != nil {
				return cliservice.CommandOutput{}, err
			}
			return p.call(ctx, request, "right_click", map[string]any{"x": x, "y": y})
		},
	}
}

func (p Provider) newTypeCommand() cliservice.Command {
	return cliservice.Command{
		Capability: cliservice.Capability{
			ID:          "computer.type",
			Path:        []string{"computer", "type"},
			Summary:     "Type text",
			Description: "Type a string of characters at the current cursor position.",
			InputSchema: map[string]any{
				"type":       "object",
				"properties": map[string]any{"text": map[string]any{"type": "string"}},
				"required":   []string{"text"},
			},
			Output: textOutput(),
		},
		Handler: func(ctx context.Context, request cliservice.InvokeRequest) (cliservice.CommandOutput, error) {
			text, err := cliservice.RequiredStringInput(request.Input, "text")
			if err != nil {
				return cliservice.CommandOutput{}, err
			}
			return p.call(ctx, request, "type_text", map[string]any{"text": text})
		},
	}
}

func (p Provider) newPressKeyCommand() cliservice.Command {
	return cliservice.Command{
		Capability: cliservice.Capability{
			ID:          "computer.press-key",
			Path:        []string{"computer", "press-key"},
			Summary:     "Press a key or keyboard shortcut",
			Description: "Press a key or shortcut, e.g. \"cmd+c\", \"return\", \"escape\".",
			InputSchema: map[string]any{
				"type":       "object",
				"properties": map[string]any{"key": map[string]any{"type": "string"}},
				"required":   []string{"key"},
			},
			Output: textOutput(),
		},
		Handler: func(ctx context.Context, request cliservice.InvokeRequest) (cliservice.CommandOutput, error) {
			key, err := cliservice.RequiredStringInput(request.Input, "key")
			if err != nil {
				return cliservice.CommandOutput{}, err
			}
			return p.call(ctx, request, "press_key", map[string]any{"key": key})
		},
	}
}

func (p Provider) newScrollCommand() cliservice.Command {
	return cliservice.Command{
		Capability: cliservice.Capability{
			ID:          "computer.scroll",
			Path:        []string{"computer", "scroll"},
			Summary:     "Scroll at screen coordinates",
			Description: "Scroll at the given (x, y) coordinates in the given direction.",
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"x":         map[string]any{"type": "string"},
					"y":         map[string]any{"type": "string"},
					"direction": map[string]any{"type": "string", "enum": []string{"up", "down", "left", "right"}},
					"amount":    map[string]any{"type": "string"},
				},
				"required": []string{"x", "y", "direction"},
			},
			Output: textOutput(),
		},
		Handler: func(ctx context.Context, request cliservice.InvokeRequest) (cliservice.CommandOutput, error) {
			x, err := cliservice.RequiredStringInput(request.Input, "x")
			if err != nil {
				return cliservice.CommandOutput{}, err
			}
			y, err := cliservice.RequiredStringInput(request.Input, "y")
			if err != nil {
				return cliservice.CommandOutput{}, err
			}
			direction, err := cliservice.RequiredStringInput(request.Input, "direction")
			if err != nil {
				return cliservice.CommandOutput{}, err
			}
			args := map[string]any{"x": x, "y": y, "direction": direction}
			if amount, _, _ := cliservice.StringInput(request.Input, "amount"); amount != "" {
				args["amount"] = amount
			}
			return p.call(ctx, request, "scroll", args)
		},
	}
}

func (p Provider) newMoveCursorCommand() cliservice.Command {
	return cliservice.Command{
		Capability: cliservice.Capability{
			ID:          "computer.move-cursor",
			Path:        []string{"computer", "move-cursor"},
			Summary:     "Move the cursor without clicking",
			Description: "Move the mouse cursor to the given (x, y) screen coordinates without clicking.",
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"x": map[string]any{"type": "string"},
					"y": map[string]any{"type": "string"},
				},
				"required": []string{"x", "y"},
			},
			Output: textOutput(),
		},
		Handler: func(ctx context.Context, request cliservice.InvokeRequest) (cliservice.CommandOutput, error) {
			x, err := cliservice.RequiredStringInput(request.Input, "x")
			if err != nil {
				return cliservice.CommandOutput{}, err
			}
			y, err := cliservice.RequiredStringInput(request.Input, "y")
			if err != nil {
				return cliservice.CommandOutput{}, err
			}
			return p.call(ctx, request, "move_cursor", map[string]any{"x": x, "y": y})
		},
	}
}
