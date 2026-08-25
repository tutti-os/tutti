package runtimeprep

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

const (
	codexProjectRootMarkersDisabledConfig = `project_root_markers = []`
)

type CodexPreparer struct {
	AuthProjector     AuthFileProjector
	PersonalSkillRoot string
}

func (CodexPreparer) Provider() string {
	return "codex"
}

func (p CodexPreparer) Prepare(ctx context.Context, input ProviderPrepareInput) (result ProviderPrepareResult, err error) {
	codexHome := filepath.Join(input.RuntimeRoot, "codex-home")
	providerStateHome, err := resolveCodexProviderStateHome(input.PrepareInput)
	if err != nil {
		return ProviderPrepareResult{}, err
	}
	logRuntimePrepareTrace("runtime_prepare.codex.entered", input.PrepareInput, nil)
	extraSkillRoots, err := prepareCodexHome(
		codexHome,
		filepath.Join(input.RuntimeRoot, "codex-session-skills"),
		p.PersonalSkillRoot,
		providerStateHome,
		input.PrepareInput,
	)
	if err != nil {
		return ProviderPrepareResult{}, err
	}
	cleanup, err := projectCodexAuth(ctx, codexHome, providerStateHome, p.AuthProjector)
	if err != nil {
		return ProviderPrepareResult{}, err
	}
	defer func() {
		if err != nil && cleanup != nil {
			err = errors.Join(err, cleanup(ctx))
		}
	}()
	if input.CodexSaverMode {
		rolePath, err := installCodexLunaWorkerRole(codexHome)
		if err != nil {
			return ProviderPrepareResult{}, err
		}
		if err := ensureCodexSaverDefaultRole(filepath.Join(codexHome, "config.toml")); err != nil {
			return ProviderPrepareResult{}, err
		}
		if input.Manifest != nil {
			input.Manifest.RecordManagedFile(rolePath, "codex-agent-role", true)
		}
	}
	logRuntimePrepareTrace("runtime_prepare.codex.home_prepared", input.PrepareInput, nil)
	instructionsPath := filepath.Join(codexHome, "AGENTS.md")
	logRuntimePrepareTrace("runtime_prepare.codex.instructions_write_requested", input.PrepareInput, nil)
	policy, err := tuttiCLIPolicy(input.PrepareInput)
	if err != nil {
		return ProviderPrepareResult{}, err
	}
	if input.CodexSaverMode {
		policy = strings.TrimSpace(policy) + "\n\n" + codexSaverModePolicy
	}
	writeResult, err := input.Store.WriteManagedBlock(instructionsPath, policy)
	if err != nil {
		return ProviderPrepareResult{}, err
	}
	logRuntimePrepareTrace("runtime_prepare.codex.instructions_write_resolved", input.PrepareInput, map[string]any{
		"created": writeResult.Created,
	})
	if input.Manifest != nil {
		input.Manifest.RecordManagedFile(instructionsPath, "provider-instructions", writeResult.Created)
		input.Manifest.RecordManagedFile(codexHome, "codex-home", true)
	}
	logRuntimePrepareTrace("runtime_prepare.codex.resolved", input.PrepareInput, nil)
	env := []string{
		"CODEX_HOME=" + codexHome,
	}
	if len(extraSkillRoots) > 0 {
		encodedRoots, err := json.Marshal(extraSkillRoots)
		if err != nil {
			return ProviderPrepareResult{}, fmt.Errorf("encode Codex extra skill roots: %w", err)
		}
		env = append(env, tuttiAgentExtraSkillRootsEnv+"="+string(encodedRoots))
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

func projectCodexAuth(ctx context.Context, codexHome, providerStateHome string, projector AuthFileProjector) (func(context.Context) error, error) {
	if projector == nil || strings.TrimSpace(providerStateHome) == "" {
		return nil, nil
	}
	source := filepath.Join(providerStateHome, "auth.json")
	if _, err := os.Stat(source); err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("stat codex auth source: %w", err)
	}
	target := filepath.Join(codexHome, "auth.json")
	if info, err := os.Lstat(target); err == nil && info.Mode()&os.ModeSymlink != 0 {
		current, readErr := os.Readlink(target)
		if readErr != nil {
			return nil, fmt.Errorf("read codex auth projection: %w", readErr)
		}
		if current == source {
			return nil, nil
		}
	}
	cleanup, err := projector.Project(ctx, AuthFileProjection{SourcePath: source, TargetPath: target})
	if err != nil {
		return nil, fmt.Errorf("project codex auth: %w", err)
	}
	return cleanup, nil
}

func prepareCodexHome(
	codexHome string,
	sessionSkillRoot string,
	personalSkillRoot string,
	providerStateHome string,
	input PrepareInput,
) ([]string, error) {
	var extraSkillRoots []string
	logRuntimePrepareTrace("runtime_prepare.codex.home_dir_requested", input, nil)
	if err := os.MkdirAll(codexHome, 0o700); err != nil {
		return nil, fmt.Errorf("create codex home: %w", err)
	}
	logRuntimePrepareTrace("runtime_prepare.codex.home_dir_resolved", input, nil)
	logRuntimePrepareTrace("runtime_prepare.codex.user_files_requested", input, nil)
	if err := exposeUserCodexFiles(codexHome, providerStateHome); err != nil {
		return nil, err
	}
	logRuntimePrepareTrace("runtime_prepare.codex.user_files_resolved", input, nil)
	logRuntimePrepareTrace("runtime_prepare.codex.imported_rollout_requested", input, nil)
	if err := exposeCodexImportedRolloutFile(codexHome, providerStateHome, input.ExternalRolloutSourcePath); err != nil {
		return nil, err
	}
	logRuntimePrepareTrace("runtime_prepare.codex.imported_rollout_resolved", input, nil)
	logRuntimePrepareTrace("runtime_prepare.codex.session_config_requested", input, nil)
	if err := ensureCodexSessionConfig(filepath.Join(codexHome, "config.toml"), input); err != nil {
		return nil, err
	}
	logRuntimePrepareTrace("runtime_prepare.codex.session_config_resolved", input, nil)
	if !input.SkipSkills {
		logRuntimePrepareTrace("runtime_prepare.codex.user_skills_requested", input, nil)
		if strings.TrimSpace(personalSkillRoot) == "" {
			if err := exposeUserCodexSkillFolders(filepath.Join(codexHome, "skills"), providerStateHome, input); err != nil {
				return nil, err
			}
		} else {
			if err := exposePersonalCodexSkillRoot(
				filepath.Join(codexHome, "skills"),
				personalSkillRoot,
				sessionSkillRoot,
			); err != nil {
				return nil, err
			}
			providerSkillRoot, err := distinctCodexProviderSkillRoot(providerStateHome, personalSkillRoot)
			if err != nil {
				return nil, err
			}
			if providerSkillRoot != "" {
				extraSkillRoots = append(extraSkillRoots, providerSkillRoot)
			}
		}
		logRuntimePrepareTrace("runtime_prepare.codex.user_skills_resolved", input, nil)
		logRuntimePrepareTrace("runtime_prepare.codex.native_skills_requested", input, nil)
		nativeSkillRoot := filepath.Join(codexHome, "skills")
		reservedRoots := []string(nil)
		if strings.TrimSpace(personalSkillRoot) != "" {
			nativeSkillRoot = sessionSkillRoot
			reservedRoots = []string{filepath.Clean(personalSkillRoot)}
		}
		skillPaths, err := installProviderNativeSkillsSessionScopedWithReservedRoots(
			nativeSkillRoot,
			reservedRoots,
			input,
		)
		if err != nil {
			return nil, err
		}
		logRuntimePrepareTrace("runtime_prepare.codex.native_skills_resolved", input, map[string]any{
			"skill_count": len(skillPaths),
		})
		if strings.TrimSpace(personalSkillRoot) != "" && len(skillPaths) > 0 {
			extraSkillRoots = append(extraSkillRoots, nativeSkillRoot)
		}
	}
	logRuntimePrepareTrace("runtime_prepare.codex.approval_rules_requested", input, nil)
	if err := installCodexApprovalRules(codexHome, input); err != nil {
		return nil, err
	}
	logRuntimePrepareTrace("runtime_prepare.codex.approval_rules_resolved", input, nil)
	return extraSkillRoots, nil
}

func installCodexApprovalRules(codexHome string, input PrepareInput) error {
	rulesDir := filepath.Join(codexHome, "rules")
	if err := os.MkdirAll(rulesDir, 0o700); err != nil {
		return fmt.Errorf("create codex rules directory: %w", err)
	}
	content := codexApprovalRules(input)
	if err := os.WriteFile(filepath.Join(rulesDir, "default.rules"), []byte(content), 0o644); err != nil {
		return fmt.Errorf("write codex approval rules: %w", err)
	}
	return nil
}

func codexApprovalRules(input PrepareInput) string {
	command := normalizeCLICommandName(input.CLICommand)
	if input.CommandCapabilityProjection == nil {
		return codexApprovalRule([]string{command})
	}
	if input.commandCapabilities == nil {
		return ""
	}
	var rules strings.Builder
	seen := make(map[string]struct{}, len(input.commandCapabilities.commands))
	for _, capability := range input.commandCapabilities.commands {
		pattern := append([]string{command}, normalizedCommandPath(capability.Path)...)
		key := strings.Join(pattern, "\x00")
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		rules.WriteString(codexApprovalRule(pattern))
	}
	return rules.String()
}

func codexApprovalRule(pattern []string) string {
	quoted := make([]string, 0, len(pattern))
	for _, segment := range pattern {
		if segment = strings.TrimSpace(segment); segment != "" {
			quoted = append(quoted, strconv.Quote(segment))
		}
	}
	if len(quoted) == 0 {
		return ""
	}
	return "prefix_rule(pattern=[" + strings.Join(quoted, ", ") +
		"], decision=\"allow\")\n"
}

func exposeUserCodexFiles(codexHome, userCodexHome string) error {
	if strings.TrimSpace(userCodexHome) == "" {
		return nil
	}
	for _, name := range []string{"auth.json"} {
		source := filepath.Join(userCodexHome, name)
		if _, err := os.Stat(source); err != nil {
			continue
		}
		target := filepath.Join(codexHome, name)
		if _, err := os.Lstat(target); err == nil {
			continue
		}
		if err := exposeCodexFile(source, target, 0o600); err != nil {
			if copyErr := copyFile(source, target, 0o600); copyErr != nil {
				return fmt.Errorf("expose codex %s: link failed: %v; copy failed: %w", name, err, copyErr)
			}
		}
	}
	if err := exposeUserCodexModelsCache(codexHome, userCodexHome); err != nil {
		return err
	}
	if err := exposeUserCodexPluginState(codexHome, userCodexHome); err != nil {
		return err
	}
	if err := exposeUserCodexConfig(codexHome, userCodexHome); err != nil {
		return err
	}
	if err := exposeUserCodexAgentsFile(codexHome, userCodexHome); err != nil {
		return err
	}
	if err := exposeUserCodexModelCatalog(codexHome, userCodexHome); err != nil {
		return err
	}
	return exposeUserCodexInstructionsFile(codexHome, userCodexHome)
}

// exposeCodexImportedRolloutFile symlinks the single Codex CLI rollout
// (conversation transcript) file that an imported session was read from into
// the sandboxed CODEX_HOME, at the same path it has relative to the stable
// provider state home (e.g. `sessions/2026/07/04/rollout-...jsonl` or
// `archived_sessions/...`). Codex CLI resolves rollouts for `thread/resume`
// relative to CODEX_HOME, so mirroring the real relative layout lets it find
// the transcript by thread id without needing this code to know or guess
// Codex's internal sharding/naming scheme, and without exposing any other
// unrelated conversation under the provider sessions directory into a
// sandbox scoped to this one session/run.
//
// sourcePath is empty for every non-imported session, so this is a no-op for
// the overwhelming majority of sessions. When it is set but the file can't be
// resolved or no longer exists (moved, pruned by the user's own Codex CLI
// retention, or a custom CODEX_HOME was in effect on another device at import
// time), this intentionally returns nil rather than an error: resume still
// falls back to the existing documented "recreatable" path (a fresh thread
// with a visible notice) exactly as it did before this file existed.
func exposeCodexImportedRolloutFile(codexHome, userCodexHome, sourcePath string) error {
	sourcePath = strings.TrimSpace(sourcePath)
	if sourcePath == "" || strings.TrimSpace(userCodexHome) == "" {
		return nil
	}
	rel, err := filepath.Rel(userCodexHome, sourcePath)
	if err != nil || rel == ".." || rel == "." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		// Not under the stable provider state tree we know how to mirror - leave it to
		// the recreate fallback rather than guessing at a different layout.
		return nil
	}
	if info, err := os.Stat(sourcePath); err != nil || info.IsDir() {
		// Original rollout is gone or was never a real file - fall back to
		// recreate, same as before this fix.
		return nil
	}
	target := filepath.Join(codexHome, rel)
	if _, err := os.Lstat(target); err == nil {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		return fmt.Errorf("create codex imported rollout parent dir: %w", err)
	}
	if err := exposeCodexFile(sourcePath, target, 0o600); err != nil {
		return fmt.Errorf("expose codex imported rollout file: %w", err)
	}
	return nil
}

