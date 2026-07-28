package runtimeprep

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

const claudeSystemPromptFileEnv = "TUTTI_CLAUDE_SYSTEM_PROMPT_FILE"
const claudePluginDirEnv = "TUTTI_CLAUDE_PLUGIN_DIR"
const claudeSkillListingBudgetEnv = "SLASH_COMMAND_TOOL_CHAR_BUDGET"
const claudeSkillListingBudgetChars = "20000"

// claudeCodeExecutableEnvName always wins inside the sidecar, even over a
// bundled native SDK binary — it is the operator escape hatch.
const claudeCodeExecutableEnvName = "CLAUDE_CODE_EXECUTABLE"

// claudeCodeFallbackExecutableEnvName is consumed by the sidecar only when the
// SDK cannot resolve a native binary next to itself (the packaged bundle no
// longer vendors one). See packages/agent/claude-sdk-sidecar/src/executablePath.ts.
const claudeCodeFallbackExecutableEnvName = "TUTTI_CLAUDE_CODE_FALLBACK_EXECUTABLE"

// claudeCodeManagedPointerRelPath locates the pointer written by tuttid's
// claude binary provisioner. Contract with
// services/tuttid/service/agentstatus/claude_binary.go — keep in sync.
const claudeCodeManagedPointerRelPath = "agent-providers/claude-code/current.json"

type ClaudeCodePreparer struct {
	// StateDir is the tutti state root that hosts the managed claude binary
	// pointer; empty disables the managed-binary fallback.
	StateDir string
}

func (ClaudeCodePreparer) Provider() string {
	return "claude-code"
}

func (p ClaudeCodePreparer) Prepare(_ context.Context, input ProviderPrepareInput) (ProviderPrepareResult, error) {
	systemPromptPath := filepath.Join(input.RuntimeRoot, "claude-system-prompt.md")
	if err := os.MkdirAll(filepath.Dir(systemPromptPath), 0o700); err != nil {
		return ProviderPrepareResult{}, fmt.Errorf("create claude system prompt directory: %w", err)
	}
	policy, err := tuttiCLIPolicy(input.PrepareInput)
	if err != nil {
		return ProviderPrepareResult{}, err
	}
	systemPrompt := joinPromptSections(
		policy,
		agentConversationDetailModeSystemPromptAppend(input.ConversationDetailMode),
	)
	if err := os.WriteFile(systemPromptPath, []byte(systemPrompt), 0o600); err != nil {
		return ProviderPrepareResult{}, fmt.Errorf("write claude system prompt: %w", err)
	}
	pluginDir := filepath.Join(input.RuntimeRoot, "claude-plugin", "tutti-cli")
	if err := installClaudeTuttiPlugin(pluginDir, input.PrepareInput); err != nil {
		return ProviderPrepareResult{}, err
	}
	if input.Manifest != nil {
		input.Manifest.RecordManagedFile(systemPromptPath, "provider-system-prompt", true)
		input.Manifest.RecordManagedFile(pluginDir, "provider-plugin", true)
	}
	env := []string{
		claudeSystemPromptFileEnv + "=" + systemPromptPath,
		claudePluginDirEnv + "=" + pluginDir,
		claudeSkillListingBudgetEnv + "=" + claudeSkillListingBudgetChars,
	}
	env = append(env, p.claudeCodeExecutableEnv()...)
	env = append(env, modelEndpointClaudeEnv(input.ModelEndpoint)...)
	// Plan mode is enabled through the SDK permission mode selected by the
	// daemon runtime. We intentionally do NOT set
	// CLAUDE_CONFIG_DIR to seed `permissions.defaultMode=plan`: pointing the CLI
	// at a fresh config directory makes it stop reading the user's real
	// credentials (keychain on macOS, ~/.claude/.credentials.json elsewhere),
	// so plan turns fail with "Not logged in · Please run /login" (-32000) for
	// OAuth users while every other mode keeps working. input.PlanMode is left
	// unused here on purpose.
	return ProviderPrepareResult{
		Cwd: input.Cwd,
		Env: env,
	}, nil
}

func installClaudeTuttiPlugin(pluginDir string, input PrepareInput) error {
	manifestDir := filepath.Join(pluginDir, ".claude-plugin")
	if err := os.MkdirAll(manifestDir, 0o700); err != nil {
		return fmt.Errorf("create claude plugin manifest directory: %w", err)
	}
	manifest := map[string]any{
		"name":        "tutti-cli",
		"version":     "0.1.0",
		"description": "Tutti CLI skill for AgentGUI sessions.",
		"author": map[string]string{
			"name": "Tutti",
		},
	}
	content, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return fmt.Errorf("encode claude plugin manifest: %w", err)
	}
	if err := os.WriteFile(filepath.Join(manifestDir, "plugin.json"), append(content, '\n'), 0o600); err != nil {
		return fmt.Errorf("write claude plugin manifest: %w", err)
	}
	if _, err := installProviderNativeSkills(filepath.Join(pluginDir, "skills"), input); err != nil {
		return fmt.Errorf("install claude tutti skill plugin: %w", err)
	}
	return nil
}

// claudeCodeExecutableEnv selects which claude binary the sidecar should
// spawn. An explicit CLAUDE_CODE_EXECUTABLE override is forwarded as-is and
// beats everything. Otherwise a fallback executable is offered — preferred:
// the tuttid-provisioned binary pinned to the vendored SDK version; last
// resort: a PATH-installed claude (version unpinned, but session launch
// already requires one, so it is always present on working setups). The
// sidecar only uses the fallback when the SDK cannot self-resolve a native
// binary next to itself.
func (p ClaudeCodePreparer) claudeCodeExecutableEnv() []string {
	if configured := strings.TrimSpace(os.Getenv(claudeCodeExecutableEnvName)); configured != "" {
		return []string{claudeCodeExecutableEnvName + "=" + configured}
	}
	if managed := p.managedClaudeCodeExecutable(); managed != "" {
		return []string{claudeCodeFallbackExecutableEnvName + "=" + managed}
	}
	claudePath, err := exec.LookPath("claude")
	if err != nil {
		return nil
	}
	return []string{claudeCodeFallbackExecutableEnvName + "=" + claudePath}
}

func (p ClaudeCodePreparer) managedClaudeCodeExecutable() string {
	stateDir := strings.TrimSpace(p.StateDir)
	if stateDir == "" {
		return ""
	}
	pointerPath := filepath.Join(stateDir, filepath.FromSlash(claudeCodeManagedPointerRelPath))
	content, err := os.ReadFile(pointerPath)
	if err != nil {
		return ""
	}
	// The pointer version is intentionally NOT validated against the app's
	// vendored SDK here. Right after an app update, the pointer briefly
	// references the previous release's binary until tuttid's background
	// provisioning repoints it — and a binary one release behind is a strictly
	// better fallback than the PATH claude of arbitrary age this would
	// otherwise degrade to. The SDK↔CLI protocol tolerates that skew by
	// design (pathToClaudeCodeExecutable exists for externally-installed,
	// unpinned CLIs).
	var pointer struct {
		Executable string `json:"executable"`
	}
	if err := json.Unmarshal(content, &pointer); err != nil {
		return ""
	}
	executable := strings.TrimSpace(pointer.Executable)
	if executable == "" {
		return ""
	}
	info, err := os.Stat(executable)
	if err != nil || info.IsDir() {
		return ""
	}
	// Windows file modes never expose Unix execute bits; only gate on them
	// where they exist.
	if runtime.GOOS != "windows" && info.Mode().Perm()&0o111 == 0 {
		return ""
	}
	return executable
}
