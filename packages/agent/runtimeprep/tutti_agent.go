package runtimeprep

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// TuttiAgentPreparer materializes the session-scoped TUTTI_AGENT_HOME for the
// tutti-agent provider. Account-token bootstrap remains a host responsibility
// and can be injected through BeforePrepare.
type TuttiAgentPreparer struct {
	BeforePrepare               func(context.Context, PrepareInput)
	ResolveAuthSource           func(context.Context, PrepareInput) (string, error)
	StableSkillBundleRoot       string
	StableSystemSkillBundleRoot string
	AuthProjector               AuthFileProjector
}

func (TuttiAgentPreparer) Provider() string {
	return "tutti-agent"
}

func (p TuttiAgentPreparer) Prepare(ctx context.Context, input ProviderPrepareInput) (result ProviderPrepareResult, err error) {
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
	cleanup, err := prepareTuttiAgentHomeWithProjector(ctx, home, input.PrepareInput, authSource, authSourceConfigured, p.AuthProjector)
	if err != nil {
		return ProviderPrepareResult{}, err
	}
	defer func() {
		if err != nil && cleanup != nil {
			err = errors.Join(err, cleanup(ctx))
		}
	}()
	var extraSkillRoots []string
	if !input.SkipSkills {
		extraSkillRoots, err = connectorSkillRoots(input.ConnectorRoutingHints)
		if err != nil {
			return ProviderPrepareResult{}, err
		}
		if strings.TrimSpace(p.StableSkillBundleRoot) == "" {
			if _, err := installProviderNativeSkillsSessionScoped(filepath.Join(home, "skills"), input.PrepareInput); err != nil {
				return ProviderPrepareResult{}, fmt.Errorf("install tutti-agent native skills: %w", err)
			}
		} else {
			root, err := materializeStableProviderSkills(p.StableSkillBundleRoot, input.PrepareInput)
			if err != nil {
				return ProviderPrepareResult{}, fmt.Errorf("materialize tutti-agent stable skills: %w", err)
			}
			if root != "" {
				extraSkillRoots = append([]string{root}, extraSkillRoots...)
			}
		}
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
	if len(extraSkillRoots) > 0 {
		encodedRoots, err := json.Marshal(extraSkillRoots)
		if err != nil {
			return ProviderPrepareResult{}, fmt.Errorf("encode tutti-agent extra skill roots: %w", err)
		}
		env = append(env, "TUTTI_AGENT_EXTRA_SKILL_ROOTS_JSON="+string(encodedRoots))
	}
	if !input.SkipSkills {
		if root := strings.TrimSpace(p.StableSystemSkillBundleRoot); root != "" {
			root = filepath.Clean(root)
			if !filepath.IsAbs(root) {
				return ProviderPrepareResult{}, fmt.Errorf("tutti-agent stable system skill bundle root must be absolute")
			}
			env = append(env, "TUTTI_AGENT_STABLE_SYSTEM_SKILLS_ROOT="+root)
		}
	}
	if input.ModelEndpoint.supportsCodex() {
		env = append(env, codexModelPlanAPIKeyEnv+"="+input.ModelEndpoint.APIKey)
	}
	return ProviderPrepareResult{
		Cwd:     input.Cwd,
		Env:     env,
		Cleanup: cleanup,
	}, nil
}

func connectorSkillRoots(hints []ConnectorRoutingHint) ([]string, error) {
	roots := make([]string, 0, len(hints))
	seen := make(map[string]struct{}, len(hints))
	for _, hint := range hints {
		root := strings.TrimSpace(hint.SkillRoot)
		if root == "" {
			continue
		}
		root = filepath.Clean(root)
		if !filepath.IsAbs(root) {
			return nil, fmt.Errorf("connector %q Skill root must be absolute", hint.ConnectorKey)
		}
		info, err := os.Lstat(root)
		if err != nil {
			return nil, fmt.Errorf("inspect connector %q Skill root: %w", hint.ConnectorKey, err)
		}
		if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
			return nil, fmt.Errorf("connector %q Skill root must be a directory, not a symlink", hint.ConnectorKey)
		}
		if _, exists := seen[root]; exists {
			continue
		}
		seen[root] = struct{}{}
		roots = append(roots, root)
	}
	return roots, nil
}

