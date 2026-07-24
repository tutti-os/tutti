package runtimeprep

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// TuttiAgentPreparer materializes the session-scoped TUTTI_AGENT_HOME for the
// tutti-agent provider. Account-token bootstrap remains a host responsibility
// and can be injected through BeforePrepare.
type TuttiAgentPreparer struct {
	BeforePrepare     func(context.Context, PrepareInput)
	ResolveAuthSource func(context.Context, PrepareInput) (string, error)
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
	authSource := ""
	authSourceConfigured := p.ResolveAuthSource != nil
	if authSourceConfigured {
		resolved, err := p.ResolveAuthSource(ctx, input.PrepareInput)
		if err != nil {
			return ProviderPrepareResult{}, fmt.Errorf("resolve tutti-agent auth source: %w", err)
		}
		authSource = strings.TrimSpace(resolved)
	}
	if err := prepareTuttiAgentHome(home, input.PrepareInput, authSource, authSourceConfigured); err != nil {
		return ProviderPrepareResult{}, err
	}
	if _, err := installProviderNativeSkills(filepath.Join(home, "skills"), input.PrepareInput); err != nil {
		return ProviderPrepareResult{}, fmt.Errorf("install tutti-agent native skills: %w", err)
	}
	logRuntimePrepareTrace("runtime_prepare.tutti_agent.home_prepared", input.PrepareInput, nil)
	instructionsPath := filepath.Join(home, "AGENTS.md")
	policy, err := tuttiCLIPolicy(input.PrepareInput)
	if err != nil {
		return ProviderPrepareResult{}, err
	}
	writeResult, err := input.Store.WriteManagedBlock(instructionsPath, policy)
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
// exposed and session-safe host policy. Provider and model selection remain
// owned by tutti-agent and the per-session launch request. Session Skills are
// installed only by TuttiAgentPreparer after capabilities resolve.
func PrepareTuttiAgentHome(home string, input PrepareInput) error {
	return prepareTuttiAgentHome(home, input, "", false)
}

func prepareTuttiAgentHome(home string, input PrepareInput, authSource string, authSourceConfigured bool) error {
	if err := os.MkdirAll(home, 0o700); err != nil {
		return fmt.Errorf("create tutti-agent home: %w", err)
	}
	if err := exposeUserTuttiAgentFiles(home, authSource, authSourceConfigured); err != nil {
		return err
	}
	return ensureTuttiAgentSessionConfig(filepath.Join(home, "config.toml"), input, authSourceConfigured)
}

func exposeUserTuttiAgentFiles(home string, explicitAuthSource string, explicitAuthSourceConfigured bool) error {
	if explicitAuthSourceConfigured {
		if explicitAuthSource == "" {
			return nil
		}
		if !filepath.IsAbs(explicitAuthSource) {
			return fmt.Errorf("tutti-agent auth source must be absolute")
		}
		return exposeTuttiAgentAuth(home, filepath.Clean(explicitAuthSource), true)
	}
	userHome, err := os.UserHomeDir()
	if err != nil || strings.TrimSpace(userHome) == "" {
		return nil
	}
	userAgentHome := filepath.Join(userHome, ".tutti-agent")
	source := filepath.Join(userAgentHome, "auth.json")
	if err := exposeTuttiAgentAuth(home, source, false); err != nil {
		return err
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

func exposeTuttiAgentAuth(home string, source string, allowMissingSource bool) error {
	if !allowMissingSource {
		if _, err := os.Stat(source); err != nil {
			if os.IsNotExist(err) {
				return nil
			}
			return fmt.Errorf("stat tutti-agent auth source: %w", err)
		}
	}
	target := filepath.Join(home, "auth.json")
	if current, err := os.Readlink(target); err == nil {
		if current == source {
			return nil
		}
		return fmt.Errorf("tutti-agent auth target already links to a different source")
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("inspect tutti-agent auth target: %w", err)
	}
	if err := os.Symlink(source, target); err != nil {
		return fmt.Errorf("expose tutti-agent auth.json: %w", err)
	}
	return nil
}

func ensureTuttiAgentSessionConfig(configPath string, input PrepareInput, managedHome bool) error {
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
	if managedHome {
		if cleaned, cleanedChanged := tuttiAgentConfigWithoutLegacyPinnedProvider(next); cleanedChanged {
			next = cleaned
			changed = true
		}
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

// tuttiAgentConfigWithoutLegacyPinnedProvider removes only the exact
// host-generated provider signature shipped by older runtimeprep releases.
// User-owned provider/model settings are otherwise preserved.
func tuttiAgentConfigWithoutLegacyPinnedProvider(content string) (string, bool) {
	normalized := strings.ReplaceAll(content, "\r\n", "\n")
	for _, signature := range []string{
		`model_provider = "tutti-llm"`,
		`model = "gpt-5.4"`,
		`[model_providers.tutti-llm]`,
		`name = "Tutti LLM"`,
		`base_url = "https://llm-api.tutti.sh/v1"`,
		`wire_api = "responses"`,
	} {
		if !strings.Contains(normalized, signature) {
			return content, false
		}
	}
	if strings.Count(normalized, `[model_providers.tutti-llm]`) != 1 {
		return content, false
	}
	lines := strings.Split(normalized, "\n")
	result := make([]string, 0, len(lines))
	inLegacyProvider := false
	changed := false
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "[") {
			inLegacyProvider = trimmed == `[model_providers.tutti-llm]`
			if inLegacyProvider {
				changed = true
				continue
			}
		}
		if inLegacyProvider {
			continue
		}
		if trimmed == `model_provider = "tutti-llm"` || trimmed == `model = "gpt-5.4"` {
			changed = true
			continue
		}
		result = append(result, line)
	}
	if !changed {
		return content, false
	}
	return strings.TrimSpace(strings.Join(result, "\n")) + "\n", true
}
