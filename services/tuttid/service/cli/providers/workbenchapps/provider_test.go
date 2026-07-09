package workbenchapps

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	workbenchbiz "github.com/tutti-os/tutti/services/tuttid/biz/workbench"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
)

func TestOpenPublishesWorkspaceAppWorkbenchLaunch(t *testing.T) {
	workspaces := fakeWorkspaceCatalog{startupID: "ws-1"}
	apps := &fakeAppLauncher{
		app: workspacebiz.WorkspaceApp{
			Package: workspacebiz.AppPackage{AppID: "docs"},
			Runtime: workspacebiz.AppRuntimeState{
				Status: workspacebiz.AppRuntimeStatusRunning,
			},
		},
	}
	publisher := &fakeWorkbenchLaunchPublisher{}
	provider := NewProvider(workspaces, apps, publisher)

	output, err := provider.newOpenCommand().Handler(t.Context(), cliservice.InvokeRequest{
		Context: cliservice.InvokeContext{Source: "cli"},
		Input: map[string]any{
			"app-id":     "docs",
			"param":      []any{"path=/tmp/a", "mode=preview"},
			"route":      "/files",
			"state-json": `{"selected":true}`,
		},
	})
	if err != nil {
		t.Fatalf("run open: %v", err)
	}

	if output.Rows[0]["appId"] != "docs" || output.Rows[0]["launchRequested"] != true {
		t.Fatalf("output = %#v", output)
	}
	if apps.workspaceID != "ws-1" || apps.appID != "docs" {
		t.Fatalf("launch input = %q %q", apps.workspaceID, apps.appID)
	}
	if len(publisher.requests) != 1 {
		t.Fatalf("published requests = %#v", publisher.requests)
	}
	request := publisher.requests[0]
	if request.WorkspaceID != "ws-1" || request.TypeID != workspaceAppTypeID || request.Source != "cli" {
		t.Fatalf("request = %#v", request)
	}
	var payload struct {
		AppID  string `json:"appId"`
		Intent struct {
			Kind   string            `json:"kind"`
			Params map[string]string `json:"params"`
			Route  string            `json:"route"`
			State  map[string]bool   `json:"state"`
		} `json:"intent"`
	}
	if err := json.Unmarshal(request.Payload, &payload); err != nil {
		t.Fatalf("unmarshal payload: %v", err)
	}
	if payload.AppID != "docs" ||
		payload.Intent.Kind != "open-route" ||
		payload.Intent.Route != "/files" ||
		payload.Intent.Params["path"] != "/tmp/a" ||
		payload.Intent.Params["mode"] != "preview" ||
		!payload.Intent.State["selected"] {
		t.Fatalf("payload = %#v", payload)
	}
}

func TestOpenCommandAdvertisesRepeatableParamSchema(t *testing.T) {
	command := NewProvider(fakeWorkspaceCatalog{}, &fakeAppLauncher{}, nil).newOpenCommand()
	if command.Capability.Visibility != cliservice.CapabilityVisibilityPublic {
		t.Fatalf("visibility = %q, want public", command.Capability.Visibility)
	}
	properties := command.Capability.InputSchema["properties"].(map[string]any)
	param := properties["param"].(map[string]any)
	oneOf := param["oneOf"].([]map[string]any)
	if len(oneOf) != 2 || oneOf[0]["type"] != "string" || oneOf[1]["type"] != "array" {
		t.Fatalf("param schema = %#v", param)
	}
	items := oneOf[1]["items"].(map[string]any)
	if items["type"] != "string" {
		t.Fatalf("param array items schema = %#v", items)
	}
	route := properties["route"].(map[string]any)
	if !strings.Contains(route["description"].(string), "Origin-root") {
		t.Fatalf("route schema = %#v", route)
	}
}

func TestOpenPublishesAppWithoutRouteIntent(t *testing.T) {
	provider := NewProvider(
		fakeWorkspaceCatalog{startupID: "ws-1"},
		&fakeAppLauncher{
			app: workspacebiz.WorkspaceApp{
				Package: workspacebiz.AppPackage{AppID: "docs"},
				Runtime: workspacebiz.AppRuntimeState{
					Status: workspacebiz.AppRuntimeStatusRunning,
				},
			},
		},
		&fakeWorkbenchLaunchPublisher{},
	)

	output, err := provider.newOpenCommand().Handler(t.Context(), cliservice.InvokeRequest{
		Context: cliservice.InvokeContext{WorkspaceID: "ws-1"},
		Input:   map[string]any{"app-id": "docs"},
	})
	if err != nil {
		t.Fatalf("run open: %v", err)
	}
	if output.Rows[0]["launchRequested"] != true {
		t.Fatalf("output = %#v", output)
	}
}

