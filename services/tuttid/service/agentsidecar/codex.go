package agentsidecar

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

const (
	codexProjectRootMarkersDisabledConfig = `project_root_markers = []`
)

type CodexPreparer struct{}

func (CodexPreparer) Provider() string {
	return "codex"
}

func (CodexPreparer) Prepare(_ context.Context, input ProviderPrepareInput) (ProviderPrepareResult, error) {
	codexHome := filepath.Join(input.RuntimeRoot, "codex-home")
	logRuntimePrepareTrace("runtime_prepare.codex.entered", input.PrepareInput, nil)
	if err := prepareCodexHome(codexHome, input.PrepareInput); err != nil {
		return ProviderPrepareResult{}, err
	}
	logRuntimePrepareTrace("runtime_prepare.codex.home_prepared", input.PrepareInput, nil)
	instructionsPath := filepath.Join(codexHome, "AGENTS.md")
	logRuntimePrepareTrace("runtime_prepare.codex.instructions_write_requested", input.PrepareInput, nil)
	writeResult, err := input.Store.WriteManagedBlock(instructionsPath, tuttiCLIPolicy(input.PrepareInput))
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
	return ProviderPrepareResult{
		Cwd: input.Cwd,
		Env: []string{
			"CODEX_HOME=" + codexHome,
		},
	}, nil
}

func prepareCodexHome(codexHome string, input PrepareInput) error {
	logRuntimePrepareTrace("runtime_prepare.codex.home_dir_requested", input, nil)
	if err := os.MkdirAll(codexHome, 0o700); err != nil {
		return fmt.Errorf("create codex home: %w", err)
	}
	logRuntimePrepareTrace("runtime_prepare.codex.home_dir_resolved", input, nil)
	logRuntimePrepareTrace("runtime_prepare.codex.user_files_requested", input, nil)
	if err := exposeUserCodexFiles(codexHome); err != nil {
		return err
	}
	logRuntimePrepareTrace("runtime_prepare.codex.user_files_resolved", input, nil)
	logRuntimePrepareTrace("runtime_prepare.codex.imported_rollout_requested", input, nil)
	if err := exposeCodexImportedRolloutFile(codexHome, input.ExternalRolloutSourcePath); err != nil {
		return err
	}
	logRuntimePrepareTrace("runtime_prepare.codex.imported_rollout_resolved", input, nil)
	logRuntimePrepareTrace("runtime_prepare.codex.session_config_requested", input, nil)
	if err := ensureCodexSessionConfig(filepath.Join(codexHome, "config.toml"), input); err != nil {
		return err
	}
	logRuntimePrepareTrace("runtime_prepare.codex.session_config_resolved", input, nil)
	logRuntimePrepareTrace("runtime_prepare.codex.user_skills_requested", input, nil)
	if err := exposeUserCodexSkillFolders(filepath.Join(codexHome, "skills"), input); err != nil {
		return err
	}
	logRuntimePrepareTrace("runtime_prepare.codex.user_skills_resolved", input, nil)
	logRuntimePrepareTrace("runtime_prepare.codex.native_skills_requested", input, nil)
	skillPaths, err := installProviderNativeSkills(filepath.Join(codexHome, "skills"), input)
	if err != nil {
		return err
	}
	logRuntimePrepareTrace("runtime_prepare.codex.native_skills_resolved", input, map[string]any{
		"skill_count": len(skillPaths),
	})
	logRuntimePrepareTrace("runtime_prepare.codex.approval_rules_requested", input, nil)
	if err := installCodexApprovalRules(codexHome, input); err != nil {
		return err
	}
	logRuntimePrepareTrace("runtime_prepare.codex.approval_rules_resolved", input, nil)
	return nil
}

func installCodexApprovalRules(codexHome string, input PrepareInput) error {
	rulesDir := filepath.Join(codexHome, "rules")
	if err := os.MkdirAll(rulesDir, 0o700); err != nil {
		return fmt.Errorf("create codex rules directory: %w", err)
	}
	content := codexApprovalRules(input.CLICommand)
	if err := os.WriteFile(filepath.Join(rulesDir, "default.rules"), []byte(content), 0o644); err != nil {
		return fmt.Errorf("write codex approval rules: %w", err)
	}
	return nil
}

