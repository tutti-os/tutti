package browser

import (
	"context"
	"fmt"
	"os"

	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
)

func textOutput() cliservice.CapabilityOutput {
	return cliservice.CapabilityOutput{DefaultMode: cliservice.OutputModePlain}
}

func (p Provider) newNavigateCommand() cliservice.Command {
	return cliservice.Command{
		Capability: cliservice.Capability{
			ID:          "browser.navigate",
			Path:        []string{"browser", "navigate"},
			Summary:     "Navigate the browser to a URL",
			Description: "Open a URL in the workspace browser and return the page state.",
			InputSchema: map[string]any{
				"type":       "object",
				"properties": map[string]any{"url": map[string]any{"type": "string"}},
				"required":   []string{"url"},
			},
			Output: textOutput(),
		},
		Handler: func(ctx context.Context, request cliservice.InvokeRequest) (cliservice.CommandOutput, error) {
			url, err := cliservice.RequiredStringInput(request.Input, "url")
			if err != nil {
				return cliservice.CommandOutput{}, err
			}
			return p.call(ctx, request, "navigate_page", map[string]any{"url": url})
		},
	}
}

func (p Provider) newSnapshotCommand() cliservice.Command {
	return cliservice.Command{
		Capability: cliservice.Capability{
			ID:          "browser.snapshot",
			Path:        []string{"browser", "snapshot"},
			Summary:     "Capture an accessibility snapshot of the page",
			Description: "Return a text snapshot (accessibility tree) of the current page, including element uids to click/fill.",
			Output:      textOutput(),
		},
		Handler: func(ctx context.Context, request cliservice.InvokeRequest) (cliservice.CommandOutput, error) {
			return p.call(ctx, request, "take_snapshot", map[string]any{})
		},
	}
}

func (p Provider) newScreenshotCommand() cliservice.Command {
	return cliservice.Command{
		Capability: cliservice.Capability{
			ID:          "browser.screenshot",
			Path:        []string{"browser", "screenshot"},
			Summary:     "Take a screenshot of the page",
			Description: "Save a PNG screenshot of the current page to a file and return its path. Pass full-page=true for the whole page.",
			InputSchema: map[string]any{
				"type":       "object",
				"properties": map[string]any{"full-page": map[string]any{"type": "string"}},
			},
			Output: textOutput(),
		},
		Handler: func(ctx context.Context, request cliservice.InvokeRequest) (cliservice.CommandOutput, error) {
			file, err := os.CreateTemp("", "tutti-browser-*.png")
			if err != nil {
				return cliservice.CommandOutput{}, err
			}
			path := file.Name()
			_ = file.Close()
			args := map[string]any{"filePath": path}
			if fullPage, _, _ := cliservice.StringInput(request.Input, "full-page"); fullPage == "true" {
				args["fullPage"] = true
			}
			out, err := p.call(ctx, request, "take_screenshot", args)
			if err != nil {
				return cliservice.CommandOutput{}, err
			}
			out.Text = fmt.Sprintf("Screenshot saved to %s\n%s", path, out.Text)
			return out, nil
		},
	}
}

func (p Provider) newClickCommand() cliservice.Command {
	return cliservice.Command{
		Capability: cliservice.Capability{
			ID:          "browser.click",
			Path:        []string{"browser", "click"},
			Summary:     "Click an element",
			Description: "Click the element with the given uid (from `tutti browser snapshot`).",
			InputSchema: map[string]any{
				"type":       "object",
				"properties": map[string]any{"uid": map[string]any{"type": "string"}},
				"required":   []string{"uid"},
			},
			Output: textOutput(),
		},
		Handler: func(ctx context.Context, request cliservice.InvokeRequest) (cliservice.CommandOutput, error) {
			uid, err := cliservice.RequiredStringInput(request.Input, "uid")
			if err != nil {
				return cliservice.CommandOutput{}, err
			}
			return p.call(ctx, request, "click", map[string]any{"uid": uid})
		},
	}
}

func (p Provider) newFillCommand() cliservice.Command {
	return cliservice.Command{
		Capability: cliservice.Capability{
			ID:          "browser.fill",
			Path:        []string{"browser", "fill"},
			Summary:     "Fill a form field",
			Description: "Type a value into the element with the given uid (from `tutti browser snapshot`).",
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"uid":   map[string]any{"type": "string"},
					"value": map[string]any{"type": "string"},
				},
				"required": []string{"uid", "value"},
			},
			Output: textOutput(),
		},
		Handler: func(ctx context.Context, request cliservice.InvokeRequest) (cliservice.CommandOutput, error) {
			uid, err := cliservice.RequiredStringInput(request.Input, "uid")
			if err != nil {
				return cliservice.CommandOutput{}, err
			}
			value, err := cliservice.RequiredStringInput(request.Input, "value")
			if err != nil {
				return cliservice.CommandOutput{}, err
			}
			return p.call(ctx, request, "fill", map[string]any{"uid": uid, "value": value})
		},
	}
}

func (p Provider) newEvalCommand() cliservice.Command {
	return cliservice.Command{
		Capability: cliservice.Capability{
			ID:          "browser.eval",
			Path:        []string{"browser", "eval"},
			Summary:     "Evaluate JavaScript on the page",
			Description: "Run a JS function on the current page, e.g. \"() => document.title\", and return its result.",
			InputSchema: map[string]any{
				"type":       "object",
				"properties": map[string]any{"script": map[string]any{"type": "string"}},
				"required":   []string{"script"},
			},
			Output: textOutput(),
		},
		Handler: func(ctx context.Context, request cliservice.InvokeRequest) (cliservice.CommandOutput, error) {
			script, err := cliservice.RequiredStringInput(request.Input, "script")
			if err != nil {
				return cliservice.CommandOutput{}, err
			}
			return p.call(ctx, request, "evaluate_script", map[string]any{"function": script})
		},
	}
}

func (p Provider) newListPagesCommand() cliservice.Command {
	return cliservice.Command{
		Capability: cliservice.Capability{
			ID:          "browser.list-pages",
			Path:        []string{"browser", "list-pages"},
			Summary:     "List open browser pages",
			Description: "List the open pages/tabs in the workspace browser.",
			Output:      textOutput(),
		},
		Handler: func(ctx context.Context, request cliservice.InvokeRequest) (cliservice.CommandOutput, error) {
			return p.call(ctx, request, "list_pages", map[string]any{})
		},
	}
}