func TestOpenPublishesSpecialAppWorkbenchLaunch(t *testing.T) {
	tests := []struct {
		appID       string
		typeID      string
		dockEntryID string
		payload     string
	}{
		{appID: "agent-codex", typeID: agentGUITypeID, dockEntryID: agentGUITypeID, payload: `{"provider":"codex"}`},
		{appID: "agent-claude-code", typeID: agentGUITypeID, dockEntryID: "agent-gui:claude-code", payload: `{"provider":"claude-code"}`},
		{appID: "agent-tutti-agent", typeID: agentGUITypeID, dockEntryID: "agent-gui:tutti-agent", payload: `{"provider":"tutti-agent"}`},
		{appID: issueManagerAppID, typeID: issueManagerTypeID, dockEntryID: issueManagerTypeID},
	}
	for _, test := range tests {
		apps := &fakeAppLauncher{}
		publisher := &fakeWorkbenchLaunchPublisher{}
		provider := NewProvider(fakeWorkspaceCatalog{startupID: "ws-1"}, apps, publisher)

		output, err := provider.newOpenCommand().Handler(t.Context(), cliservice.InvokeRequest{
			Context: cliservice.InvokeContext{Source: "cli"},
			Input:   map[string]any{"app-id": test.appID},
		})
		if err != nil {
			t.Fatalf("%s run open: %v", test.appID, err)
		}
		if apps.appID != "" {
			t.Fatalf("%s launched app center app %q", test.appID, apps.appID)
		}
		if output.Rows[0]["appId"] != test.appID ||
			output.Rows[0]["status"] != "launch_requested" ||
			output.Rows[0]["launchRequested"] != true {
			t.Fatalf("%s output = %#v", test.appID, output)
		}
		if len(publisher.requests) != 1 {
			t.Fatalf("%s published requests = %#v", test.appID, publisher.requests)
		}
		request := publisher.requests[0]
		if request.WorkspaceID != "ws-1" ||
			request.TypeID != test.typeID ||
			request.DockEntryID != test.dockEntryID ||
			request.Source != "cli" ||
			request.LaunchSource != "cli" {
			t.Fatalf("%s request = %#v", test.appID, request)
		}
		if strings.TrimSpace(string(request.Payload)) != test.payload {
			t.Fatalf("%s payload = %q, want %q", test.appID, string(request.Payload), test.payload)
		}
	}
}

func TestOpenRejectsInvalidRouteInputs(t *testing.T) {
	provider := NewProvider(
		fakeWorkspaceCatalog{startupID: "ws-1"},
		&fakeAppLauncher{},
		&fakeWorkbenchLaunchPublisher{},
	)
	tests := []map[string]any{
		{"app-id": "docs", "route": "https://example.com/path"},
		{"app-id": "docs", "route": "//example.com/path"},
		{"app-id": "docs", "route": "files"},
		{"app-id": "docs", "route": "/files", "state-json": "[]"},
		{"app-id": "docs", "param": "path=/tmp/a"},
		{"app-id": issueManagerAppID, "route": "/issues"},
	}
	for _, input := range tests {
		_, err := provider.newOpenCommand().Handler(t.Context(), cliservice.InvokeRequest{
			Input: input,
		})
		if !errors.Is(err, cliservice.ErrInvalidInput) {
			t.Fatalf("input = %#v err = %v, want ErrInvalidInput", input, err)
		}
	}
}

type fakeWorkspaceCatalog struct {
	startupID string
}

func (f fakeWorkspaceCatalog) Startup(context.Context) (*workspacebiz.Summary, error) {
	return &workspacebiz.Summary{ID: f.startupID}, nil
}

func (fakeWorkspaceCatalog) Get(_ context.Context, id string) (workspacebiz.Summary, error) {
	return workspacebiz.Summary{ID: strings.TrimSpace(id)}, nil
}

type fakeAppLauncher struct {
	app         workspacebiz.WorkspaceApp
	appID       string
	workspaceID string
}

func (f *fakeAppLauncher) Launch(_ context.Context, workspaceID string, appID string) (workspacebiz.WorkspaceApp, error) {
	f.workspaceID = workspaceID
	f.appID = appID
	if f.app.Package.AppID == "" {
		f.app.Package.AppID = appID
	}
	return f.app, nil
}

type fakeWorkbenchLaunchPublisher struct {
	requests []workbenchbiz.NodeLaunchRequest
}

func (f *fakeWorkbenchLaunchPublisher) PublishWorkbenchNodeLaunchRequested(_ context.Context, request workbenchbiz.NodeLaunchRequest) error {
	f.requests = append(f.requests, request)
	return nil
}
