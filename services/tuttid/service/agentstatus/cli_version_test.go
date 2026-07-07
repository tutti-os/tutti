package agentstatus

import "testing"

func TestParseCLIVersion(t *testing.T) {
	cases := []struct {
		name   string
		output string
		want   string
	}{
		{name: "codex format", output: "codex-cli 0.142.1", want: "0.142.1"},
		{name: "codex test fake", output: "codex 0.100.0", want: "0.100.0"},
		{
			name:   "claude parenthesized suffix",
			output: "2.1.191 (Claude Code)",
			want:   "2.1.191",
		},
		{name: "leading v tolerated", output: "v1.2.3", want: "1.2.3"},
		{name: "prerelease suffix", output: "tool 1.2.3-beta.1", want: "1.2.3-beta.1"},
		{name: "two component", output: "1.4", want: "1.4"},
		{name: "trailing newline", output: "0.142.1\n", want: "0.142.1"},
		{name: "no version token", output: "Claude Code", want: ""},
		{name: "empty", output: "", want: ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := parseCLIVersion(tc.output); got != tc.want {
				t.Fatalf("parseCLIVersion(%q) = %q, want %q", tc.output, got, tc.want)
			}
		})
	}
}

func TestParseCodexCLIVersionPrefersWrappedOpenAICodexVersion(t *testing.T) {
	output := "@vendor/codex-compatible 0.0.14\n  commit: 9055c14d4b0\n  built:  2026-07-02 11:00:00\n@openai/codex 0.142.5\n"
	if got := parseCodexCLIVersion(output); got != "0.142.5" {
		t.Fatalf("parseCodexCLIVersion() = %q, want 0.142.5", got)
	}
}
