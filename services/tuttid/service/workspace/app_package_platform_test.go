package workspace

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestAppPackageScriptCommandWindowsShellPrefersGitBash(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("windows shell command resolution test")
	}

	programFiles := t.TempDir()
	gitBash := filepath.Join(programFiles, "Git", "bin", "bash.exe")
	if err := os.MkdirAll(filepath.Dir(gitBash), 0o755); err != nil {
		t.Fatalf("MkdirAll(git bash dir) error = %v", err)
	}
	if err := os.WriteFile(gitBash, []byte{}, 0o644); err != nil {
		t.Fatalf("WriteFile(git bash) error = %v", err)
	}
	t.Setenv("ProgramFiles", programFiles)
	t.Setenv("ProgramFiles(x86)", "")

	scriptPath := `C:\Users\jonny\.tutti-dev\apps\packages\ai-slide\0.1.23\bootstrap.sh`
	command, args := appPackageScriptCommand(scriptPath)
	if command != gitBash {
		t.Fatalf("command = %q, want %q", command, gitBash)
	}
	if len(args) != 1 || args[0] != "C:/Users/jonny/.tutti-dev/apps/packages/ai-slide/0.1.23/bootstrap.sh" {
		t.Fatalf("args = %#v, want normalized shell script path", args)
	}
}
