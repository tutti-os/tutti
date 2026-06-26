package workbenchapps

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	workbenchbiz "github.com/tutti-os/tutti/services/tuttid/biz/workbench"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
)

const (
	appID              = "workspace-apps"
	agentGUITypeID     = "agent-gui"
	issueManagerAppID  = "issue-manager"
	issueManagerTypeID = "issue-manager"
	workspaceAppTypeID = "workspace-app-webview"
	maxStateJSONBytes  = 16 * 1024
)

type AppLauncher interface {
	Launch(context.Context, string, string) (workspacebiz.WorkspaceApp, error)
}

type WorkbenchNodeLaunchPublisher interface {
	PublishWorkbenchNodeLaunchRequested(context.Context, workbenchbiz.NodeLaunchRequest) error
}

type Provider struct {
	workspaces      cliservice.WorkspaceCatalog
	apps            AppLauncher
	launchPublisher WorkbenchNodeLaunchPublisher
}

func NewProvider(
	workspaces cliservice.WorkspaceCatalog,
	apps AppLauncher,
	launchPublisher WorkbenchNodeLaunchPublisher,
) Provider {
	return Provider{workspaces: workspaces, apps: apps, launchPublisher: launchPublisher}
}

func (Provider) AppID() string {
	return appID
}

func (p Provider) Commands() []cliservice.Command {
	return []cliservice.Command{p.newOpenCommand()}
}

func (p Provider) newOpenCommand() cliservice.Command {
	return cliservice.Command{
		Capability: cliservice.Capability{
			ID:          appID + ".app.open",
			Path:        []string{"app", "open"},
			Summary:     "Open a workspace app",
			Description: "Launch or activate an installed workspace app. Use --route to pass an origin-root route intent.",
			Visibility:  cliservice.CapabilityVisibilityPublic,
			InputSchema: map[string]any{
				"type": "object",
				"required": []string{
					"app-id",
				},
				"properties": map[string]any{
					"app-id": map[string]any{
						"type":        "string",
						"description": "Workspace app id.",
					},
					"route": map[string]any{
						"type":        "string",
						"description": "Origin-root route path. Must start with /.",
					},
					"param": map[string]any{
						"oneOf": []map[string]any{
							{"type": "string"},
							{
								"type":  "array",
								"items": map[string]any{"type": "string"},
							},
						},
						"description": "Route parameter in key=value form. May be passed multiple times.",
					},
					"state-json": map[string]any{
						"type":        "string",
						"description": "Optional JSON object passed as route state. Maximum 16KiB.",
					},
				},
			},
			Output: cliservice.CapabilityOutput{
				DefaultMode: cliservice.OutputModeTable,
				JSON:        true,
				Table: &cliservice.TableOutput{
					Columns: []cliservice.TableColumn{
						{Key: "appId", Label: "App ID"},
						{Key: "status", Label: "Status"},
						{Key: "launchRequested", Label: "Launch Requested"},
					},
				},
			},
		},
		Handler: p.runOpen,
	}
}

func (p Provider) runOpen(ctx context.Context, request cliservice.InvokeRequest) (cliservice.CommandOutput, error) {
	if p.apps == nil {
		return cliservice.CommandOutput{}, cliservice.ServiceUnavailableError("workspace_apps_unavailable", fmt.Errorf("workspace apps service is unavailable"))
	}
	workspaceID, err := cliservice.ResolveWorkspaceID(ctx, p.workspaces, request.Context.WorkspaceID)
	if err != nil {
		return cliservice.CommandOutput{}, err
	}
	appID, err := cliservice.RequiredStringInput(request.Input, "app-id")
	if err != nil {
		return cliservice.CommandOutput{}, err
	}
	route, _, err := cliservice.StringInput(request.Input, "route")
	if err != nil {
		return cliservice.CommandOutput{}, err
	}
	intent, err := appOpenRouteIntent(request.Input, route)
	if err != nil {
		return cliservice.CommandOutput{}, err
	}
	if ok, output, err := p.openSpecialApp(ctx, workspaceID, appID, intent, request.Context); ok || err != nil {
		return output, err
	}
	app, err := p.apps.Launch(ctx, workspaceID, appID)
	if err != nil {
		return cliservice.CommandOutput{}, err
	}
	payload, err := json.Marshal(workspaceAppWorkbenchLaunchPayload{
		AppID:  app.Package.AppID,
		Intent: intent,
	})
	if err != nil {
		return cliservice.CommandOutput{}, fmt.Errorf("marshal workspace app launch payload: %w", err)
	}
	launchRequested := false
	if p.launchPublisher != nil {
		if err := p.launchPublisher.PublishWorkbenchNodeLaunchRequested(ctx, workbenchbiz.NodeLaunchRequest{
			WorkspaceID:  workspaceID,
			TypeID:       workspaceAppTypeID,
			Source:       request.Context.Source,
			LaunchSource: firstNonEmptyString(request.Context.Source, "cli"),
			Payload:      payload,
		}); err != nil {
			return cliservice.CommandOutput{}, err
		}
		launchRequested = true
	}
	row := map[string]any{
		"appId":           app.Package.AppID,
		"status":          string(app.Runtime.Status),
		"launchRequested": launchRequested,
	}
	return cliservice.CommandOutput{
		Kind: cliservice.OutputModeTable,
		Columns: []cliservice.TableColumn{
			{Key: "appId", Label: "App ID"},
			{Key: "status", Label: "Status"},
			{Key: "launchRequested", Label: "Launch Requested"},
		},
		Rows: []map[string]any{row},
		Value: map[string]any{
			"app": map[string]any{
				"appId":  app.Package.AppID,
				"status": string(app.Runtime.Status),
			},
			"launchRequested": launchRequested,
		},
	}, nil
}

