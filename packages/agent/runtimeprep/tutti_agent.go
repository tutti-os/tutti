package runtimeprep

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

const (
	tuttiAgentLLMProviderID     = "tutti-llm"
	tuttiAgentDefaultLLMBaseURL = "https://llm-api.tutti.sh/v1"
	tuttiAgentDefaultModel      = "gpt-5.4"
)

// TuttiAgentPreparer materializes the session-scoped TUTTI_AGENT_HOME for the
// tutti-agent provider. Account-token bootstrap remains a host responsibility
// and can be injected through BeforePrepare.
type TuttiAgentPreparer struct {
	BeforePrepare func(context.Context, PrepareInput)
}

func (TuttiAgentPreparer) Provider() string {
	return "tutti-agent"
}

func (p TuttiAgentPreparer) Prepare(ctx context.Context, input ProviderPrepareInput) (ProviderPrepareResult, error) {
	home := filepath.Join(input.RuntimeRoot, "tutti-agent-home")
	logRuntimePrepareTrace("runtime_prepare.tutti_agent.entered", input.PrepareInput, nil)
	if p.BeforePrepare != nil {
		p.BeforePrepare(ctx, input.PrepareInput)
	}
	if err := PrepareTuttiAgentHome(home, input.PrepareInput); err != nil {
		return ProviderPrepareResult{}, err
	}
	logRuntimePrepareTrace("runtime_prepare.tutti_agent.home_prepared", input.PrepareInput, nil)
	instructionsPath := filepath.Join(home, "AGENTS.md")
	writeResult, err := input.Store.WriteManagedBlock(instructionsPath, tuttiCLIPolicy(input.PrepareInput))
	if err != nil {
		return ProviderPrepareResult{}, err
	}
	if input.Manifest != nil {
		input.Manifest.RecordManagedFile(instructionsPath, "provider-instructions", writeResult.Created)
		input.Manifest.RecordManagedFile(home, "tutti-agent-home", true)
	}
	logRuntimePrepareTrace("runtime_prepare.tutti_agent.resolved", input.PrepareInput, nil)
	env := []string{"TUTTI_AGENT_HOME=" + home}
	if input.ModelEndpoint.supportsCodex() {
		env = append(env, codexModelPlanAPIKeyEnv+"="+input.ModelEndpoint.APIKey)
	}
	return ProviderPrepareResult{
		Cwd: input.Cwd,
		Env: env,
	}, nil
}

// PrepareTuttiAgentHome materializes a TUTTI_AGENT_HOME with the user's auth
// exposed and a session-safe config pinned to the Tutti LLM gateway.
func PrepareTuttiAgentHome(home string, input PrepareInput) error {
	if err := os.MkdirAll(home, 0o700); err != nil {
		return fmt.Errorf("create tutti-agent home: %w", err)
	}
	if err := exposeUserTuttiAgentFiles(home); err != nil {
		return err
	}
	return ensureTuttiAgentSessionConfig(filepath.Join(home, "config.toml"), input)
}

func exposeUserTuttiAgentFiles(home string) error {
	userHome, err := os.UserHomeDir()
	if err != nil || strings.TrimSpace(userHome) == "" {
		return nil
	}
	userAgentHome := filepath.Join(userHome, ".tutti-agent")
	source := filepath.Join(userAgentHome, "auth.json")
	if _, err := os.Stat(source); err == nil {
		target := filepath.Join(home, "auth.json")
		if _, err := os.Lstat(target); os.IsNotExist(err) {
			if err := os.Symlink(source, target); err != nil {
				return fmt.Errorf("expose tutti-agent auth.json: %w", err)
			}
		}
	}
	target := filepath.Join(home, "config.toml")
	if _, err := os.Lstat(target); os.IsNotExist(err) {
		userConfig := filepath.Join(userAgentHome, "config.toml")
		if _, err := os.Stat(userConfig); err == nil {
			if err := copyFile(userConfig, target, 0o600); err != nil {
				return fmt.Errorf("copy tutti-agent config: %w", err)
			}
		}
	}
	return nil
}

func ensureTuttiAgentSessionConfig(configPath string, input PrepareInput) error {
	contentBytes, err := os.ReadFile(configPath)
	if err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("read tutti-agent config: %w", err)
	}
	next, changed := codexConfigWithProjectRootMarkersDisabled(string(contentBytes))
	if tuttiNext, tuttiChanged := codexConfigWithTuttiConversationDetailMode(next, input.ConversationDetailMode); tuttiChanged {
		next = tuttiNext
		changed = true
	}
	if detailModeNext, detailModeChanged := codexConfigWithConversationDetailModeInstructions(next, input.ConversationDetailMode); detailModeChanged {
		next = detailModeNext
		changed = true
	}
	if providerNext, providerChanged := tuttiAgentConfigWithLLMProvider(next); providerChanged {
		next = providerNext
		changed = true
	}
	if storageNext, storageChanged := tuttiAgentConfigWithRootValue(next, "cli_auth_credentials_store", "file", false); storageChanged {
		next = storageNext
		changed = true
	}
	if planNext, planChanged := codexConfigWithModelPlanEndpoint(next, input.ModelEndpoint); planChanged {
		next = planNext
		changed = true
	}
	if !changed {
		return nil
	}
	if err := os.WriteFile(configPath, []byte(next), 0o600); err != nil {
		return fmt.Errorf("write tutti-agent config: %w", err)
	}
	return nil
}

func tuttiAgentConfigWithLLMProvider(content string) (string, bool) {
	changed := false
	content, changed = tuttiAgentConfigWithRootValue(content, "model_provider", tuttiAgentLLMProviderID, changed)
	content, changed = tuttiAgentConfigWithRootValue(content, "model", tuttiAgentDefaultModel, changed)
	sectionHeader := "[model_providers." + tuttiAgentLLMProviderID + "]"
	if !strings.Contains(content, sectionHeader) {
		block := sectionHeader + "\n" +
			`name = "Tutti LLM"` + "\n" +
			`base_url = ` + strconv.Quote(tuttiAgentLLMBaseURL()) + "\n" +
			`wire_api = "responses"` + "\n"
		if strings.TrimSpace(content) == "" {
			content = block
		} else {
			content = strings.TrimRight(content, "\r\n") + "\n\n" + block
		}
		changed = true
	}
	return content, changed
}

func tuttiAgentConfigWithRootValue(content string, key string, value string, changed bool) (string, bool) {
	line := key + " = " + strconv.Quote(value)
	normalized := strings.ReplaceAll(content, "\r\n", "\n")
	lines := strings.Split(normalized, "\n")
	for index, current := range lines {
		trimmed := strings.TrimSpace(current)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		if strings.HasPrefix(trimmed, "[") {
			lines = append(lines[:index], append([]string{line}, lines[index:]...)...)
			return strings.Join(lines, "\n"), true
		}
		if codexConfigLineHasKey(trimmed, key) {
			if strings.TrimSpace(current) == line {
				return content, changed
			}
			lines[index] = line
			return strings.Join(lines, "\n"), true
		}
	}
	if strings.TrimSpace(content) == "" {
		return line + "\n", true
	}
	return line + "\n" + strings.TrimLeft(normalized, "\n"), true
}

func tuttiAgentLLMBaseURL() string {
	if value := strings.TrimSpace(os.Getenv("TUTTI_AGENT_LLM_BASE_URL")); value != "" {
		return value
	}
	return tuttiAgentDefaultLLMBaseURL
}