func exposeUserCodexPluginState(codexHome string, userCodexHome string) error {
	for _, rel := range []string{
		filepath.Join("plugins", "cache"),
		filepath.Join("plugins", "data"),
		filepath.Join("plugins", ".plugin-appserver"),
	} {
		source := filepath.Join(userCodexHome, rel)
		if _, err := os.Stat(source); err != nil {
			continue
		}
		target := filepath.Join(codexHome, rel)
		if _, err := os.Lstat(target); err == nil {
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
			return fmt.Errorf("create codex plugin state parent: %w", err)
		}
		if err := exposeCodexDirectory(source, target); err != nil {
			return fmt.Errorf("expose codex plugin state %s: %w", rel, err)
		}
	}
	return nil
}

func exposeUserCodexConfig(codexHome string, userCodexHome string) error {
	target := filepath.Join(codexHome, "config.toml")
	if targetInfo, err := os.Lstat(target); err == nil {
		if targetInfo.Mode()&os.ModeSymlink != 0 {
			if err := os.Remove(target); err != nil {
				return fmt.Errorf("replace codex config symlink: %w", err)
			}
		}
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("inspect codex config: %w", err)
	}
	source := filepath.Join(userCodexHome, "config.toml")
	if _, err := os.Stat(source); os.IsNotExist(err) {
		if removeErr := os.Remove(target); removeErr != nil && !os.IsNotExist(removeErr) {
			return fmt.Errorf("remove stale codex config: %w", removeErr)
		}
		return nil
	} else if err != nil {
		return fmt.Errorf("inspect user codex config: %w", err)
	}
	if err := copyFile(source, target, 0o600); err != nil {
		return fmt.Errorf("copy codex config: %w", err)
	}
	return nil
}

