package runtimeprep

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestEnsureRTKInstructionsReferenceFirst(t *testing.T) {
	instructionsPath := filepath.Join(t.TempDir(), "AGENTS.md")
	if err := os.WriteFile(instructionsPath, []byte("user instructions\n\nmanaged instructions\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	rtkPath := filepath.Join(t.TempDir(), "rtk", "RTK.md")
	input := PrepareInput{RTKSaverMode: true, rtkInstructionsPath: rtkPath}
	for range 2 {
		if err := ensureRTKInstructionsReferenceFirst(instructionsPath, input); err != nil {
			t.Fatal(err)
		}
	}
	content, err := os.ReadFile(instructionsPath)
	if err != nil {
		t.Fatal(err)
	}
	reference := "@" + rtkPath
	if !strings.HasPrefix(string(content), reference+"\n\n") {
		t.Fatalf("AGENTS.md = %q, want RTK reference first", content)
	}
	if got := strings.Count(string(content), reference); got != 1 {
		t.Fatalf("AGENTS.md contains RTK reference %d times, want 1: %q", got, content)
	}
}

func TestEnsureRTKInstructionsReferenceFirstPreservesWindowsPath(t *testing.T) {
	instructionsPath := filepath.Join(t.TempDir(), "AGENTS.md")
	if err := os.WriteFile(instructionsPath, []byte("instructions\r\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	input := PrepareInput{
		RTKSaverMode:        true,
		rtkInstructionsPath: `C:\Users\Test User\AppData\Local\Tutti\agent\runs\session-1\rtk\RTK.md`,
	}
	if err := ensureRTKInstructionsReferenceFirst(instructionsPath, input); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(instructionsPath)
	if err != nil {
		t.Fatal(err)
	}
	want := `@C:\Users\Test User\AppData\Local\Tutti\agent\runs\session-1\rtk\RTK.md`
	if !strings.HasPrefix(string(content), want+"\r\n\r\n") {
		t.Fatalf("AGENTS.md = %q, want Windows RTK reference %q first", content, want)
	}
}

func TestEnsureRTKInstructionsReferenceFirstNoopWhenDisabled(t *testing.T) {
	instructionsPath := filepath.Join(t.TempDir(), "AGENTS.md")
	const original = "instructions\n"
	if err := os.WriteFile(instructionsPath, []byte(original), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := ensureRTKInstructionsReferenceFirst(instructionsPath, PrepareInput{}); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(instructionsPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != original {
		t.Fatalf("AGENTS.md = %q, want unchanged %q", content, original)
	}
}
