package runtimeprep

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestCursorBackgroundTaskGuardAllowsForegroundAndDeniesBackground(t *testing.T) {
	nodePath, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is required to execute the generated Cursor hook")
	}

	pluginDir := t.TempDir()
	if err := installCursorBackgroundTaskGuard(filepath.Join(pluginDir, "hooks")); err != nil {
		t.Fatalf("installCursorBackgroundTaskGuard() error = %v", err)
	}
	hookPath := filepath.Join(pluginDir, "hooks", "guard-background-task.mjs")

	tests := []struct {
		name       string
		input      string
		wantDenied bool
	}{
		{
			name:       "foreground omitted",
			input:      `{"tool_name":"Task","tool_input":{"prompt":"run_in_background=true is mentioned only as text"}}`,
			wantDenied: false,
		},
		{
			name:       "foreground false",
			input:      `{"tool_name":"Task","tool_input":{"run_in_background":false}}`,
			wantDenied: false,
		},
		{
			name:       "background snake case",
			input:      `{"tool_name":"Task","tool_input":{"run_in_background":true}}`,
			wantDenied: true,
		},
		{
			name:       "background camel case",
			input:      `{"toolName":"Task","toolInput":{"runInBackground":true}}`,
			wantDenied: true,
		},
		{
			name:       "invalid payload fails closed",
			input:      `{`,
			wantDenied: true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			command := exec.Command(nodePath, hookPath)
			command.Stdin = strings.NewReader(tt.input)
			output, err := command.Output()
			if err != nil {
				t.Fatalf("generated hook error = %v", err)
			}
			var response struct {
				Permission  string `json:"permission"`
				UserMessage string `json:"user_message"`
			}
			if err := json.Unmarshal(output, &response); err != nil {
				t.Fatalf("generated hook output = %q: %v", output, err)
			}
			if tt.wantDenied {
				if response.Permission != "deny" || response.UserMessage != cursorBackgroundTaskGuardDeniedMessage {
					t.Fatalf("generated hook response = %#v, want background denial", response)
				}
			} else if response.Permission != "" || response.UserMessage != "" {
				t.Fatalf("generated hook response = %#v, want empty allow response", response)
			}
		})
	}
}

func TestCursorPromptPolicyUsesRelativeSearchRootsOnWindows(t *testing.T) {
	base := "base runtime policy"
	windowsPolicy := cursorPromptPolicyForGOOS(base, "windows")
	for _, expected := range []string{
		"## Windows file-search boundary",
		"drive-qualified absolute Windows paths",
		"workspace-relative path",
		"native terminal",
		"retry through the relative-path or native-terminal route",
	} {
		if !strings.Contains(windowsPolicy, expected) {
			t.Fatalf("Windows Cursor policy missing %q: %s", expected, windowsPolicy)
		}
	}
	if got := cursorPromptPolicyForGOOS(base, "linux"); got != base {
		t.Fatalf("non-Windows Cursor policy = %q, want unchanged base policy", got)
	}
}

func TestCursorBackgroundTaskGuardLauncherUsesCursorBundledNode(t *testing.T) {
	nodePath, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is required to execute the generated Cursor hook")
	}

	pluginDir := t.TempDir()
	if err := installCursorBackgroundTaskGuard(filepath.Join(pluginDir, "hooks")); err != nil {
		t.Fatalf("installCursorBackgroundTaskGuard() error = %v", err)
	}
	installDir := filepath.Join(t.TempDir(), "cursor-version")
	binDir := filepath.Join(t.TempDir(), "bin")
	if err := os.MkdirAll(installDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(binDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(nodePath, filepath.Join(installDir, "node")); err != nil {
		t.Fatal(err)
	}
	cursorPath := filepath.Join(installDir, "cursor-agent")
	if err := os.WriteFile(cursorPath, []byte("#!/usr/bin/env bash\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(cursorPath, filepath.Join(binDir, "cursor-agent")); err != nil {
		t.Fatal(err)
	}

	launcherPath := filepath.Join(pluginDir, "hooks", "guard-background-task.sh")
	for _, tt := range []struct {
		name       string
		input      string
		wantDenied bool
	}{
		{name: "foreground", input: `{"tool_name":"Task","tool_input":{"run_in_background":false}}`},
		{name: "background", input: `{"tool_name":"Task","tool_input":{"run_in_background":true}}`, wantDenied: true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			command := exec.Command(launcherPath)
			command.Stdin = strings.NewReader(tt.input)
			command.Env = append(os.Environ(),
				"CURSOR_INVOKED_AS=cursor-agent",
				"PATH="+binDir+string(os.PathListSeparator)+os.Getenv("PATH"),
			)
			output, err := command.Output()
			if err != nil {
				t.Fatalf("generated launcher error = %v", err)
			}
			denied := strings.Contains(string(output), `"permission":"deny"`)
			if denied != tt.wantDenied {
				t.Fatalf("generated launcher output = %q, denied = %v want %v", output, denied, tt.wantDenied)
			}
		})
	}
}

func TestCursorBackgroundTaskGuardLauncherFailsClosedWithoutCursorNode(t *testing.T) {
	bashPath, err := exec.LookPath("bash")
	if err != nil {
		t.Skip("bash is required to execute the generated Cursor hook launcher")
	}

	pluginDir := t.TempDir()
	if err := installCursorBackgroundTaskGuard(filepath.Join(pluginDir, "hooks")); err != nil {
		t.Fatalf("installCursorBackgroundTaskGuard() error = %v", err)
	}
	binDir := t.TempDir()
	if err := os.Symlink(bashPath, filepath.Join(binDir, "bash")); err != nil {
		t.Fatal(err)
	}

	launcherPath := filepath.Join(pluginDir, "hooks", "guard-background-task.sh")
	command := exec.Command(launcherPath)
	command.Stdin = strings.NewReader(`{"tool_name":"Task","tool_input":{"run_in_background":false}}`)
	command.Env = append(os.Environ(),
		"CURSOR_INVOKED_AS=missing-cursor-agent",
		"PATH="+strings.Join([]string{binDir, "/usr/bin", "/bin"}, string(os.PathListSeparator)),
	)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("generated launcher error = %v output = %q", err, output)
	}
	if !strings.Contains(string(output), `"permission":"deny"`) ||
		!strings.Contains(string(output), cursorBackgroundTaskGuardDeniedMessage) {
		t.Fatalf("generated launcher output = %q, want fail-closed denial", output)
	}
}
