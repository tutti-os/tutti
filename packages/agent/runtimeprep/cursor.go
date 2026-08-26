package runtimeprep

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

const cursorPluginDirEnv = "TUTTI_CURSOR_PLUGIN_DIR"
const cursorPromptContextFileEnv = "TUTTI_CURSOR_PROMPT_CONTEXT_FILE"

const cursorWindowsFileSearchPolicy = `## Windows file-search boundary

- Cursor ACP's built-in Glob and Grep do not reliably execute drive-qualified absolute Windows paths such as C:\... or C:/.... Do not pass those paths as path or target_directory.
- When the target is inside the current session workspace, use a workspace-relative path with Glob or Grep; use . for the workspace root. Treat the session cwd as the workspace root.
- When the target is outside the workspace or a relative conversion is uncertain, use the native terminal with rg or PowerShell and the exact absolute Windows path instead of Glob or Grep.
- If Glob or Grep reports a Windows path or rg error, retry through the relative-path or native-terminal route. Report only files returned by that retry.`

const (
	cursorBackgroundTaskGuardCommand       = `"${CURSOR_PLUGIN_ROOT}/hooks/guard-background-task.sh"`
	cursorBackgroundTaskGuardDeniedMessage = "Tutti's Cursor ACP integration does not support background Task execution. Retry this Task in the foreground without run_in_background=true."
)

// The background Task guard remains dormant. RTK uses a separate Shell-only
// preToolUse hook supported by current Cursor Agent plugin discovery; the Task
// guard must not be treated as protection against detached background Tasks.
const cursorBackgroundTaskGuardScript = `#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

resolve_cursor_node() {
  local invoked="${CURSOR_INVOKED_AS:-}"
  local candidate=""
  local resolved=""

  for name in "$invoked" cursor-agent agent; do
    if [[ -z "$name" ]]; then
      continue
    fi
    candidate="$(command -v "$name" 2>/dev/null || true)"
    if [[ -n "$candidate" ]]; then
      break
    fi
  done

  if [[ -z "$candidate" ]]; then
    return 1
  fi
  if command -v realpath >/dev/null 2>&1; then
    resolved="$(realpath "$candidate")"
  else
    resolved="$candidate"
    if [[ -L "$candidate" ]]; then
      local target
      target="$(readlink "$candidate")"
      if [[ "$target" = /* ]]; then
        resolved="$target"
      else
        resolved="$(cd "$(dirname "$candidate")" && pwd)/$target"
      fi
    fi
  fi

  local node_bin
  node_bin="$(dirname "$resolved")/node"
  if [[ ! -x "$node_bin" ]]; then
    return 1
  fi
  printf '%s\n' "$node_bin"
}

if node_bin="$(resolve_cursor_node)"; then
  payload="$(cat)"
  if output="$(printf '%s' "$payload" | "$node_bin" "$script_dir/guard-background-task.mjs")"; then
    printf '%s\n' "$output"
    exit 0
  fi
fi

# Fail closed when Cursor's bundled Node runtime cannot be located. If this
# dormant hook is enabled in a future compatible ACP runtime, it must never
# silently allow a matched Task to bypass the guard.
printf '%s\n' "{\"permission\":\"deny\",\"user_message\":\"` + cursorBackgroundTaskGuardDeniedMessage + `\"}"
`

const cursorBackgroundTaskGuardJavaScript = `const chunks = [];
for await (const chunk of process.stdin) {
  chunks.push(chunk);
}

const deny = () => ({
  permission: "deny",
  user_message: "` + cursorBackgroundTaskGuardDeniedMessage + `",
});

try {
  const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const input = payload?.tool_input ?? payload?.toolInput;
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    process.stdout.write(JSON.stringify(deny()));
  } else {
    const background = input.run_in_background ?? input.runInBackground;
    process.stdout.write(JSON.stringify(background === true || background === "true" ? deny() : {}));
  }
} catch {
  process.stdout.write(JSON.stringify(deny()));
}
`

type CursorPreparer struct{}

func (CursorPreparer) Provider() string {
	return "cursor"
}

func (CursorPreparer) Prepare(_ context.Context, input ProviderPrepareInput) (ProviderPrepareResult, error) {
	pluginDir := filepath.Join(input.RuntimeRoot, "cursor-plugin", "tutti-cli")
	if err := installCursorTuttiPlugin(pluginDir, input.PrepareInput); err != nil {
		return ProviderPrepareResult{}, err
	}
	if input.Manifest != nil {
		input.Manifest.RecordManagedFile(pluginDir, "provider-plugin", true)
	}
	return ProviderPrepareResult{
		Cwd: input.Cwd,
		Env: []string{
			cursorPluginDirEnv + "=" + pluginDir,
			cursorPromptContextFileEnv + "=" + filepath.Join(pluginDir, "tutti-context.md"),
		},
	}, nil
}