func codexApprovalRules(cliCommand string) string {
	command := normalizeCLICommandName(cliCommand)
	return "prefix_rule(pattern=[" + strconv.Quote(command) + "], decision=\"allow\")\n"
}

func exposeUserCodexFiles(codexHome string) error {
	userHome, err := os.UserHomeDir()
	if err != nil || strings.TrimSpace(userHome) == "" {
		return nil
	}
	userCodexHome := filepath.Join(userHome, ".codex")
	for _, name := range []string{"auth.json"} {
		source := filepath.Join(userCodexHome, name)
		if _, err := os.Stat(source); err != nil {
			continue
		}
		target := filepath.Join(codexHome, name)
		if _, err := os.Lstat(target); err == nil {
			continue
		}
		if err := os.Symlink(source, target); err != nil {
			if copyErr := copyFile(source, target, 0o600); copyErr != nil {
				return fmt.Errorf("expose codex %s: symlink failed: %v; copy failed: %w", name, err, copyErr)
			}
		}
	}
	if err := exposeUserCodexPluginState(codexHome, userCodexHome); err != nil {
		return err
	}
	return exposeUserCodexConfig(codexHome, userCodexHome)
}

// exposeCodexImportedRolloutFile symlinks the single Codex CLI rollout
// (conversation transcript) file that an imported session was read from into
// the sandboxed CODEX_HOME, at the same path it has relative to the real
// `~/.codex` tree (e.g. `sessions/2026/07/04/rollout-...jsonl` or
// `archived_sessions/...`). Codex CLI resolves rollouts for `thread/resume`
// relative to CODEX_HOME, so mirroring the real relative layout lets it find
// the transcript by thread id without needing this code to know or guess
// Codex's internal sharding/naming scheme, and without exposing any other
// unrelated conversation under ~/.codex/sessions into a sandbox scoped to
// this one session/run.
//
// sourcePath is empty for every non-imported session, so this is a no-op for
// the overwhelming majority of sessions. When it is set but the file can't be
// resolved or no longer exists (moved, pruned by the user's own Codex CLI
// retention, or a custom CODEX_HOME was in effect on another device at import
// time), this intentionally returns nil rather than an error: resume still
// falls back to the existing documented "recreatable" path (a fresh thread
// with a visible notice) exactly as it did before this file existed.
func exposeCodexImportedRolloutFile(codexHome string, sourcePath string) error {
	sourcePath = strings.TrimSpace(sourcePath)
	if sourcePath == "" {
		return nil
	}
	userHome, err := os.UserHomeDir()
	if err != nil || strings.TrimSpace(userHome) == "" {
		return nil
	}
	userCodexHome := filepath.Join(userHome, ".codex")
	rel, err := filepath.Rel(userCodexHome, sourcePath)
	if err != nil || rel == ".." || rel == "." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		// Not under the real ~/.codex tree we know how to mirror - leave it to
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
	if err := os.Symlink(sourcePath, target); err != nil {
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
		if err := os.Symlink(source, target); err != nil {
			return fmt.Errorf("expose codex plugin state %s: %w", rel, err)
		}
	}
	return nil
}

