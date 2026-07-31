package agentstatus

import (
	"context"
	"slices"
	"testing"

	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
	"github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
)

func TestResolveCodexAuthUsesAppServerAccountRead(t *testing.T) {
	specs, err := DefaultRegistry().Select([]string{agentprovider.Codex})
	if err != nil {
		t.Fatalf("Select() error = %v", err)
	}
	spec := specs[0]

	tests := []struct {
		name       string
		evidence   CodexAuthProbeEvidence
		wantStatus AuthStatus
		wantLabel  string
		wantMethod string
	}{
		{
			name: "authenticated account",
			evidence: CodexAuthProbeEvidence{
				State:        agentruntime.CodexAppServerAccountAuthenticated,
				AccountLabel: "dev@example.com",
				AuthMethod:   "chatgpt",
			},
			wantStatus: AuthAuthenticated,
			wantLabel:  "dev@example.com",
			wantMethod: "chatgpt",
		},
		{
			name:       "login required",
			evidence:   CodexAuthProbeEvidence{State: agentruntime.CodexAppServerAccountRequired},
			wantStatus: AuthRequired,
		},
		{
			name:       "account read failure",
			evidence:   CodexAuthProbeEvidence{State: agentruntime.CodexAppServerAccountUnknown},
			wantStatus: AuthUnknown,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			service := Service{
				FileExists: func(string) bool { return true },
				CodexAuthProbe: func(_ context.Context, command, _ []string) CodexAuthProbeEvidence {
					if !slices.Equal(command, []string{"/usr/local/bin/codex", "-c", `service_tier="fast"`, "app-server"}) {
						t.Fatalf("command = %#v, want codex app-server with service tier override", command)
					}
					return test.evidence
				},
			}
			auth := service.resolveAuth(context.Background(), spec, true, "/usr/local/bin/codex")
			if auth.Status != test.wantStatus ||
				auth.AccountLabel != test.wantLabel ||
				auth.AuthMethod != test.wantMethod {
				t.Fatalf("auth = %#v, want status=%q label=%q method=%q", auth, test.wantStatus, test.wantLabel, test.wantMethod)
			}
		})
	}
}
