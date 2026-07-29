package providerstatus

import (
	"testing"

	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
)

func TestParseAuthStatusOutput(t *testing.T) {
	tests := []struct {
		name       string
		parserKind providerregistry.AuthOutputParserKind
		output     string
		wantStatus AuthStatus
		wantLabel  string
		wantMethod string
		wantParsed bool
	}{
		{
			name: "codex authenticated", parserKind: providerregistry.AuthOutputParserKindCodex,
			output: "Logged in using ChatGPT", wantStatus: AuthAuthenticated, wantParsed: true,
		},
		{
			name: "codex signed out", parserKind: providerregistry.AuthOutputParserKindCodex,
			output: "Not logged in", wantStatus: AuthRequired, wantParsed: true,
		},
		{
			name: "claude authenticated", parserKind: providerregistry.AuthOutputParserKindClaude,
			output:     `{"loggedIn":true,"authMethod":"oauth","email":"user@example.com"}`,
			wantStatus: AuthAuthenticated, wantLabel: "user@example.com", wantMethod: "oauth", wantParsed: true,
		},
		{
			name: "claude signed out", parserKind: providerregistry.AuthOutputParserKindClaude,
			output:     `{"loggedIn":false,"authMethod":"oauth"}`,
			wantStatus: AuthRequired, wantMethod: "oauth", wantParsed: true,
		},
		{
			name: "opencode credentials", parserKind: providerregistry.AuthOutputParserKindOpenCode,
			output: "└  2 credentials", wantStatus: AuthAuthenticated, wantParsed: true,
		},
		{
			name: "opencode signed out", parserKind: providerregistry.AuthOutputParserKindOpenCode,
			output: "No providers are authenticated", wantStatus: AuthRequired, wantParsed: true,
		},
		{
			name: "cursor authenticated", parserKind: providerregistry.AuthOutputParserKindCursor,
			output: "Logged in as user@example.com", wantStatus: AuthAuthenticated,
			wantLabel: "user@example.com", wantParsed: true,
		},
		{
			name: "cursor signed out", parserKind: providerregistry.AuthOutputParserKindCursor,
			output: "Not logged in. Run cursor-agent login.", wantStatus: AuthRequired, wantParsed: true,
		},
		{
			name: "configuration error", parserKind: providerregistry.AuthOutputParserKindCodex,
			output: "Error loading configuration: invalid service tier", wantStatus: AuthUnknown, wantParsed: true,
		},
		{
			name: "unrecognized output", parserKind: providerregistry.AuthOutputParserKindCodex,
			output: "unexpected", wantParsed: false,
		},
		{
			name: "unsupported parser", output: "Logged in", wantParsed: false,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, parsed := ParseAuthStatusOutput(test.parserKind, []byte(test.output))
			if parsed != test.wantParsed {
				t.Fatalf("parsed = %v, want %v", parsed, test.wantParsed)
			}
			if !parsed {
				return
			}
			if got.Status != test.wantStatus {
				t.Fatalf("status = %q, want %q", got.Status, test.wantStatus)
			}
			if got.AccountLabel != test.wantLabel {
				t.Fatalf("account label = %q, want %q", got.AccountLabel, test.wantLabel)
			}
			if got.AuthMethod != test.wantMethod {
				t.Fatalf("auth method = %q, want %q", got.AuthMethod, test.wantMethod)
			}
		})
	}
}
