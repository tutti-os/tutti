//go:build !windows

package tuttiagent

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/tutti-os/tutti/packages/agent/daemon/runtimecmd"
	runtimeprep "github.com/tutti-os/tutti/packages/agent/runtimeprep"
	agentstatusservice "github.com/tutti-os/tutti/services/tuttid/service/agentstatus"
)

type authProviderCommandResolverStub struct {
	resolution agentstatusservice.ProviderCommandResolution
	provider   string
}

func (s *authProviderCommandResolverStub) ResolveProviderCommand(
	_ context.Context,
	provider string,
) (agentstatusservice.ProviderCommandResolution, error) {
	s.provider = provider
	return s.resolution, nil
}

func TestAuthBootstrapperUsesManagedNodeEnvironmentForNPMLauncher(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("PATH", filepath.Join(t.TempDir(), "path-without-node"))
	writeHostAccountAuth(t, "session_id=session_test")

	account := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != tuttiAgentLLMTokenIssueRoute {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(validTuttiAgentTokenPayload(t, []string{"llm:models", "llm:chat"})))
	}))
	defer account.Close()
	t.Setenv("TUTTI_ACCOUNT_BASE_URL", account.URL)

	nodeBinDir := filepath.Join(t.TempDir(), "managed-node", "bin")
	if err := os.MkdirAll(nodeBinDir, 0o755); err != nil {
		t.Fatal(err)
	}
	nodePath := filepath.Join(nodeBinDir, "node")
	nodeScript := "#!/bin/sh\n" +
		"shift\n" +
		"if [ \"$1\" != \"login\" ] || [ \"$2\" != \"--with-tutti-llm-tokens\" ]; then exit 2; fi\n" +
		"/bin/cat >/dev/null\n" +
		"/bin/mkdir -p \"$TUTTI_AGENT_HOME\"\n" +
		"printf '%s' '{\"tutti_llm\":{\"access_token\":\"lat_new\",\"access_token_expires_at\":4102444800,\"refresh_token\":\"lrt_new\"}}' > \"$TUTTI_AGENT_HOME/auth.json\"\n"
	if err := os.WriteFile(nodePath, []byte(nodeScript), 0o755); err != nil {
		t.Fatal(err)
	}

	launcher := filepath.Join(nodeBinDir, "tutti-agent")
	if err := os.WriteFile(launcher, []byte("#!/usr/bin/env node\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	providerCommands := &authProviderCommandResolverStub{
		resolution: agentstatusservice.ProviderCommandResolution{
			Command: []string{"tutti-agent", "app-server"},
			Env: []string{
				"PATH=" + nodeBinDir,
				"TUTTI_APP_NODE=" + nodePath,
			},
		},
	}
	resolver := runtimecmd.Resolver{}
	bootstrapper := &AuthBootstrapper{
		ProviderCommands: providerCommands,
		ResolveEnv:       resolver.Env,
	}

	bootstrapper.Bootstrap(t.Context(), runtimeprep.PrepareInput{})

	if providerCommands.provider != tuttiAgentProvider {
		t.Fatalf("resolved provider = %q, want %q", providerCommands.provider, tuttiAgentProvider)
	}
	if !tuttiAgentUserAuthMaterialReady() {
		t.Fatal("managed Node launcher did not materialize ready Tutti Agent auth")
	}
}