func ensureCodexSessionConfig(configPath string, input PrepareInput) error {
	contentBytes, err := os.ReadFile(configPath)
	if err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("read codex config: %w", err)
	}
	next, changed := codexConfigWithProjectRootMarkersDisabled(string(contentBytes))
	if serviceTierNext, serviceTierChanged := codexConfigWithSupportedServiceTier(next); serviceTierChanged {
		next = serviceTierNext
		changed = true
	}
	if tuttiNext, tuttiChanged := codexConfigWithTuttiConversationDetailMode(next, input.ConversationDetailMode); tuttiChanged {
		next = tuttiNext
		changed = true
	}
	if detailModeNext, detailModeChanged := codexConfigWithConversationDetailModeInstructions(next, input.ConversationDetailMode); detailModeChanged {
		next = detailModeNext
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
	// Tutti launches the Codex app-server from the non-elevated desktop daemon.
	// On Windows, the elevated sandbox implementation invokes a separate setup
	// helper through ShellExecuteExW, which requires an interactive UAC consent
	// flow that is not owned by the app-server protocol. Use the restricted,
	// non-elevated implementation for Tutti-owned session homes so a hidden or
	// canceled UAC prompt cannot prevent every command from starting. The
	// Codex/Tutti permission mode and approval policy remain unchanged.
	if windowsSandboxNext, windowsSandboxChanged := codexConfigWithTuttiWindowsSandbox(next); windowsSandboxChanged {
		next = windowsSandboxNext
		changed = true
	}
	if !changed {
		return nil
	}
	if err := os.WriteFile(configPath, []byte(next), 0o600); err != nil {
		return fmt.Errorf("write codex config: %w", err)
	}
	return nil
}

