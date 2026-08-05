package runtimeprep

import (
	"runtime"
	"strings"
	"testing"
)

func TestCodexConfigWithTuttiWindowsSandboxPinsUnelevated(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows session config policy")
	}

	got, changed := codexConfigWithTuttiWindowsSandbox(`model = "gpt-5.6-luna"

[windows]
sandbox = "elevated"

[tutti]
conversationDetailMode = "coding"
`)
	if !changed {
		t.Fatal("changed = false, want true")
	}
	if want := `sandbox = "unelevated"`; !containsConfigLine(got, want) {
		t.Fatalf("config missing %q:\n%s", want, got)
	}
	if containsConfigLine(got, `sandbox = "elevated"`) {
		t.Fatalf("config retained elevated sandbox:\n%s", got)
	}
}

func TestCodexConfigWithTuttiWindowsSandboxAddsSection(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows session config policy")
	}

	got, changed := codexConfigWithTuttiWindowsSandbox("model = \"gpt-5.6-luna\"\n")
	if !changed {
		t.Fatal("changed = false, want true")
	}
	if want := "[windows]\nsandbox = \"unelevated\""; !containsConfigBlock(got, want) {
		t.Fatalf("config missing Windows sandbox block %q:\n%s", want, got)
	}
}

func TestCodexConfigWithTuttiWindowsSandboxIsIdempotent(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows session config policy")
	}

	content := "[windows]\nsandbox = \"unelevated\"\n"
	got, changed := codexConfigWithTuttiWindowsSandbox(content)
	if changed {
		t.Fatal("changed = true, want false")
	}
	if got != content {
		t.Fatalf("content changed:\ngot:\n%s\nwant:\n%s", got, content)
	}
}

func containsConfigLine(content, line string) bool {
	for _, candidate := range strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n") {
		if candidate == line {
			return true
		}
	}
	return false
}

func containsConfigBlock(content, block string) bool {
	return strings.Contains(content, block)
}
