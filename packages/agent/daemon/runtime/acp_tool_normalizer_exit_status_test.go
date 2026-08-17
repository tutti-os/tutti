package agentruntime

import "testing"

func TestACPInferTerminalToolStatusUsesProviderStatusBeforeExitCode(t *testing.T) {
	tests := []struct {
		name      string
		rawOutput map[string]any
		expected  string
	}{
		{name: "provider completed owns nonzero exit", rawOutput: map[string]any{"status": "completed", "exitCode": 1}, expected: messageStreamStateCompleted},
		{name: "provider failed owns zero exit", rawOutput: map[string]any{"state": "failed", "exitCode": 0}, expected: messageStreamStateFailed},
		{name: "zero exit fallback completes", rawOutput: map[string]any{"exitCode": 0}, expected: messageStreamStateCompleted},
		{name: "nonzero exit fallback fails", rawOutput: map[string]any{"exitCode": 1}, expected: messageStreamStateFailed},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := acpInferTerminalToolStatus(test.rawOutput); got != test.expected {
				t.Fatalf("status = %q, want %q", got, test.expected)
			}
		})
	}
}
