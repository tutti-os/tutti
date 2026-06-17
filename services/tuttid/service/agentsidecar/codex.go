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
	if err := prepareCodexHome(codexHome, input.PrepareInput); err != nil {
		return ProviderPrepareResult{}, err
	}
	instructionsPath := filepath.Join(codexHome, "AGENTS.md")
	writeResult, err := input.Store.WriteManagedBlock(instructionsPath, tuttiCLIPolicy(input.PrepareInput))
	if err != nil {
		return ProviderPrepareResult{}, err
	}
	if input.Manifest != nil {
		input.Manifest.RecordManagedFile(instructionsPath, "provider-instructions", writeResult.Created)
		input.Manifest.RecordManagedFile(codexHome, "codex-home", true)
	}
	return ProviderPrepareResult{
		Cwd: input.Cwd,
		Env: []string{
			"CODEX_HOME=" + codexHome,
		},
	}, nil
}

func prepareCodexHome(codexHome string, input PrepareInput) error {
	if err := os.MkdirAll(codexHome, 0o700); err != nil {
		return fmt.Errorf("create codex home: %w", err)
	}
	if err := exposeUserCodexFiles(codexHome); err != nil {
		return err
	}
	if err := ensureCodexSessionConfig(filepath.Join(codexHome, "config.toml")); err != nil {
		return err
	}
	if err := exposeUserCodexSkillFolders(filepath.Join(codexHome, "skills"), input); err != nil {
		return err
	}
	if _, err := installProviderNativeSkills(filepath.Join(codexHome, "skills"), input); err != nil {
		return err
	}
	return installCodexApprovalRules(codexHome, input)
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
	return exposeUserCodexConfig(codexHome, userCodexHome)
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

func ensureCodexSessionConfig(configPath string) error {
	contentBytes, err := os.ReadFile(configPath)
	if err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("read codex config: %w", err)
	}
	next, changed := codexConfigWithProjectRootMarkersDisabled(string(contentBytes))
	if serviceTierNext, serviceTierChanged := codexConfigWithSupportedServiceTier(next); serviceTierChanged {
		next = serviceTierNext
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
			builder.WriteByte(char)
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