// PrepareTuttiAgentHome materializes a TUTTI_AGENT_HOME with the user's auth
// exposed and session-safe host policy. Provider and model selection remain
// owned by tutti-agent and the per-session launch request. Session Skills are
// installed only by TuttiAgentPreparer after capabilities resolve.
func PrepareTuttiAgentHome(home string, input PrepareInput) error {
	return prepareTuttiAgentHome(home, input, "", false)
}

func prepareTuttiAgentHome(home string, input PrepareInput, authSource string, authSourceConfigured bool) error {
	_, err := prepareTuttiAgentHomeWithProjector(context.Background(), home, input, authSource, authSourceConfigured, nil)
	return err
}

func prepareTuttiAgentHomeWithProjector(ctx context.Context, home string, input PrepareInput, authSource string, authSourceConfigured bool, projector AuthFileProjector) (func(context.Context) error, error) {
	if err := os.MkdirAll(home, 0o700); err != nil {
		return nil, fmt.Errorf("create tutti-agent home: %w", err)
	}
	cleanup, err := exposeUserTuttiAgentFilesWithProjector(ctx, home, authSource, authSourceConfigured, projector)
	if err != nil {
		return nil, err
	}
	if err := ensureTuttiAgentSessionConfig(filepath.Join(home, "config.toml"), input); err != nil {
		return nil, err
	}
	return cleanup, nil
}

func exposeUserTuttiAgentFilesWithProjector(ctx context.Context, home string, explicitAuthSource string, explicitAuthSourceConfigured bool, projector AuthFileProjector) (func(context.Context) error, error) {
	if explicitAuthSourceConfigured {
		if explicitAuthSource == "" {
			return nil, nil
		}
		if !filepath.IsAbs(explicitAuthSource) {
			return nil, fmt.Errorf("tutti-agent auth source must be absolute")
		}
		return exposeTuttiAgentAuthWithProjector(ctx, home, filepath.Clean(explicitAuthSource), true, projector)
	}
	userHome, err := os.UserHomeDir()
	if err != nil || strings.TrimSpace(userHome) == "" {
		return nil, nil
	}
	userAgentHome := filepath.Join(userHome, ".tutti-agent")
	source := filepath.Join(userAgentHome, "auth.json")
	cleanup, err := exposeTuttiAgentAuthWithProjector(ctx, home, source, false, projector)
	if err != nil {
		return nil, err
	}
	target := filepath.Join(home, "config.toml")
	if _, err := os.Lstat(target); os.IsNotExist(err) {
		userConfig := filepath.Join(userAgentHome, "config.toml")
		if _, err := os.Stat(userConfig); err == nil {
			if err := copyFile(userConfig, target, 0o600); err != nil {
				return nil, fmt.Errorf("copy tutti-agent config: %w", err)
			}
		}
	}
	return cleanup, nil
}

