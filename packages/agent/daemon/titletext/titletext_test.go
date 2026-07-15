package titletext

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestNormalize(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{name: "plain text", input: "  hello   world ", want: "hello world"},
		{name: "file path with spaces", input: "[@renderer.js](/Users/Sun/first cc/renderer.js)", want: "@renderer.js"},
		{name: "href with parentheses", input: "[report](file:///tmp/a_(final).md)", want: "report"},
		{name: "escaped label", input: `[a\[b\]](https://example.com)`, want: "a[b]"},
		{name: "unmatched link stays readable", input: "[not a link](missing", want: "[not a link](missing"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := Normalize(test.input); got != test.want {
				t.Fatalf("Normalize(%q) = %q, want %q", test.input, got, test.want)
			}
		})
	}
}

func TestDeriveInitialCanonicalizesVisiblePrompt(t *testing.T) {
	got := DeriveInitial("", "  [@task](mention://workspace-issue/1)   inspect repo.  ")
	if got != "@task inspect repo." {
		t.Fatalf("DeriveInitial() = %q, want canonical prompt title", got)
	}
}

func TestDeriveInitialDoesNotReplaceConversationTitle(t *testing.T) {
	if got := DeriveInitial("Existing title", "new prompt"); got != "" {
		t.Fatalf("DeriveInitial() = %q, want no replacement", got)
	}
}

func TestDeriveInitialLimitsCanonicalTitleLength(t *testing.T) {
	got := DeriveInitial("", strings.Repeat("春", MaxSessionTitleRunes+10))
	if runes := utf8.RuneCountInString(got); runes != MaxSessionTitleRunes {
		t.Fatalf("DeriveInitial() rune count = %d, want %d", runes, MaxSessionTitleRunes)
	}
	if !strings.HasSuffix(got, "...") {
		t.Fatalf("DeriveInitial() = %q, want ellipsis", got)
	}
}

func TestIsLegacyPlaceholderUsesProviderAndTargetIdentity(t *testing.T) {
	for _, title := range []string{"", "claude-code", "Claude Code", " claude "} {
		if !IsLegacyPlaceholder(title, "claude-code") {
			t.Fatalf("IsLegacyPlaceholder(%q) = false, want true", title)
		}
	}
	if !IsLegacyPlaceholder("Gemini", "acp:gemini", "Gemini") {
		t.Fatal("IsLegacyPlaceholder() did not accept target display name")
	}
	if IsLegacyPlaceholder("Inspect repository", "claude-code") {
		t.Fatal("IsLegacyPlaceholder() accepted conversation title")
	}
}
