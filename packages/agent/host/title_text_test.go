package agenthost

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestNormalizeTitle(t *testing.T) {
	data, err := os.ReadFile("../titletext-fixtures.json")
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
			if got := NormalizeTitle(test.Input); got != test.Normalized {
				t.Fatalf("NormalizeTitle(%q) = %q, want %q", test.Input, got, test.Normalized)
			}
		})
	}
}

func TestDeriveInitialCanonicalizesVisiblePrompt(t *testing.T) {
	got := DeriveInitialTitle("", "  [@task](mention://workspace-issue/1)   inspect repo.  ")
	if got != "@task inspect repo." {
		t.Fatalf("DeriveInitialTitle() = %q, want canonical prompt title", got)
	}
}

func TestDeriveInitialDoesNotReplaceConversationTitle(t *testing.T) {
	if got := DeriveInitialTitle("Existing title", "new prompt"); got != "" {
		t.Fatalf("DeriveInitialTitle() = %q, want no replacement", got)
	}
}

func TestDeriveInitialLimitsCanonicalTitleLength(t *testing.T) {
	got := DeriveInitialTitle("", strings.Repeat("春", MaxSessionTitleRunes+10))
	if runes := utf8.RuneCountInString(got); runes != MaxSessionTitleRunes {
		t.Fatalf("DeriveInitialTitle() rune count = %d, want %d", runes, MaxSessionTitleRunes)
	}
	if !strings.HasSuffix(got, "...") {
		t.Fatalf("DeriveInitialTitle() = %q, want ellipsis", got)
	}
}

func TestIsLegacyPlaceholderUsesProviderAndTargetIdentity(t *testing.T) {
	for _, title := range []string{"", "claude-code", "Claude Code", " claude "} {
		if !IsLegacyTitlePlaceholder(title, "claude-code") {
			t.Fatalf("IsLegacyTitlePlaceholder(%q) = false, want true", title)
		}
	}
	if !IsLegacyTitlePlaceholder("Gemini", "acp:gemini", "Gemini") {
		t.Fatal("IsLegacyTitlePlaceholder() did not accept target display name")
	}
	if IsLegacyTitlePlaceholder("Inspect repository", "claude-code") {
		t.Fatal("IsLegacyTitlePlaceholder() accepted conversation title")
	}
}