func (p Provider) openSpecialApp(
	ctx context.Context,
	workspaceID string,
	appID string,
	intent *workspaceAppIntent,
	invokeContext cliservice.InvokeContext,
) (bool, cliservice.CommandOutput, error) {
	typeID, dockEntryID, payload, ok := specialAppLaunchRequest(appID)
	if !ok {
		return false, cliservice.CommandOutput{}, nil
	}
	if intent != nil {
		return true, cliservice.CommandOutput{}, cliservice.InvalidInputKeyError("route")
	}
	launchRequested := false
	if p.launchPublisher != nil {
		if err := p.launchPublisher.PublishWorkbenchNodeLaunchRequested(ctx, workbenchbiz.NodeLaunchRequest{
			WorkspaceID:  workspaceID,
			TypeID:       typeID,
			DockEntryID:  dockEntryID,
			Source:       invokeContext.Source,
			LaunchSource: firstNonEmptyString(invokeContext.Source, "cli"),
			Payload:      payload,
		}); err != nil {
			return true, cliservice.CommandOutput{}, err
		}
		launchRequested = true
	}
	row := map[string]any{
		"appId":           appID,
		"status":          "launch_requested",
		"launchRequested": launchRequested,
	}
	return true, cliservice.CommandOutput{
		Kind: cliservice.OutputModeTable,
		Columns: []cliservice.TableColumn{
			{Key: "appId", Label: "App ID"},
			{Key: "status", Label: "Status"},
			{Key: "launchRequested", Label: "Launch Requested"},
		},
		Rows: []map[string]any{row},
		Value: map[string]any{
			"app": map[string]any{
				"appId":  appID,
				"status": "launch_requested",
			},
			"launchRequested": launchRequested,
		},
	}, nil
}

func specialAppLaunchRequest(appID string) (string, string, json.RawMessage, bool) {
	switch strings.TrimSpace(appID) {
	case "agent-codex":
		return agentGUITypeID, agentGUITypeID, json.RawMessage(`{"provider":"codex"}`), true
	case "agent-claude-code":
		return agentGUITypeID, "agent-gui:claude-code", json.RawMessage(`{"provider":"claude-code"}`), true
	case issueManagerAppID:
		return issueManagerTypeID, issueManagerTypeID, nil, true
	default:
		return "", "", nil, false
	}
}

type workspaceAppWorkbenchLaunchPayload struct {
	AppID  string              `json:"appId"`
	Intent *workspaceAppIntent `json:"intent,omitempty"`
}

type workspaceAppIntent struct {
	Kind   string            `json:"kind"`
	Route  string            `json:"route"`
	Params map[string]string `json:"params,omitempty"`
	State  json.RawMessage   `json:"state,omitempty"`
}

func appOpenRouteIntent(input map[string]any, route string) (*workspaceAppIntent, error) {
	if route == "" {
		if len(inputStringValues(input["param"])) > 0 {
			return nil, cliservice.InvalidInputKeyError("param")
		}
		if len(inputStringValues(input["state-json"])) > 0 {
			return nil, cliservice.InvalidInputKeyError("state-json")
		}
		return nil, nil
	}
	if !strings.HasPrefix(route, "/") || strings.HasPrefix(route, "//") || strings.Contains(route, "://") {
		return nil, cliservice.InvalidInputKeyError("route")
	}
	params, err := parseRouteParams(input["param"])
	if err != nil {
		return nil, err
	}
	state, err := parseStateJSON(input["state-json"])
	if err != nil {
		return nil, err
	}
	return &workspaceAppIntent{
		Kind:   "open-route",
		Route:  route,
		Params: params,
		State:  state,
	}, nil
}

func parseRouteParams(raw any) (map[string]string, error) {
	values := inputStringValues(raw)
	if len(values) == 0 {
		return nil, nil
	}
	params := map[string]string{}
	for _, value := range values {
		key, val, ok := strings.Cut(value, "=")
		key = strings.TrimSpace(key)
		if !ok || key == "" {
			return nil, cliservice.InvalidInputKeyError("param")
		}
		params[key] = strings.TrimSpace(val)
	}
	return params, nil
}

func parseStateJSON(raw any) (json.RawMessage, error) {
	values := inputStringValues(raw)
	if len(values) == 0 || strings.TrimSpace(values[0]) == "" {
		return nil, nil
	}
	if len(values) > 1 {
		return nil, cliservice.InvalidInputKeyError("state-json")
	}
	rawJSON := strings.TrimSpace(values[0])
	if len(rawJSON) > maxStateJSONBytes {
		return nil, cliservice.InvalidInputKeyError("state-json")
	}
	var decoded map[string]any
	if err := json.Unmarshal([]byte(rawJSON), &decoded); err != nil {
		return nil, cliservice.InvalidInputKeyError("state-json")
	}
	encoded, err := json.Marshal(decoded)
	if err != nil {
		return nil, fmt.Errorf("marshal state json: %w", err)
	}
	return encoded, nil
}

func inputStringValues(raw any) []string {
	switch value := raw.(type) {
	case nil:
		return nil
	case string:
		return []string{strings.TrimSpace(value)}
	case []string:
		result := make([]string, 0, len(value))
		for _, item := range value {
			result = append(result, strings.TrimSpace(item))
		}
		return result
	case []any:
		result := make([]string, 0, len(value))
		for _, item := range value {
			if text, ok := item.(string); ok {
				result = append(result, strings.TrimSpace(text))
			}
		}
		return result
	default:
		return nil
	}
}

func firstNonEmptyString(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}
