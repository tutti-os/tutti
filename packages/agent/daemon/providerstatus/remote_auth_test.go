package providerstatus

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
)

func TestProbeRemoteAuthClassifiesProviderEvidence(t *testing.T) {
	tests := []struct {
		name       string
		statusCode int
		wantKind   AuthEvidenceKind
		wantReason string
	}{
		{name: "accepted", statusCode: http.StatusOK, wantKind: AuthEvidenceRemoteSuccess},
		{name: "unauthorized", statusCode: http.StatusUnauthorized, wantKind: AuthEvidenceRemoteAuthFailure, wantReason: AuthReasonSessionExpired},
		{name: "forbidden", statusCode: http.StatusForbidden, wantKind: AuthEvidenceProbeFailure, wantReason: AuthReasonProbeFailed},
		{name: "rate limited", statusCode: http.StatusTooManyRequests, wantKind: AuthEvidenceProbeFailure, wantReason: AuthReasonProbeFailed},
		{name: "server failure", statusCode: http.StatusBadGateway, wantKind: AuthEvidenceProbeFailure, wantReason: AuthReasonProbeFailed},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
				if got := request.Header.Get("Authorization"); got != "Bearer oauth-token" {
					t.Fatalf("Authorization = %q", got)
				}
				if got := request.Header.Get("anthropic-beta"); got != "oauth-test" {
					t.Fatalf("anthropic-beta = %q", got)
				}
				w.WriteHeader(test.statusCode)
				_, _ = w.Write([]byte(`{"ok":true}`))
			}))
			defer server.Close()

			result := ProbeRemoteAuth(context.Background(), server.Client(), providerregistry.RemoteAuthProbeDescriptor{
				Kind: providerregistry.RemoteAuthProbeKindHTTPBearer, Endpoint: server.URL,
				Method: http.MethodGet, Headers: map[string]string{"anthropic-beta": "oauth-test"},
				TimeoutSeconds: 1,
			}, "oauth-token")
			if result.Evidence.Kind != test.wantKind || result.Evidence.Reason != test.wantReason {
				t.Fatalf("evidence = %#v", result.Evidence)
			}
			if test.statusCode == http.StatusOK && string(result.Body) != `{"ok":true}` {
				t.Fatalf("Body = %q", result.Body)
			}
		})
	}
}

func TestClaudeOAuthCredentialContract(t *testing.T) {
	token, ok := ClaudeOAuthAccessToken([]byte(`{"claudeAiOauth":{"accessToken":" token ","expiresAt":1}}`))
	if !ok || token != "token" {
		t.Fatalf("token = %q, %v", token, ok)
	}
	services := ClaudeOAuthKeychainServices("/Users/example/.claude")
	if len(services) != 2 || services[0] == services[1] || services[1] != claudeLegacyKeychainService {
		t.Fatalf("services = %#v", services)
	}
}