// codexConfigWithTuttiWindowsSandbox pins Tutti-owned Codex session homes to
// the unelevated Windows sandbox implementation. This is intentionally applied
// only on Windows and only to the copied per-session config, never to the
// provider's stable global config.toml.
func codexConfigWithTuttiWindowsSandbox(content string) (string, bool) {
	if runtime.GOOS != "windows" {
		return content, false
	}

	normalized := strings.ReplaceAll(content, "\r\n", "\n")
	lines := strings.Split(normalized, "\n")
	for sectionStart, line := range lines {
		if strings.TrimSpace(line) != "[windows]" {
			continue
		}
		sectionEnd := len(lines)
		for index := sectionStart + 1; index < len(lines); index++ {
			trimmed := strings.TrimSpace(lines[index])
			if strings.HasPrefix(trimmed, "[") && strings.HasSuffix(trimmed, "]") {
				sectionEnd = index
				break
			}
		}
		for index := sectionStart + 1; index < sectionEnd; index++ {
			trimmed := strings.TrimSpace(lines[index])
			if trimmed == "" || strings.HasPrefix(trimmed, "#") {
				continue
			}
			if !codexConfigLineHasKey(trimmed, "sandbox") {
				continue
			}
			if strings.TrimSpace(lines[index]) == `sandbox = "unelevated"` {
				return content, false
			}
			next := append([]string{}, lines...)
			next[index] = `sandbox = "unelevated"`
			return strings.Join(next, "\n"), true
		}
		next := make([]string, 0, len(lines)+1)
		next = append(next, lines[:sectionEnd]...)
		next = append(next, `sandbox = "unelevated"`)
		next = append(next, lines[sectionEnd:]...)
		return strings.Join(next, "\n"), true
	}

	next := strings.TrimRight(normalized, "\n")
	if next != "" {
		next += "\n\n"
	}
	next += "[windows]\nsandbox = \"unelevated\"\n"
	return next, true
}

