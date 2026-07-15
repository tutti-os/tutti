package titletext

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestNormalize(t *testing.T) {
	data, err := os.ReadFile("../../titletext-fixtures.json")
	if err != nil {
		t.Fatalf("read shared title fixtures: %v", err)
	}
	var tests []struct {
		Name       string `json:"name"`
		Input      string `json:"input"`
		Normalized string `json:"normalized"`
	}
	if err := json.Unmarshal(data, &tests); err != nil {
		t.Fatalf("decode shared title fixtures: %v", err)
	}
	for _, test := range tests {
		t.Run(test.Name, func(t *testing.T) {
			if got := Normalize(test.Input); got != test.Normalized {
				t.Fatalf("Normalize(%q) = %q, want %q", test.Input, got, test.Normalized)
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
