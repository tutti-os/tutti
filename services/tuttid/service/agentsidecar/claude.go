package agentsidecar

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

const claudeSystemPromptFileEnv = "TUTTI_CLAUDE_SYSTEM_PROMPT_FILE"
const claudePluginDirEnv = "TUTTI_CLAUDE_PLUGIN_DIR"
const claudeSkillListingBudgetEnv = "SLASH_COMMAND_TOOL_CHAR_BUDGET"
const claudeSkillListingBudgetChars = "20000"

type ClaudeCodePreparer struct{}

func (ClaudeCodePreparer) Provider() string {
	return "claude-code"
}

func (ClaudeCodePreparer) Prepare(_ context.Context, input ProviderPrepareInput) (ProviderPrepareResult, error) {
	systemPromptPath := filepath.Join(input.RuntimeRoot, "claude-system-prompt.md")
	if err := os.MkdirAll(filepath.Dir(systemPromptPath), 0o700); err != nil {
		return ProviderPrepareResult{}, fmt.Errorf("create claude system prompt directory: %w", err)
	}
	systemPrompt := joinPromptSections(
		tuttiCLIPolicy(input.PrepareInput),
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
	if claudeExecutableEnv := claudeCodeExecutableEnv(); claudeExecutableEnv != "" {
		env = append(env, claudeExecutableEnv)
	}
	// Plan mode is enabled exclusively through the ACP `set_mode("plan")` call
	// (see effectiveModeID in the daemon runtime). We intentionally do NOT set
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

func claudeCodeExecutableEnv() string {
	if configured := strings.TrimSpace(os.Getenv("CLAUDE_CODE_EXECUTABLE")); configured != "" {
		return "CLAUDE_CODE_EXECUTABLE=" + configured
	}
	claudePath, err := exec.LookPath("claude")
	if err != nil {
		return ""
	}
	return "CLAUDE_CODE_EXECUTABLE=" + claudePath
}
