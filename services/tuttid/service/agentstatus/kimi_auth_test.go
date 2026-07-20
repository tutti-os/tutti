package agentstatus

import "testing"

func TestParseKimiCodeAuthStatusOutput(t *testing.T) {
	tests := []struct {
		name       string
		output     string
		wantStatus AuthStatus
		wantOK     bool
	}{
		{
			name:       "managed provider with oauth source is authenticated",
			output:     "managed:kimi-code  type=kimi  models=3  source=oauth\n\nDefault model: kimi-code/k3\n",
			wantStatus: AuthAuthenticated,
			wantOK:     true,
		},
		{
			name:       "api key provider row is authenticated",
			output:     "custom:moonshot  type=openai  models=2  key set\n",
			wantStatus: AuthAuthenticated,
			wantOK:     true,
		},
		{
			name:       "signed out reports no providers",
			output:     "No providers configured.\n",
			wantStatus: AuthRequired,
			wantOK:     true,
		},
		{
			name:       "empty output is not parseable",
			output:     "  \n",
			wantStatus: "",
			wantOK:     false,
		},
		{
			name:       "unrelated output is not parseable",
			output:     "kimi, version 0.27.0\n",
			wantStatus: "",
			wantOK:     false,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			auth, ok := parseKimiCodeAuthStatusOutput([]byte(test.output))
			if ok != test.wantOK || auth.Status != test.wantStatus {
				t.Fatalf("parseKimiCodeAuthStatusOutput() = %#v, %v; want status %q, ok %v", auth, ok, test.wantStatus, test.wantOK)
			}
		})
	}
}