func exposeTuttiAgentAuthWithProjector(ctx context.Context, home string, source string, allowMissingSource bool, projector AuthFileProjector) (func(context.Context) error, error) {
	if !allowMissingSource {
		if _, err := os.Stat(source); err != nil {
			if os.IsNotExist(err) {
				return nil, nil
			}
			return nil, fmt.Errorf("stat tutti-agent auth source: %w", err)
		}
	}
	target := filepath.Join(home, "auth.json")
	if info, err := os.Lstat(target); err == nil {
		if info.Mode()&os.ModeSymlink != 0 {
			current, readErr := os.Readlink(target)
			if readErr != nil {
				return nil, fmt.Errorf("read tutti-agent auth target: %w", readErr)
			}
			if current == source {
				return nil, nil
			}
			return nil, fmt.Errorf("tutti-agent auth target already links to a different source")
		}
		if projector != nil {
			cleanup, projectErr := projector.Project(ctx, AuthFileProjection{SourcePath: source, TargetPath: target, LockSourcePath: filepath.Join(filepath.Dir(source), ".refresh.lock"), LockTargetPath: filepath.Join(home, ".refresh.lock")})
			if projectErr != nil {
				return nil, fmt.Errorf("recover tutti-agent auth projection: %w", projectErr)
			}
			return cleanup, nil
		}
		// Legacy embedders without a projector retain their existing regular
		// run-scoped view.
		return nil, nil
	} else if !os.IsNotExist(err) {
		return nil, fmt.Errorf("inspect tutti-agent auth target: %w", err)
	}
	if projector != nil {
		cleanup, err := projector.Project(ctx, AuthFileProjection{SourcePath: source, TargetPath: target, LockSourcePath: filepath.Join(filepath.Dir(source), ".refresh.lock"), LockTargetPath: filepath.Join(home, ".refresh.lock")})
		if err != nil {
			return nil, fmt.Errorf("expose tutti-agent auth.json: %w", err)
		}
		return cleanup, nil
	}
	if err := exposeCodexFile(source, target, 0o600); err != nil {
		return nil, fmt.Errorf("expose tutti-agent auth.json: %w", err)
	}
	return nil, nil
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
	if cleaned, cleanedChanged := tuttiAgentConfigWithoutLegacyPinnedProvider(next); cleanedChanged {
		next = cleaned
		changed = true
	}
	if planNext, planChanged := codexConfigWithModelPlanEndpoint(next, input.ModelEndpoint); planChanged {
		next = planNext
		changed = true
	}
	if mcpNext, mcpChanged := codexConfigWithConnectorMCP(next, input.MCPServers); mcpChanged {
		next = mcpNext
		changed = true
	}
	// Tutti Agent uses the same Codex-derived app-server sandbox runtime as
	// Codex, but it is launched by Tutti's non-elevated desktop daemon. Keep
	// the Windows implementation aligned with Codex session homes so an
	// interactive UAC setup helper cannot block app-server startup.
	if windowsSandboxNext, windowsSandboxChanged := codexConfigWithTuttiWindowsSandbox(next); windowsSandboxChanged {
		next = windowsSandboxNext
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
	lines := strings.Split(normalized, "\n")
	rootProviderLine := -1
	rootModelLine := -1
	legacySectionStart := -1
	legacySectionEnd := len(lines)
	firstSection := len(lines)
	for index, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "[") && strings.HasSuffix(trimmed, "]") {
			if firstSection == len(lines) {
				firstSection = index
			}
			if trimmed == `[model_providers.tutti-llm]` {
				if legacySectionStart >= 0 {
					return content, false
				}
				legacySectionStart = index
				continue
			}
			if legacySectionStart >= 0 && legacySectionEnd == len(lines) {
				legacySectionEnd = index
			}
			continue
		}
		if index >= firstSection {
			continue
		}
		switch trimmed {
		case `model_provider = "tutti-llm"`:
			if rootProviderLine >= 0 {
				return content, false
			}
			rootProviderLine = index
		case `model = "gpt-5.4"`:
			if rootModelLine >= 0 {
				return content, false
			}
			rootModelLine = index
		}
	}
	if rootProviderLine < 0 || rootModelLine < 0 || legacySectionStart < 0 {
		return content, false
	}
	legacyKeys := map[string]bool{
		`name = "Tutti LLM"`:                       false,
		`base_url = "https://llm-api.tutti.sh/v1"`: false,
		`wire_api = "responses"`:                   false,
	}
	for _, line := range lines[legacySectionStart+1 : legacySectionEnd] {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		if _, ok := legacyKeys[trimmed]; !ok || legacyKeys[trimmed] {
			return content, false
		}
		legacyKeys[trimmed] = true
	}
	for _, found := range legacyKeys {
		if !found {
			return content, false
		}
	}
	result := make([]string, 0, len(lines))
	for index, line := range lines {
		if index == rootProviderLine || index == rootModelLine {
			continue
		}
		if index >= legacySectionStart && index < legacySectionEnd {
			continue
		}
		result = append(result, line)
	}
	next := strings.Join(result, "\n")
	if strings.HasSuffix(normalized, "\n") && !strings.HasSuffix(next, "\n") {
		next += "\n"
	}
	return next, true
}