func codexConfigWithTuttiConversationDetailMode(content string, conversationDetailMode string) (string, bool) {
	mode := normalizeAgentConversationDetailMode(conversationDetailMode)
	line := `conversationDetailMode = ` + strconv.Quote(mode)
	lines := strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n")
	for sectionStart, existingLine := range lines {
		if strings.TrimSpace(existingLine) != "[tutti]" {
			continue
		}
		sectionEnd := len(lines)
		for index := sectionStart + 1; index < len(lines); index++ {
			trimmed := strings.TrimSpace(lines[index])
			if strings.HasPrefix(trimmed, "[") && strings.HasSuffix(trimmed, "]") {
				sectionEnd = index
				break
			}
		}
		for index := sectionStart + 1; index < sectionEnd; index++ {
			trimmed := strings.TrimSpace(lines[index])
			if trimmed == "" || strings.HasPrefix(trimmed, "#") {
				continue
			}
			if !codexConfigLineHasKey(trimmed, "conversationDetailMode") {
				continue
			}
			if strings.TrimSpace(lines[index]) == line {
				return content, false
			}
			nextLines := append([]string{}, lines...)
			nextLines[index] = line
			return strings.Join(nextLines, "\n"), true
		}
		nextLines := make([]string, 0, len(lines)+1)
		nextLines = append(nextLines, lines[:sectionEnd]...)
		nextLines = append(nextLines, line)
		nextLines = append(nextLines, lines[sectionEnd:]...)
		return strings.Join(nextLines, "\n"), true
	}
	block := "[tutti]\n" + line + "\n"
	if strings.TrimSpace(content) == "" {
		return block, true
	}
	return strings.TrimRight(content, "\r\n") + "\n\n" + block, true
}

