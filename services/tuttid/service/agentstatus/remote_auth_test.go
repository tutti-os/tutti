package agentstatus

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
	"github.com/tutti-os/tutti/packages/agent/daemon/providerstatus"
	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
)

func TestResolveRemoteAuthEvidenceReadsClaudeOAuthCredential(t *testing.T) {
	home := t.TempDir()
	configDir := filepath.Join(home, ".claude")
	if err := os.MkdirAll(configDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(
		filepath.Join(configDir, ".credentials.json"),
		[]byte(`{"claudeAiOauth":{"accessToken":"oauth-token","expiresAt":1}}`),
		0o600,
	); err != nil {
		t.Fatal(err)
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if got := request.Header.Get("Authorization"); got != "Bearer oauth-token" {
			t.Fatalf("Authorization = %q", got)
		}
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer server.Close()

	service := Service{
		HomeDir:    func() (string, error) { return home, nil },
		HTTPClient: server.Client(),
	}
	evidence, attempted := service.resolveRemoteAuthEvidence(context.Background(), ProviderSpec{
		Provider: "claude-code",
		RemoteAuthProbe: providerregistry.RemoteAuthProbeDescriptor{
			Kind:           providerregistry.RemoteAuthProbeKindHTTPBearer,
			CredentialKind: providerregistry.RemoteAuthCredentialKindClaudeOAuth,
			Endpoint:       server.URL, Method: http.MethodGet, TimeoutSeconds: 1,
		},
	}, "", nil)
	if !attempted || evidence.Kind != providerstatus.AuthEvidenceRemoteAuthFailure ||
		evidence.Reason != providerstatus.AuthReasonSessionExpired {
		t.Fatalf("evidence = %#v, attempted = %v", evidence, attempted)
	}
}

func TestResolveRemoteAuthEvidenceUsesCodexProviderUsageProbe(t *testing.T) {
	var gotCommand []string
	var gotEnv []string
	service := Service{
		CodexRemoteAuthProbe: func(
			_ context.Context,
			command []string,
			env []string,
		) providerstatus.AuthEvidence {
			gotCommand = append([]string(nil), command...)
			gotEnv = append([]string(nil), env...)
			return providerstatus.AuthEvidence{Kind: providerstatus.AuthEvidenceRemoteSuccess}
		},
	}
	evidence, attempted := service.resolveRemoteAuthEvidence(
		context.Background(),
		ProviderSpec{
			Provider:          providerregistry.CodexProviderID,
			AuthStatusCommand: []string{"-c", `service_tier="fast"`, "app-server"},
			RemoteAuthProbe: providerregistry.RemoteAuthProbeDescriptor{
				Kind: providerregistry.RemoteAuthProbeKindProviderUsage, TimeoutSeconds: 30,
			},
		},
		"/usr/local/bin/codex",
		[]string{"PATH=/usr/local/bin"},
	)
	if !attempted || evidence.Kind != providerstatus.AuthEvidenceRemoteSuccess {
		t.Fatalf("evidence = %#v, attempted = %v", evidence, attempted)
	}
	if want := []string{"/usr/local/bin/codex", "-c", `service_tier="fast"`, "app-server"}; !reflect.DeepEqual(gotCommand, want) {
		t.Fatalf("command = %#v, want %#v", gotCommand, want)
	}
	if want := []string{"PATH=/usr/local/bin"}; !reflect.DeepEqual(gotEnv, want) {
		t.Fatalf("env = %#v, want %#v", gotEnv, want)
	}
}

func TestReduceProviderAuthRemoteEvidenceOutranksLocalStatus(t *testing.T) {
	service := Service{RunOutcomes: NewRunOutcomeStore()}
	spec := ProviderSpec{Provider: "claude-code"}
	local := AuthInfo{Status: AuthAuthenticated, AuthMethod: "oauth"}

	authenticated := service.reduceProviderAuthWithRemote(
		spec,
		local,
		false,
		providerstatus.AuthEvidenceAuthorityLocal,
		providerstatus.AuthEvidence{Kind: providerstatus.AuthEvidenceRemoteSuccess},
		true,
	)
	if authenticated.Status != AuthAuthenticated {
		t.Fatalf("authenticated status = %q", authenticated.Status)
	}

	revoked := service.reduceProviderAuthWithRemote(
		spec,
		local,
		false,
		providerstatus.AuthEvidenceAuthorityLocal,
		providerstatus.AuthEvidence{
			Kind: providerstatus.AuthEvidenceRemoteAuthFailure, Reason: providerstatus.AuthReasonSessionExpired,
		},
		true,
	)
	if revoked.Status != AuthRequired {
		t.Fatalf("revoked status = %q", revoked.Status)
	}

	transient := service.reduceProviderAuthWithRemote(
		spec,
		local,
		false,
		providerstatus.AuthEvidenceAuthorityLocal,
		providerstatus.AuthEvidence{Kind: providerstatus.AuthEvidenceProbeFailure},
		true,
	)
	if transient.Status != AuthConfigured {
		t.Fatalf("transient status = %q", transient.Status)
	}
}

func TestServiceListCodexRequiresProviderUsageEvidence(t *testing.T) {
	tests := []struct {
		name     string
		evidence providerstatus.AuthEvidence
		want     AuthStatus
	}{
		{name: "accepted", evidence: providerstatus.AuthEvidence{Kind: providerstatus.AuthEvidenceRemoteSuccess}, want: AuthAuthenticated},
		{name: "revoked", evidence: providerstatus.AuthEvidence{Kind: providerstatus.AuthEvidenceRemoteAuthFailure, Reason: providerstatus.AuthReasonSessionExpired}, want: AuthRequired},
		{name: "transient failure", evidence: providerstatus.AuthEvidence{Kind: providerstatus.AuthEvidenceProbeFailure, Reason: providerstatus.AuthReasonProbeFailed}, want: AuthConfigured},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			service := testService(func(name string) (string, error) {
				return "/usr/local/bin/" + name, nil
			}, map[string]bool{})
			service.CodexAuthProbe = func(context.Context, []string, []string) CodexAuthProbeEvidence {
				return CodexAuthProbeEvidence{
					State: agentruntime.CodexAppServerAccountAuthenticated, AuthMethod: "chatgpt",
				}
			}
			service.RemoteAuthProbe = func(context.Context, ProviderSpec) (providerstatus.AuthEvidence, bool) {
				return test.evidence, true
			}

			snapshot, err := service.List(context.Background(), ListInput{Providers: []string{"codex"}})
			if err != nil {
				t.Fatalf("List() error = %v", err)
			}
			if got := onlyStatus(t, snapshot).Auth.Status; got != test.want {
				t.Fatalf("Auth.Status = %q, want %q", got, test.want)
			}
		})
	}
}
