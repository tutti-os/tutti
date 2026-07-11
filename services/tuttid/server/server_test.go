package server

import (
	"net/http"
	"testing"

	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
)

func TestListenerSpecFromEnvRequiresAccessToken(t *testing.T) {
	t.Setenv("TUTTID_ACCESS_TOKEN", "")

	_, err := ListenerSpecFromEnv()
	if err == nil {
		t.Fatal("expected missing access token to fail")
	}
}

func TestListenerSpecFromEnvIncludesAccessToken(t *testing.T) {
	t.Setenv("TUTTID_ACCESS_TOKEN", "desktop-session-token")
	t.Setenv("TUTTID_ADDR", "127.0.0.1:0")

	spec, err := ListenerSpecFromEnv()
	if err != nil {
		t.Fatalf("expected listener spec: %v", err)
	}

	if spec.AccessToken != "desktop-session-token" {
		t.Fatalf("access token = %q, want desktop-session-token", spec.AccessToken)
	}
	if spec.Addr != "127.0.0.1:0" {
		t.Fatalf("addr = %q, want 127.0.0.1:0", spec.Addr)
	}
}

func TestAuthorizeWorkspaceAppServerTokenIsLimitedToAppServerRoutes(t *testing.T) {
	accessToken := "desktop-session-token"
	appToken := workspacebiz.AppServerToken(accessToken, "workspace-1", "app-1")

	allowedExchange, _ := http.NewRequest(
		http.MethodPost,
		"/v1/workspaces/workspace-1/apps/app-1/managed-model-grants/exchange",
		nil,
	)
	if !authorizeWorkspaceAppServerToken(allowedExchange, appToken, accessToken) {
		t.Fatal("expected app token to authorize grant exchange")
	}

	allowedModels, _ := http.NewRequest(
		http.MethodGet,
		"/v1/workspaces/workspace-1/apps/app-1/managed-model-grants/grant-1/models",
		nil,
	)
	if !authorizeWorkspaceAppServerToken(allowedModels, appToken, accessToken) {
		t.Fatal("expected app token to authorize grant model catalog")
	}

	allowedCredential, _ := http.NewRequest(
		http.MethodPost,
		"/v1/workspaces/workspace-1/apps/app-1/managed-model-grants/grant-1/credentials",
		nil,
	)
	if !authorizeWorkspaceAppServerToken(allowedCredential, appToken, accessToken) {
		t.Fatal("expected app token to authorize grant credential")
	}

	allowedRevoke, _ := http.NewRequest(
		http.MethodDelete,
		"/v1/workspaces/workspace-1/apps/app-1/managed-model-grants/grant-1",
		nil,
	)
	if !authorizeWorkspaceAppServerToken(allowedRevoke, appToken, accessToken) {
		t.Fatal("expected app token to authorize grant revoke")
	}

	allowedUploadContent, _ := http.NewRequest(
		http.MethodPut,
		"/v1/workspaces/workspace-1/apps/app-1/uploads/upload-1/content",
		nil,
	)
	if !authorizeWorkspaceAppServerToken(allowedUploadContent, appToken, accessToken) {
		t.Fatal("expected app token to authorize upload content PUT")
	}

	allowedAgentPreferences, _ := http.NewRequest(
		http.MethodGet,
		"/v1/workspaces/workspace-1/apps/app-1/preferences/agent",
		nil,
	)
	if !authorizeWorkspaceAppServerToken(allowedAgentPreferences, appToken, accessToken) {
		t.Fatal("expected app token to authorize workspace app agent preferences")
	}

	allowedAgentStatuses, _ := http.NewRequest(
		http.MethodGet,
		"/v1/workspaces/workspace-1/apps/app-1/agent-providers/status",
		nil,
	)
	if !authorizeWorkspaceAppServerToken(allowedAgentStatuses, appToken, accessToken) {
		t.Fatal("expected app token to authorize workspace app agent provider statuses")
	}

	allowedComposerOptions, _ := http.NewRequest(
		http.MethodPost,
		"/v1/workspaces/workspace-1/apps/app-1/agent-providers/cursor/composer-options",
		nil,
	)
	if !authorizeWorkspaceAppServerToken(allowedComposerOptions, appToken, accessToken) {
		t.Fatal("expected app token to authorize workspace app composer options")
	}

	createGrant, _ := http.NewRequest(
		http.MethodPost,
		"/v1/workspaces/workspace-1/apps/app-1/managed-model-grants",
		nil,
	)
	if authorizeWorkspaceAppServerToken(createGrant, appToken, accessToken) {
		t.Fatal("expected app token to reject grant creation")
	}

	providerConfig, _ := http.NewRequest(
		http.MethodPut,
		"/v1/workspaces/workspace-1/managed-model-providers/agnes",
		nil,
	)
	if authorizeWorkspaceAppServerToken(providerConfig, appToken, accessToken) {
		t.Fatal("expected app token to reject provider configuration")
	}

	globalAgentStatuses, _ := http.NewRequest(
		http.MethodGet,
		"/v1/agent-providers/status",
		nil,
	)
	if authorizeWorkspaceAppServerToken(globalAgentStatuses, appToken, accessToken) {
		t.Fatal("expected app token to reject global agent provider statuses")
	}

	globalDesktopPreferences, _ := http.NewRequest(
		http.MethodGet,
		"/v1/preferences/desktop",
		nil,
	)
	if authorizeWorkspaceAppServerToken(globalDesktopPreferences, appToken, accessToken) {
		t.Fatal("expected app token to reject global desktop preferences")
	}

	agentTargetMutation, _ := http.NewRequest(
		http.MethodPatch,
		"/v1/agent-targets/local:tutti-agent/enabled",
		nil,
	)
	if authorizeWorkspaceAppServerToken(agentTargetMutation, appToken, accessToken) {
		t.Fatal("expected app token to reject system agent target mutation")
	}

	providerModels, _ := http.NewRequest(
		http.MethodPost,
		"/v1/workspaces/workspace-1/managed-model-providers/agnes/models",
		nil,
	)
	if authorizeWorkspaceAppServerToken(providerModels, appToken, accessToken) {
		t.Fatal("expected app token to reject provider model detection")
	}

	prepareUpload, _ := http.NewRequest(
		http.MethodPost,
		"/v1/workspaces/workspace-1/apps/app-1/uploads",
		nil,
	)
	if authorizeWorkspaceAppServerToken(prepareUpload, appToken, accessToken) {
		t.Fatal("expected app token to reject upload session creation")
	}

	completeUpload, _ := http.NewRequest(
		http.MethodPost,
		"/v1/workspaces/workspace-1/apps/app-1/uploads/upload-1/complete",
		nil,
	)
	if authorizeWorkspaceAppServerToken(completeUpload, appToken, accessToken) {
		t.Fatal("expected app token to reject upload completion")
	}
}