func codexConfigWithConversationDetailModeInstructions(content string, conversationDetailMode string) (string, bool) {
	instructions := agentConversationDetailModeInstructions(conversationDetailMode)
	if strings.TrimSpace(instructions) == "" {
		return codexConfigWithoutConversationDetailModeInstructions(content)
	}
	if strings.Contains(content, instructions) {
		return content, false
	}
	line := `developer_instructions = ` + strconv.Quote(instructions)
	lines := strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n")
	for index, existingLine := range lines {
		trimmed := strings.TrimSpace(existingLine)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		if strings.HasPrefix(trimmed, "[") {
			break
		}
		if !codexConfigLineHasKey(trimmed, "developer_instructions") {
			continue
		}
		value, endIndex, ok := codexConfigStringAssignmentValueAt(lines, index, "developer_instructions")
		if ok && strings.TrimSpace(value) != "" {
			line = `developer_instructions = ` + strconv.Quote(strings.TrimRight(value, "\n")+"\n\n"+instructions)
		}
		nextLines := make([]string, 0, len(lines)-(endIndex-index))
		nextLines = append(nextLines, lines[:index]...)
		nextLines = append(nextLines, line)
		nextLines = append(nextLines, lines[endIndex+1:]...)
		return strings.Join(nextLines, "\n"), true
	}
	if strings.TrimSpace(content) == "" {
		return line + "\n", true
	}
	return line + "\n\n" + strings.TrimLeft(content, "\r\n"), true
}

func codexConfigWithoutConversationDetailModeInstructions(content string) (string, bool) {
	lines := strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n")
	for index, existingLine := range lines {
		trimmed := strings.TrimSpace(existingLine)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		if strings.HasPrefix(trimmed, "[") {
			break
		}
		if !codexConfigLineHasKey(trimmed, "developer_instructions") {
			continue
		}
		value, endIndex, ok := codexConfigStringAssignmentValueAt(lines, index, "developer_instructions")
		if !ok {
			return content, false
		}
		nextValue, removed := codexDeveloperInstructionsWithoutConversationDetailMode(value)
		if !removed {
			return content, false
		}
		nextLines := make([]string, 0, len(lines)-(endIndex-index))
		nextLines = append(nextLines, lines[:index]...)
		if strings.TrimSpace(nextValue) != "" {
			nextLines = append(nextLines, `developer_instructions = `+strconv.Quote(nextValue))
		}
		nextLines = append(nextLines, lines[endIndex+1:]...)
		return strings.Join(nextLines, "\n"), true
	}
	return content, false
}

func codexDeveloperInstructionsWithoutConversationDetailMode(value string) (string, bool) {
	instructions := nonTechnicalUIConversationDetailModeInstructions
	if !strings.Contains(value, instructions) {
		return value, false
	}
	next := strings.ReplaceAll(value, instructions, "")
	for strings.Contains(next, "\n\n\n") {
		next = strings.ReplaceAll(next, "\n\n\n", "\n\n")
	}
	return strings.TrimSpace(next), true
}

func codexConfigWithProjectRootMarkersDisabled(content string) (string, bool) {
	lines := strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n")
	for index, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		if strings.HasPrefix(trimmed, "[") {
			break
		}
		if codexConfigLineHasKey(trimmed, "project_root_markers") {
			endIndex := codexConfigAssignmentEndLine(lines, index)
			if endIndex == index && trimmed == codexProjectRootMarkersDisabledConfig {
				return content, false
			}
			nextLines := make([]string, 0, len(lines)-(endIndex-index))
			nextLines = append(nextLines, lines[:index]...)
			nextLines = append(nextLines, codexProjectRootMarkersDisabledConfig)
			nextLines = append(nextLines, lines[endIndex+1:]...)
			return strings.Join(nextLines, "\n"), true
		}
	}
	next := codexProjectRootMarkersDisabledConfig + "\n"
	if strings.TrimSpace(content) != "" {
		next += "\n" + strings.TrimLeft(content, "\r\n")
	}
	return next, true
}