func exposeUserCodexConfig(codexHome string, userCodexHome string) error {
	target := filepath.Join(codexHome, "config.toml")
	if targetInfo, err := os.Lstat(target); err == nil {
		if targetInfo.Mode()&os.ModeSymlink == 0 {
			return nil
		}
		if err := os.Remove(target); err != nil {
			return fmt.Errorf("replace codex config symlink: %w", err)
		}
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("inspect codex config: %w", err)
	}
	source := filepath.Join(userCodexHome, "config.toml")
	if _, err := os.Stat(source); err != nil {
		return nil
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
	if !changed {
		return nil
	}
	if err := os.WriteFile(configPath, []byte(next), 0o600); err != nil {
		return fmt.Errorf("write codex config: %w", err)
	}
	return nil
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

// Consume a complete multiline TOML array so stale marker entries do not remain
// after replacing project_root_markers with the session-scoped override.
func codexConfigAssignmentEndLine(lines []string, startIndex int) int {
	if startIndex < 0 || startIndex >= len(lines) {
		return startIndex
	}
	_, value, ok := strings.Cut(lines[startIndex], "=")
	if !ok {
		return startIndex
	}
	depth := tomlSquareBracketDelta(value)
	if depth <= 0 {
		return startIndex
	}
	for index := startIndex + 1; index < len(lines); index++ {
		depth += tomlSquareBracketDelta(lines[index])
		if depth <= 0 {
			return index
		}
	}
	return startIndex
}

func tomlSquareBracketDelta(line string) int {
	depth := 0
	escaped := false
	quote := rune(0)
	for _, char := range line {
		switch quote {
		case '"':
			if escaped {
				escaped = false
				continue
			}
			if char == '\\' {
				escaped = true
				continue
			}
			if char == '"' {
				quote = 0
			}
			continue
		case '\'':
			if char == '\'' {
				quote = 0
			}
			continue
		}
		switch char {
		case '#':
			return depth
		case '"', '\'':
			quote = char
		case '[':
			depth++
		case ']':
			depth--
		}
	}
	return depth
}

func exposeUserCodexSkillFolders(targetRoot string, input PrepareInput) error {
	userHome, err := os.UserHomeDir()
	if err != nil || strings.TrimSpace(userHome) == "" {
		return nil
	}
	sourceRoot := filepath.Join(userHome, ".codex", "skills")
	entries, err := os.ReadDir(sourceRoot)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("read user codex skills: %w", err)
	}
	if err := os.MkdirAll(targetRoot, 0o755); err != nil {
		return fmt.Errorf("create codex skills directory: %w", err)
	}
	for _, entry := range entries {
		name := strings.TrimSpace(entry.Name())
		if name == "" || strings.HasPrefix(name, ".") {
			continue
		}
		if shouldSkipUserCodexSkillForTuttiBrowserUse(name, input) {
			continue
		}
		source := filepath.Join(sourceRoot, name)
		sourceInfo, err := os.Stat(source)
		if err != nil || !sourceInfo.IsDir() {
			continue
		}
		skillPath := filepath.Join(source, "SKILL.md")
		skillInfo, err := os.Stat(skillPath)
		if err != nil || skillInfo.IsDir() {
			continue
		}
		if !hasDelimitedSkillFrontmatter(skillPath) {
			slog.Warn(
				"user codex skill skipped; invalid frontmatter",
				"error_code", "skill_frontmatter_invalid",
				"skillName", name,
				"skillPath", skillPath,
				"reason", "missing_delimited_yaml_frontmatter",
			)
			continue
		}
		target := filepath.Join(targetRoot, name)
		if _, err := os.Lstat(target); err == nil {
			continue
		} else if !os.IsNotExist(err) {
			return fmt.Errorf("inspect codex skill %s: %w", name, err)
		}
		if err := os.Symlink(source, target); err != nil {
			return fmt.Errorf("expose codex skill %s: %w", name, err)
		}
	}
	return nil
}

func hasDelimitedSkillFrontmatter(path string) bool {
	content, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	lines := strings.Split(string(content), "\n")
	if len(lines) == 0 || strings.TrimSpace(strings.TrimPrefix(lines[0], "\ufeff")) != "---" {
		return false
	}
	for _, line := range lines[1:] {
		if strings.TrimSpace(line) == "---" {
			return true
		}
	}
	return false
}

func shouldSkipUserCodexSkillForTuttiBrowserUse(name string, input PrepareInput) bool {
	if !input.BrowserUse || !BrowserUseDefaultEnabled() {
		return false
	}
	return strings.EqualFold(strings.TrimSpace(name), "browser")
}

func copyFile(source string, target string, mode os.FileMode) error {
	content, err := os.ReadFile(source)
	if err != nil {
		return err
	}
	return os.WriteFile(target, content, mode)
}
