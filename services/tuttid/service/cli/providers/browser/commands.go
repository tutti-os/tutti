package browser

import (
	"context"
	"fmt"
	"os"

	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
	"github.com/tutti-os/tutti/services/tuttid/service/cli/framework"
)

type navigateInput struct {
	URL string `cli:"url" validate:"required"`
}

type screenshotInput struct {
	FullPage bool `cli:"full-page"`
}

type uidInput struct {
	UID string `cli:"uid" validate:"required"`
}

type fillInput struct {
	UID   string `cli:"uid" validate:"required"`
	Value string `cli:"value" validate:"required"`
}

type evalInput struct {
	Script string `cli:"script" validate:"required"`
}

type pageInput struct {
	PageID string `cli:"page-id" validate:"required"`
}

type newPageInput struct {
	URL string `cli:"url"`
}

func plainOutputSpec() framework.OutputSpec {
	return framework.OutputSpec{
		DefaultMode: cliservice.OutputModePlain,
		PlainText: func(result any) string {
			return result.(string)
		},
	}
}

func (p Provider) newNavigateCommand() cliservice.Command {
	return framework.Register(framework.CommandSpec[navigateInput]{
		ID:          "browser.navigate",
		Path:        []string{"browser", "navigate"},
		Summary:     "Navigate the browser to a URL",
		Description: "Open a URL in the workspace browser and return the page state.",
		Kind:        framework.KindAction,
		Workspace:   framework.WorkspaceRequired,
		Workspaces:  p.workspaces,
		Inputs:      framework.FromStruct[navigateInput](),
		Output:      plainOutputSpec(),
		Run: func(ctx context.Context, invoke framework.InvokeContext, input navigateInput) (any, error) {
			return p.call(ctx, invoke, "navigate_page", map[string]any{"url": input.URL})
		},
	})
}

func (p Provider) newSnapshotCommand() cliservice.Command {
	return framework.Register(framework.CommandSpec[struct{}]{
		ID:          "browser.snapshot",
		Path:        []string{"browser", "snapshot"},
		Summary:     "Capture an accessibility snapshot of the page",
		Description: "Return a text snapshot (accessibility tree) of the current page, including element uids to click/fill.",
		Kind:        framework.KindGet,
		Workspace:   framework.WorkspaceRequired,
		Workspaces:  p.workspaces,
		Inputs:      framework.FromStruct[struct{}](),
		Output:      plainOutputSpec(),
		Run: func(ctx context.Context, invoke framework.InvokeContext, _ struct{}) (any, error) {
			return p.call(ctx, invoke, "take_snapshot", map[string]any{})
		},
	})
}

func (p Provider) newScreenshotCommand() cliservice.Command {
	return framework.Register(framework.CommandSpec[screenshotInput]{
		ID:          "browser.screenshot",
		Path:        []string{"browser", "screenshot"},
		Summary:     "Take a screenshot of the page",
		Description: "Save a PNG screenshot of the current page to a file and return its path. Pass full-page=true for the whole page.",
		Kind:        framework.KindAction,
		Workspace:   framework.WorkspaceRequired,
		Workspaces:  p.workspaces,
		Inputs:      framework.FromStruct[screenshotInput](),
		Output:      plainOutputSpec(),
		Run:         p.runScreenshot,
	})
}

func (p Provider) runScreenshot(ctx context.Context, invoke framework.InvokeContext, input screenshotInput) (any, error) {
	file, err := os.CreateTemp("", "tutti-browser-*.png")
	if err != nil {
		return nil, err
	}
	path := file.Name()
	_ = file.Close()
	args := map[string]any{"filePath": path}
	if input.FullPage {
		args["fullPage"] = true
	}
	text, err := p.call(ctx, invoke, "take_screenshot", args)
	if err != nil {
		return nil, err
	}
	return fmt.Sprintf("Screenshot saved to %s\n%s", path, text), nil
}

func (p Provider) newClickCommand() cliservice.Command {
	return framework.Register(framework.CommandSpec[uidInput]{
		ID:          "browser.click",
		Path:        []string{"browser", "click"},
		Summary:     "Click an element",
		Description: "Click the element with the given uid (from `tutti browser snapshot`).",
		Kind:        framework.KindAction,
		Workspace:   framework.WorkspaceRequired,
		Workspaces:  p.workspaces,
		Inputs:      framework.FromStruct[uidInput](),
		Output:      plainOutputSpec(),
		Run: func(ctx context.Context, invoke framework.InvokeContext, input uidInput) (any, error) {
			return p.call(ctx, invoke, "click", map[string]any{"uid": input.UID})
		},
	})
}

