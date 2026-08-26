package runtimeprep

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

const codexSaverModePolicy = `## Codex Saver Mode

Saver mode configures the default subagent as the Luna worker. Delegate only when a bounded, self-contained unit will replace meaningful main-thread reasoning, context, tool calls, or waiting; do not add a worker merely because a task is complex or has both implementation and tests. Keep quick work and work tightly coupled to the current reasoning in the main thread.

Make the decision early and default to one Luna worker for one complete independent unit. Add workers only when there are multiple genuinely independent, non-trivial units with non-overlapping scopes and each worker will replace separate main-thread work. Do not split one cohesive investigation into source, tests, and compatibility workers by default. Keep a mechanical workflow in the main thread when it can be expressed as one bounded blocking or event-driven command. Delegate one end-to-end owner only when validation, multi-repository checks, CI monitoring, or authorized commit, push, and check flows require multiple model-driven tool turns that the main thread would otherwise perform.

Spawn each worker without forking the main conversation history, using the no-history option exposed by the current tool. Run read-only or isolated-worktree units in parallel; if write scopes cannot be isolated, run them sequentially. Make every delegation self-contained and state the relevant context and files, non-goals, allowed state changes, acceptance criteria, retry limit, expected evidence, and a concrete tool-call budget. Tell the worker to use the minimum analysis and tools needed. Unless the scope clearly requires more, cap read-only analysis at 8 tool calls and implementation at 20. A read-only analysis worker inspects only directly relevant files and does not run tests, repair environments, or modify files unless explicitly asked. At the budget, return the best available evidence immediately instead of expanding the investigation.

Workers must not spawn or delegate to additional workers unless the parent delegation explicitly authorizes nested delegation and provides a total nested-worker and tool-call budget. Without that authorization, complete the delegated unit directly.

Start a worker before doing equivalent work in the main thread. Until its result arrives, do not inspect or implement the questions or files assigned to it. Continue only with non-overlapping work, or wait when no such work remains. If any worker message already contains enough evidence for its acceptance criteria, interrupt the worker instead of waiting for more exploration. Do not use an hour-long wait for an analysis worker. Verify the returned evidence narrowly; do not repeat the delegated investigation. Redispatch only a failed unit and only within its stated scope and retry limit. Prefer blocking or event-driven waits over repeated model-driven polling.`

const codexLunaWorkerRole = `name = "default"
description = "Luna worker for cost-efficient, bounded, self-contained implementation, research, verification, and tool-intensive workflows"
model = "gpt-5.6-luna"
model_reasoning_effort = "max"
developer_instructions = "Complete only the delegated task using the minimum analysis and tools needed. Do not spawn or delegate to another worker unless the parent task explicitly authorizes nested delegation and supplies a total nested-worker and tool-call budget. Respect the task scope, non-goals, allowed state changes, retry limit, tool-call budget, and expected output; return the best available evidence immediately when the criteria or budget are reached. For read-only analysis, do not modify files, run tests, or repair environments unless explicitly asked. Do not inspect unrelated repository history or use external research unless requested. For long-running external operations, prefer blocking or event-driven waits over repeated polling."
`

func installCodexLunaWorkerRole(codexHome string) (string, error) {
	agentsDir := filepath.Join(codexHome, "agents")
	if err := os.MkdirAll(agentsDir, 0o700); err != nil {
		return "", fmt.Errorf("create Codex agents directory: %w", err)
	}
	rolePath := filepath.Join(agentsDir, "luna_worker.toml")
	if err := os.WriteFile(rolePath, []byte(codexLunaWorkerRole), 0o600); err != nil {
		return "", fmt.Errorf("write Codex Luna worker role: %w", err)
	}
	return rolePath, nil
}

// Declare the session role explicitly so a copied user-defined default role
// cannot win over saver mode's session-scoped default.
func ensureCodexSaverDefaultRole(configPath string) error {
	contentBytes, err := os.ReadFile(configPath)
	if err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("read codex config for saver role: %w", err)
	}
	next, changed := codexConfigWithSaverDefaultRole(string(contentBytes))
	if !changed {
		return nil
	}
	if err := os.WriteFile(configPath, []byte(next), 0o600); err != nil {
		return fmt.Errorf("write codex saver role config: %w", err)
	}
	return nil
}