func codexConfigWithSupportedServiceTier(content string) (string, bool) {
	lines := strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n")
	for index, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		if strings.HasPrefix(trimmed, "[") {
			break
		}
		if !codexConfigLineHasKey(trimmed, "service_tier") {
			continue
		}
		value, ok := codexConfigStringAssignmentValue(trimmed, "service_tier")
		if !ok {
			return content, false
		}
		switch strings.ToLower(strings.TrimSpace(value)) {
		case "fast", "flex":
			return content, false
		case "priority":
			nextLines := append([]string{}, lines...)
			nextLines[index] = `service_tier = "fast"`
			return strings.Join(nextLines, "\n"), true
		case "", "default", "standard":
			endIndex := codexConfigAssignmentEndLine(lines, index)
			nextLines := make([]string, 0, len(lines)-(endIndex-index+1))
			nextLines = append(nextLines, lines[:index]...)
			nextLines = append(nextLines, lines[endIndex+1:]...)
			return strings.Join(nextLines, "\n"), true
		default:
			return content, false
		}
	}
	return content, false
}

func codexConfigLineHasKey(line string, key string) bool {
	if !strings.HasPrefix(line, key) {
		return false
	}
	return strings.HasPrefix(strings.TrimSpace(strings.TrimPrefix(line, key)), "=")
}

func codexConfigStringAssignmentValue(line string, key string) (string, bool) {
	if !codexConfigLineHasKey(line, key) {
		return "", false
	}
	_, rawValue, ok := strings.Cut(line, "=")
	if !ok {
		return "", false
	}
	rawValue = strings.TrimSpace(rawValue)
	if rawValue == "" {
		return "", true
	}
	quote := rawValue[0]
	if quote != '"' && quote != '\'' {
		return "", false
	}
	var builder strings.Builder
	escaped := false
	for index := 1; index < len(rawValue); index++ {
		char := rawValue[index]
		if quote == '"' && escaped {
			switch char {
			case 'n':
				builder.WriteByte('\n')
			case 'r':
				builder.WriteByte('\r')
			case 't':
				builder.WriteByte('\t')
			default:
				builder.WriteByte(char)
			}
			escaped = false
			continue
		}
		if quote == '"' && char == '\\' {
			escaped = true
			continue
		}
		if char == quote {
			return builder.String(), true
		}
		builder.WriteByte(char)
	}
	return "", false
}

func codexConfigStringAssignmentValueAt(lines []string, index int, key string) (string, int, bool) {
	if index < 0 || index >= len(lines) {
		return "", index, false
	}
	line := strings.TrimSpace(lines[index])
	if value, ok := codexConfigStringAssignmentValue(line, key); ok {
		return value, index, true
	}
	if !codexConfigLineHasKey(line, key) {
		return "", index, false
	}
	_, rawValue, ok := strings.Cut(line, "=")
	if !ok {
		return "", index, false
	}
	rawValue = strings.TrimSpace(rawValue)
	if !strings.HasPrefix(rawValue, `"""`) && !strings.HasPrefix(rawValue, `'''`) {
		return "", codexConfigAssignmentEndLine(lines, index), false
	}
	delimiter := rawValue[:3]
	rest := strings.TrimPrefix(rawValue, delimiter)
	if endOffset := strings.Index(rest, delimiter); endOffset >= 0 {
		return rest[:endOffset], index, true
	}
	var builder strings.Builder
	builder.WriteString(rest)
	for lineIndex := index + 1; lineIndex < len(lines); lineIndex++ {
		builder.WriteByte('\n')
		lineValue := lines[lineIndex]
		if endOffset := strings.Index(lineValue, delimiter); endOffset >= 0 {
			builder.WriteString(lineValue[:endOffset])
			return builder.String(), lineIndex, true
		}
		builder.WriteString(lineValue)
	}
	return "", index, false
}

func copyFile(source string, target string, mode os.FileMode) error {
	content, err := os.ReadFile(source)
	if err != nil {
		return err
	}
	return os.WriteFile(target, content, mode)
}
