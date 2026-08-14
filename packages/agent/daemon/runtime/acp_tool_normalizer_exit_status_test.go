package agentruntime

import "testing"

func TestACPInferTerminalToolStatusTreatsGitDiffOneAsCompleted(t *testing.T) {
	tests := []struct {
		name    string
		command any
	}{
		{name: "string", command: "git diff --no-index -- /dev/null README.md"},
		{name: "argv", command: []any{"git", "diff", "--quiet", "HEAD"}},
		{name: "shell wrapper", command: []any{"/bin/sh", "-lc", "git diff --exit-code HEAD^ HEAD"}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			update := map[string]any{
				"rawInput": map[string]any{"command": test.command},
			}
			rawOutput := map[string]any{"exitCode": 1}
			if got := acpInferTerminalToolStatus(update, rawOutput); got != messageStreamStateCompleted {
				t.Fatalf("status = %q, want completed", got)
			}
		})
	}
}

func TestACPInferTerminalToolStatusKeepsOtherExitOneFailed(t *testing.T) {
	commands := []string{
		"go test ./...",
		"git diff --quiet && false",
		"false && git diff --quiet",
		"git diff --quiet&&false",
		"false||git diff --quiet",
		"git diff --quiet;false",
	}
	for _, command := range commands {
		update := map[string]any{
			"rawInput": map[string]any{"command": command},
		}
		rawOutput := map[string]any{"exitCode": 1}
		if got := acpInferTerminalToolStatus(update, rawOutput); got != messageStreamStateFailed {
			t.Fatalf("command %q status = %q, want failed", command, got)
		}
	}
}