func codexConfigWithSaverDefaultRole(content string) (string, bool) {
	const section = "[agents.default]"
	managedLines := []string{
		`description = "Luna worker for cost-efficient, bounded, self-contained tasks"`,
		`config_file = "./agents/luna_worker.toml"`,
	}
	normalized := strings.ReplaceAll(content, "\r\n", "\n")
	lines := strings.Split(normalized, "\n")
	cleaned := make([]string, 0, len(lines))
	var currentSection []string
	skipDefaultSection := false
	multilineDelimiter := ""
	for index := 0; index < len(lines); index++ {
		line := lines[index]
		if multilineDelimiter != "" {
			if !skipDefaultSection {
				cleaned = append(cleaned, line)
			}
			if strings.Contains(line, multilineDelimiter) {
				multilineDelimiter = ""
			}
			continue
		}
		if sectionName, arrayTable, ok := codexTOMLSectionKey(line); ok {
			skipDefaultSection = !arrayTable && codexTOMLKeyEquals(sectionName, "agents", "default")
			currentSection = sectionName
			if !skipDefaultSection {
				cleaned = append(cleaned, line)
			}
			continue
		}
		if skipDefaultSection {
			if delimiter := codexTOMLUnclosedMultilineDelimiter(line); delimiter != "" {
				multilineDelimiter = delimiter
			}
			continue
		}
		if codexConfigIsDefaultAgentAssignment(line, currentSection) {
			index = codexConfigAssignmentEndLine(lines, index)
			continue
		}
		cleaned = append(cleaned, line)
		if delimiter := codexTOMLUnclosedMultilineDelimiter(line); delimiter != "" {
			multilineDelimiter = delimiter
		}
	}
	block := section + "\n" + strings.Join(managedLines, "\n")
	base := strings.TrimRight(strings.Join(cleaned, "\n"), "\r\n")
	if strings.TrimSpace(base) == "" {
		return block + "\n", normalized != block+"\n"
	}
	next := base + "\n\n" + block + "\n"
	return next, next != normalized
}

func codexConfigIsDefaultAgentAssignment(line string, currentSection []string) bool {
	lhs, _, ok := strings.Cut(line, "=")
	if !ok {
		return false
	}
	key, ok := codexTOMLDottedKey(lhs)
	if !ok {
		return false
	}
	if len(currentSection) == 0 {
		return len(key) >= 2 && key[0] == "agents" && key[1] == "default"
	}
	if codexTOMLKeyEquals(currentSection, "agents") {
		return len(key) >= 1 && key[0] == "default"
	}
	return false
}

func codexTOMLSectionKey(line string) ([]string, bool, bool) {
	line = strings.TrimSpace(codexTOMLWithoutComment(line))
	arrayTable := strings.HasPrefix(line, "[[")
	openLength, closeLength := 1, 1
	if arrayTable {
		openLength, closeLength = 2, 2
	}
	if !strings.HasPrefix(line, strings.Repeat("[", openLength)) ||
		!strings.HasSuffix(line, strings.Repeat("]", closeLength)) ||
		len(line) <= openLength+closeLength {
		return nil, false, false
	}
	body := line[openLength : len(line)-closeLength]
	key, ok := codexTOMLDottedKey(body)
	return key, arrayTable, ok
}

func codexTOMLDottedKey(value string) ([]string, bool) {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil, false
	}
	segments := make([]string, 0, 2)
	for len(value) > 0 {
		value = strings.TrimLeft(value, " \t")
		if value == "" {
			return nil, false
		}
		var segment string
		switch value[0] {
		case '"':
			end := 1
			escaped := false
			for ; end < len(value); end++ {
				if escaped {
					escaped = false
					continue
				}
				if value[end] == '\\' {
					escaped = true
					continue
				}
				if value[end] == '"' {
					break
				}
			}
			if end >= len(value) {
				return nil, false
			}
			unquoted, err := strconv.Unquote(value[:end+1])
			if err != nil {
				return nil, false
			}
			segment = unquoted
			value = value[end+1:]
		case '\'':
			end := strings.IndexByte(value[1:], '\'')
			if end < 0 {
				return nil, false
			}
			end++
			segment = value[1:end]
			value = value[end+1:]
		default:
			end := strings.IndexByte(value, '.')
			if end < 0 {
				end = len(value)
			}
			segment = strings.TrimSpace(value[:end])
			value = value[end:]
		}
		if segment == "" {
			return nil, false
		}
		segments = append(segments, segment)
		value = strings.TrimLeft(value, " \t")
		if value == "" {
			break
		}
		if value[0] != '.' {
			return nil, false
		}
		value = value[1:]
	}
	return segments, true
}

func codexTOMLKeyEquals(key []string, expected ...string) bool {
	if len(key) != len(expected) {
		return false
	}
	for index := range key {
		if key[index] != expected[index] {
			return false
		}
	}
	return true
}

func codexTOMLWithoutComment(line string) string {
	escaped := false
	quote := byte(0)
	for index := 0; index < len(line); index++ {
		char := line[index]
		if quote == '"' {
			if escaped {
				escaped = false
				continue
			}
			if char == '\\' {
				escaped = true
				continue
			}
			if char == quote {
				quote = 0
			}
			continue
		}
		if quote == '\'' {
			if char == quote {
				quote = 0
			}
			continue
		}
		switch char {
		case '"', '\'':
			quote = char
		case '#':
			return line[:index]
		}
	}
	return line
}

func codexTOMLUnclosedMultilineDelimiter(line string) string {
	code := codexTOMLWithoutComment(line)
	for _, delimiter := range []string{`"""`, `'''`} {
		openIndex := strings.Index(code, delimiter)
		if openIndex < 0 {
			continue
		}
		if !strings.Contains(code[openIndex+len(delimiter):], delimiter) {
			return delimiter
		}
	}
	return ""
}