func installCursorTuttiPlugin(pluginDir string, input PrepareInput) error {
	policy, err := tuttiCLIPolicy(input)
	if err != nil {
		return fmt.Errorf("render cursor prompt context: %w", err)
	}
	manifestDir := filepath.Join(pluginDir, ".cursor-plugin")
	if err := os.MkdirAll(manifestDir, 0o700); err != nil {
		return fmt.Errorf("create cursor plugin manifest directory: %w", err)
	}
	manifest := struct {
		Name        string            `json:"name"`
		DisplayName string            `json:"displayName"`
		Version     string            `json:"version"`
		Description string            `json:"description"`
		Author      map[string]string `json:"author"`
		License     string            `json:"license"`
		Skills      string            `json:"skills"`
		Rules       []string          `json:"rules"`
	}{
		Name:        "tutti-cli",
		DisplayName: "Tutti CLI",
		Version:     "0.1.0",
		Description: "Tutti CLI skills for AgentGUI sessions.",
		Author: map[string]string{
			"name": "Tutti",
		},
		License: "UNLICENSED",
		Skills:  "./skills/",
		Rules:   []string{},
	}
	content, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return fmt.Errorf("encode cursor plugin manifest: %w", err)
	}
	if err := os.WriteFile(filepath.Join(manifestDir, "plugin.json"), append(content, '\n'), 0o600); err != nil {
		return fmt.Errorf("write cursor plugin manifest: %w", err)
	}
	skillPaths, err := installProviderNativeSkillsSessionScoped(filepath.Join(pluginDir, "skills"), input)
	if err != nil {
		return fmt.Errorf("install cursor tutti skill plugin: %w", err)
	}
	context := renderProviderPromptContext(cursorPromptPolicy(policy), skillPaths)
	if err := os.WriteFile(filepath.Join(pluginDir, "tutti-context.md"), []byte(context+"\n"), 0o600); err != nil {
		return fmt.Errorf("write cursor prompt context: %w", err)
	}
	if input.RTKSaverMode {
		if err := installCursorRTKHook(filepath.Join(pluginDir, "hooks")); err != nil {
			return err
		}
	}
	return nil
}

func installCursorRTKHook(hooksDir string) error {
	if err := os.MkdirAll(hooksDir, 0o700); err != nil {
		return fmt.Errorf("create cursor RTK hooks directory: %w", err)
	}
	document := map[string]any{
		"version": 1,
		"hooks": map[string]any{
			"preToolUse": []any{map[string]any{
				"matcher": "Shell",
				"command": "rtk hook cursor",
			}},
		},
	}
	content, err := json.MarshalIndent(document, "", "  ")
	if err != nil {
		return fmt.Errorf("encode cursor RTK hooks: %w", err)
	}
	if err := os.WriteFile(filepath.Join(hooksDir, "hooks.json"), append(content, '\n'), 0o600); err != nil {
		return fmt.Errorf("write cursor RTK hooks: %w", err)
	}
	return nil
}

func cursorPromptPolicy(policy string) string {
	return cursorPromptPolicyForGOOS(policy, runtime.GOOS)
}

func cursorPromptPolicyForGOOS(policy string, goos string) string {
	policy = strings.TrimSpace(policy)
	if goos != "windows" {
		return policy
	}
	return strings.TrimSpace(policy + "\n\n" + cursorWindowsFileSearchPolicy)
}

func installCursorBackgroundTaskGuard(hooksDir string) error {
	if err := os.MkdirAll(hooksDir, 0o700); err != nil {
		return fmt.Errorf("create cursor plugin hooks directory: %w", err)
	}
	hooks := struct {
		Version int `json:"version"`
		Hooks   struct {
			PreToolUse []struct {
				Matcher string `json:"matcher"`
				Command string `json:"command"`
			} `json:"preToolUse"`
		} `json:"hooks"`
	}{Version: 1}
	hooks.Hooks.PreToolUse = []struct {
		Matcher string `json:"matcher"`
		Command string `json:"command"`
	}{
		{Matcher: "^Task$", Command: cursorBackgroundTaskGuardCommand},
	}
	content, err := json.MarshalIndent(hooks, "", "  ")
	if err != nil {
		return fmt.Errorf("encode cursor plugin hooks: %w", err)
	}
	if err := os.WriteFile(filepath.Join(hooksDir, "hooks.json"), append(content, '\n'), 0o600); err != nil {
		return fmt.Errorf("write cursor plugin hooks: %w", err)
	}
	if err := os.WriteFile(filepath.Join(hooksDir, "guard-background-task.sh"), []byte(cursorBackgroundTaskGuardScript), 0o700); err != nil {
		return fmt.Errorf("write cursor background Task guard launcher: %w", err)
	}
	if err := os.WriteFile(filepath.Join(hooksDir, "guard-background-task.mjs"), []byte(cursorBackgroundTaskGuardJavaScript), 0o600); err != nil {
		return fmt.Errorf("write cursor background Task guard: %w", err)
	}
	return nil
}
