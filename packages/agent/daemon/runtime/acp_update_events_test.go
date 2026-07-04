package agentruntime

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestPromptTitleSnippetKeepsLongMultibytePromptUseful(t *testing.T) {
	long := strings.Repeat("春江潮水连海平", 24)

	got := promptTitleSnippet(long)
	if !utf8.ValidString(got) {
		t.Fatalf("promptTitleSnippet() = %q is not valid UTF-8", got)
	}
	if runes := utf8.RuneCountInString(strings.TrimSuffix(got, "...")); runes != 160 {
		t.Fatalf("promptTitleSnippet() title rune count = %d, want 160", runes)
	}
	if !strings.HasSuffix(got, "...") {
		t.Fatalf("promptTitleSnippet() = %q, want ellipsis for truncated title", got)
	}
}