func (p Provider) newFillCommand() cliservice.Command {
	return framework.Register(framework.CommandSpec[fillInput]{
		ID:          "browser.fill",
		Path:        []string{"browser", "fill"},
		Summary:     "Fill a form field",
		Description: "Type a value into the element with the given uid (from `tutti browser snapshot`).",
		Kind:        framework.KindAction,
		Workspace:   framework.WorkspaceRequired,
		Workspaces:  p.workspaces,
		Inputs:      framework.FromStruct[fillInput](),
		Output:      plainOutputSpec(),
		Run: func(ctx context.Context, invoke framework.InvokeContext, input fillInput) (any, error) {
			return p.call(ctx, invoke, "fill", map[string]any{"uid": input.UID, "value": input.Value})
		},
	})
}

func (p Provider) newEvalCommand() cliservice.Command {
	return framework.Register(framework.CommandSpec[evalInput]{
		ID:          "browser.eval",
		Path:        []string{"browser", "eval"},
		Summary:     "Evaluate JavaScript on the page",
		Description: "Run a JS function on the current page, e.g. \"() => document.title\", and return its result.",
		Kind:        framework.KindAction,
		Workspace:   framework.WorkspaceRequired,
		Workspaces:  p.workspaces,
		Inputs:      framework.FromStruct[evalInput](),
		Output:      plainOutputSpec(),
		Run: func(ctx context.Context, invoke framework.InvokeContext, input evalInput) (any, error) {
			return p.call(ctx, invoke, "evaluate_script", map[string]any{"function": input.Script})
		},
	})
}

func (p Provider) newListPagesCommand() cliservice.Command {
	return framework.Register(framework.CommandSpec[struct{}]{
		ID:          "browser.list-pages",
		Path:        []string{"browser", "list-pages"},
		Summary:     "List open browser pages",
		Description: "List the open pages/tabs in the workspace browser.",
		Kind:        framework.KindList,
		Workspace:   framework.WorkspaceRequired,
		Workspaces:  p.workspaces,
		Inputs:      framework.FromStruct[struct{}](),
		Output: framework.OutputSpec{
			DefaultMode: cliservice.OutputModePlain,
			PlainText:   func(result any) string { return result.(string) },
			ListCompact: true,
		},
		Run: func(ctx context.Context, invoke framework.InvokeContext, _ struct{}) (any, error) {
			return p.call(ctx, invoke, "list_pages", map[string]any{})
		},
	})
}

func (p Provider) newPageCommand() cliservice.Command {
	return framework.Register(framework.CommandSpec[newPageInput]{
		ID:          "browser.new-page",
		Path:        []string{"browser", "new-page"},
		Summary:     "Create a browser page",
		Description: "Create a background page in the Agent Browser and select it for later commands.",
		Kind:        framework.KindAction,
		Workspace:   framework.WorkspaceRequired,
		Workspaces:  p.workspaces,
		Inputs:      framework.FromStruct[newPageInput](),
		Output:      plainOutputSpec(),
		Run: func(ctx context.Context, invoke framework.InvokeContext, input newPageInput) (any, error) {
			args := map[string]any{}
			if input.URL != "" {
				args["url"] = input.URL
			}
			return p.call(ctx, invoke, "new_page", args)
		},
	})
}

func (p Provider) newSelectPageCommand() cliservice.Command {
	return framework.Register(framework.CommandSpec[pageInput]{
		ID:          "browser.select-page",
		Path:        []string{"browser", "select-page"},
		Summary:     "Select a browser page",
		Description: "Select a page id from `tutti browser list-pages` for later commands.",
		Kind:        framework.KindAction,
		Workspace:   framework.WorkspaceRequired,
		Workspaces:  p.workspaces,
		Inputs:      framework.FromStruct[pageInput](),
		Output:      plainOutputSpec(),
		Run: func(ctx context.Context, invoke framework.InvokeContext, input pageInput) (any, error) {
			return p.call(ctx, invoke, "select_page", map[string]any{"pageId": input.PageID})
		},
	})
}

func (p Provider) newClosePageCommand() cliservice.Command {
	return framework.Register(framework.CommandSpec[pageInput]{
		ID:          "browser.close-page",
		Path:        []string{"browser", "close-page"},
		Summary:     "Close a browser page",
		Description: "Close a page by id from `tutti browser list-pages`.",
		Kind:        framework.KindAction,
		Workspace:   framework.WorkspaceRequired,
		Workspaces:  p.workspaces,
		Inputs:      framework.FromStruct[pageInput](),
		Output:      plainOutputSpec(),
		Run: func(ctx context.Context, invoke framework.InvokeContext, input pageInput) (any, error) {
			return p.call(ctx, invoke, "close_page", map[string]any{"pageId": input.PageID})
		},
	})
}
