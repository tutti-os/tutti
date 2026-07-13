package api

import (
	"context"
	"testing"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
)

func TestTrackDeprecatedWorkspaceAppAgentAPIRecordsMigrationDimensions(t *testing.T) {
	reporter := &recordingAnalyticsReporter{}
	api := DaemonAPI{AnalyticsReporter: reporter}

	api.trackDeprecatedWorkspaceAppAgentAPI(
		context.Background(),
		"agent-providers/status",
		"canvas",
		"0.1.0",
	)

	if len(reporter.events) != 1 {
		t.Fatalf("events = %#v, want one", reporter.events)
	}
	event := reporter.events[0]
	if event.Name != deprecatedWorkspaceAppAgentAPIUsedEvent {
		t.Fatalf("event name = %q", event.Name)
	}
	if event.Params["route"] != "agent-providers/status" ||
		event.Params["app_id"] != "canvas" ||
		event.Params["workspace_app_version"] != "0.1.0" ||
		event.Params["migration_target"] != "agent-acp-kit-tutti-cli-facade" {
		t.Fatalf("event params = %#v", event.Params)
	}
	for _, forbidden := range []string{"workspace_id", "provider", "cwd", "credential"} {
		if _, ok := event.Params[forbidden]; ok {
			t.Fatalf("event contains forbidden %q: %#v", forbidden, event.Params)
		}
	}
}

func TestTrackDeprecatedWorkspaceAppAgentAPIIgnoresIncompleteDimensions(t *testing.T) {
	reporter := &recordingAnalyticsReporter{}
	api := DaemonAPI{AnalyticsReporter: reporter}

	api.trackDeprecatedWorkspaceAppAgentAPI(context.Background(), "", "canvas", "0.1.0")
	api.trackDeprecatedWorkspaceAppAgentAPI(context.Background(), "preferences/agent", "", "0.1.0")

	if len(reporter.events) != 0 {
		t.Fatalf("events = %#v, want none", reporter.events)
	}
}

func TestDeprecatedWorkspaceAppAgentHandlersEmitUsageAfterAppValidation(t *testing.T) {
	reporter := &recordingAnalyticsReporter{}
	api := DaemonAPI{
		AnalyticsReporter: reporter,
		AppCenterService:  installedWorkspaceAppCenter("canvas"),
	}
	ctx := context.Background()

	_, _ = api.GetWorkspaceAppAgentPreferences(ctx, tuttigenerated.GetWorkspaceAppAgentPreferencesRequestObject{
		WorkspaceID: "ws-1",
		AppID:       "canvas",
	})
	_, _ = api.GetWorkspaceAppAgentProviderStatuses(ctx, tuttigenerated.GetWorkspaceAppAgentProviderStatusesRequestObject{
		WorkspaceID: "ws-1",
		AppID:       "canvas",
		Params:      tuttigenerated.GetWorkspaceAppAgentProviderStatusesParams{},
	})
	_, _ = api.GetWorkspaceAppAgentProviderComposerOptions(ctx, tuttigenerated.GetWorkspaceAppAgentProviderComposerOptionsRequestObject{
		WorkspaceID: "ws-1",
		AppID:       "canvas",
		Provider:    "codex",
	})

	if len(reporter.events) != 3 {
		t.Fatalf("events = %#v, want one per deprecated route", reporter.events)
	}
	wantRoutes := []string{
		"preferences/agent",
		"agent-providers/status",
		"agent-providers/{provider}/composer-options",
	}
	for index, wantRoute := range wantRoutes {
		if got := reporter.events[index].Params["route"]; got != wantRoute {
			t.Fatalf("event %d route = %#v, want %q", index, got, wantRoute)
		}
		if got := reporter.events[index].Params["workspace_app_version"]; got != "0.1.0" {
			t.Fatalf("event %d workspace_app_version = %#v, want %q", index, got, "0.1.0")
		}
	}
}
