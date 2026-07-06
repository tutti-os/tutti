package agent

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	agentproviderbiz "github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
)

func parseCodexJSONL(path string, reader io.Reader) (externalImportedSession, bool, error) {
	session := externalImportedSession{Provider: agentproviderbiz.Codex, SourcePath: path}
	err := readJSONLLines(reader, func(index int, raw map[string]any) {
		timestamp := unixMSFromAny(raw["timestamp"])
		switch stringField(raw, "type") {
		case "session_meta":
			payload := mapField(raw, "payload")
			session.ProviderSessionID = firstNonEmptyString(
				stringField(raw, "id"),
				stringField(raw, "session_id"),
				stringField(payload, "id"),
				stringField(payload, "session_id"),
			)
			session.Cwd = firstNonEmptyString(session.Cwd, stringField(raw, "cwd"), stringField(payload, "cwd"))
		case "response_item":
			payload := mapField(raw, "payload")
			message := codexMessageFromPayload(payload, index, timestamp)
			if externalImportedMessageHasContent(message) {
				session.Messages = append(session.Messages, message)
			}
		case "event_msg":
			payload := mapField(raw, "payload")
			if stringField(payload, "type") == "user_message" {
				messageText := externalContentText(payload["message"])
				session.Title = firstNonEmptyString(session.Title, messageText)
				if text, ok := externalImportDisplayTextCandidate(session.Provider, messageText); ok {
					session.EventUserMessage = externalImportedMessage{
						RawID:             "event:" + strconv.Itoa(index),
						Role:              "user",
						Kind:              "text",
						Status:            "completed",
						Text:              text,
						OccurredAtUnixMS:  timestamp,
						StartedAtUnixMS:   timestamp,
						CompletedAtUnixMS: timestamp,
					}
				}
			}
		}
	})
	if err != nil {
		return externalImportedSession{}, false, err
	}
	return normalizeExternalParsedSession(session)
}

func codexMessageFromPayload(payload map[string]any, index int, timestamp int64) externalImportedMessage {
	itemType := stringField(payload, "type")
	rawID := firstNonEmptyString(stringField(payload, "id"), strconv.Itoa(index))
	switch itemType {
	case "message":
		return externalImportedMessage{
			RawID:             rawID,
			Role:              normalizeExternalMessageRole(stringField(payload, "role")),
			Kind:              "text",
			Status:            "completed",
			Text:              externalContentText(payload["content"]),
			OccurredAtUnixMS:  timestamp,
			StartedAtUnixMS:   timestamp,
			CompletedAtUnixMS: timestamp,
		}
	case "function_call":
		return codexFunctionCallMessage(payload, rawID, timestamp)
	case "function_call_output":
		return codexFunctionCallOutputMessage(payload, rawID, timestamp)
	default:
		return externalImportedMessage{}
	}
}

func codexFunctionCallMessage(payload map[string]any, rawID string, timestamp int64) externalImportedMessage {
	callID := stringField(payload, "call_id")
	name := firstNonEmptyString(stringField(payload, "name"), callID)
	arguments := codexFunctionCallArguments(payload["arguments"])
	toolPayload := map[string]any{
		"source":   "external_import",
		"provider": agentproviderbiz.Codex,
		"status":   "running",
	}
	if callID != "" {
		toolPayload["callId"] = callID
	}
	if name != "" {
		toolPayload["name"] = name
		toolPayload["toolName"] = name
	}
	if len(arguments) > 0 {
		toolPayload["input"] = arguments
	}
	return externalImportedMessage{
		RawID:            rawID,
		MessageIDSeed:    codexToolMessageIDSeed(rawID, callID),
		Role:             "assistant",
		Kind:             "tool_call",
		Status:           "running",
		Text:             name,
		Payload:          toolPayload,
		OccurredAtUnixMS: timestamp,
		StartedAtUnixMS:  timestamp,
	}
}

func codexFunctionCallOutputMessage(payload map[string]any, rawID string, timestamp int64) externalImportedMessage {
	callID := stringField(payload, "call_id")
	output := firstNonEmptyString(externalContentText(payload["output"]), externalContentText(payload["content"]))
	toolPayload := map[string]any{
		"source":   "external_import",
		"provider": agentproviderbiz.Codex,
		"status":   "completed",
		"output": map[string]any{
			"output": output,
		},
	}
	if callID != "" {
		toolPayload["callId"] = callID
	}
	return externalImportedMessage{
		RawID:             rawID,
		MessageIDSeed:     codexToolMessageIDSeed(rawID, callID),
		Role:              "assistant",
		Kind:              "tool_call",
		Status:            "completed",
		Text:              output,
		Payload:           toolPayload,
		OccurredAtUnixMS:  timestamp,
		CompletedAtUnixMS: timestamp,
	}
}

func codexToolMessageIDSeed(rawID string, callID string) string {
	if callID = strings.TrimSpace(callID); callID != "" {
		return "toolcall:" + callID
	}
	return "toolcall:" + strings.TrimSpace(rawID)
}

func codexFunctionCallArguments(value any) map[string]any {
	switch typed := value.(type) {
	case map[string]any:
		return typed
	case string:
		trimmed := strings.TrimSpace(typed)
		if trimmed == "" {
			return nil
		}
		var decoded map[string]any
		if err := json.Unmarshal([]byte(trimmed), &decoded); err == nil {
			return decoded
		}
		return map[string]any{"arguments": trimmed}
	default:
		return nil
	}
}

func parseClaudeCodeJSONL(path string, reader io.Reader) (externalImportedSession, bool, error) {
	session := externalImportedSession{Provider: agentproviderbiz.ClaudeCode, SourcePath: path}
	err := readJSONLLines(reader, func(index int, raw map[string]any) {
		session.ProviderSessionID = firstNonEmptyString(session.ProviderSessionID, stringField(raw, "sessionId"), stringField(raw, "session_id"))
		session.Cwd = firstNonEmptyString(session.Cwd, stringField(raw, "cwd"))
		// Claude Code records the human/auto-generated conversation title inline.
		// `custom-title` is the canonical rename; the older `summary` line is a
		// fallback. The last occurrence wins.
		switch stringField(raw, "type") {
		case "custom-title":
			if title := strings.TrimSpace(stringField(raw, "customTitle")); title != "" {
				session.SummaryTitle = title
			}
		case "summary":
			if title := strings.TrimSpace(stringField(raw, "summary")); title != "" {
				session.SummaryTitle = title
			}
		}
		messageMap := mapField(raw, "message")
		if len(messageMap) == 0 {
			return
		}
		role := normalizeExternalMessageRole(stringField(messageMap, "role"))
		content := messageMap["content"]
		if role == "user" && isPureExternalToolResult(content) {
			role = "tool"
		}
		message := externalImportedMessage{
			RawID:            firstNonEmptyString(stringField(raw, "uuid"), stringField(messageMap, "id"), strconv.Itoa(index)),
			Role:             role,
			Kind:             "text",
			Status:           "completed",
			Text:             externalContentText(content),
			OccurredAtUnixMS: unixMSFromAny(raw["timestamp"]),
		}
		if message.Text != "" {
			message.StartedAtUnixMS = message.OccurredAtUnixMS
			message.CompletedAtUnixMS = message.OccurredAtUnixMS
			session.Messages = append(session.Messages, message)
		}
	})
	if err != nil {
		return externalImportedSession{}, false, err
	}
	return normalizeExternalParsedSession(session)
}

func normalizeExternalParsedSession(session externalImportedSession) (externalImportedSession, bool, error) {
	if strings.TrimSpace(session.ProviderSessionID) == "" {
		session.ProviderSessionID = externalStableHash(session.Provider + "\x00" + session.SourcePath)
	}
	cwd, ok := canonicalExistingDir(session.Cwd)
	if !ok {
		return externalImportedSession{}, false, nil
	}
	// A session that ran inside a linked git worktree (e.g. a coding agent's
	// own per-task checkout under ~/.codex/worktrees/<id>/<repo>) still has
	// its own `.git` file, so left unresolved it looks like an independent
	// project rooted at the worktree instead of lining up with the main
	// checkout the user actually registered as their project. Resolve it
	// upfront so every downstream consumer of this cwd (project-path
	// grouping, selection matching, and the persisted session record the GUI
	// groups conversations by) agrees on the same canonical project
	// identity.
	if resolved, ok := resolveExternalImportWorktreeCwd(cwd); ok {
		cwd = resolved
	}
	session.Cwd = cwd
	session.NoProject = isExternalImportNoProjectCwd(session.Provider, cwd)
	messages := make([]externalImportedMessage, 0, len(session.Messages))
	for i, message := range session.Messages {
		message.Role = normalizeExternalMessageRole(message.Role)
		message.Kind = normalizeExternalMessageKind(message.Kind)
		message.Status = normalizeExternalMessageStatus(message.Status)
		message.Text = strings.TrimSpace(message.Text)
		if message.Role == "user" && message.Kind == "text" {
			cleanedText, ok := externalImportDisplayTextCandidate(session.Provider, message.Text)
			if !ok {
				continue
			}
			message.Text = cleanedText
		}
		if message.Role == "" || !externalImportedMessageHasContent(message) {
			continue
		}
		if message.RawID == "" {
			message.RawID = strconv.Itoa(i)
		}
		if message.OccurredAtUnixMS <= 0 {
			message.OccurredAtUnixMS = firstNonZeroInt64(message.CompletedAtUnixMS, message.StartedAtUnixMS)
		}
		if message.StartedAtUnixMS <= 0 && message.Kind == "text" {
			message.StartedAtUnixMS = message.OccurredAtUnixMS
		}
		if message.CompletedAtUnixMS <= 0 && message.Status == "completed" {
			message.CompletedAtUnixMS = message.OccurredAtUnixMS
		}
		messages = append(messages, message)
	}
	if len(messages) == 0 {
		if externalImportedMessageHasContent(session.EventUserMessage) {
			messages = append(messages, session.EventUserMessage)
		}
		if len(messages) == 0 {
			return externalImportedSession{}, false, nil
		}
	}
	session.Messages = messages
	session.StartedAtUnixMS = firstExternalMessageUnixMS(messages)
	session.UpdatedAtUnixMS = lastExternalMessageUnixMS(messages)
	session.Title = resolveExternalSessionTitle(session.Provider, session.SummaryTitle, session.Title, messages)
	return session, true, nil
}

func isExternalImportNoProjectCwd(provider string, cwd string) bool {
	home, err := os.UserHomeDir()
	if err != nil {
		return false
	}
	home, ok := canonicalExistingDir(home)
	if !ok {
		return false
	}
	cwd = filepath.Clean(cwd)
	home = filepath.Clean(home)
	if cwd == home {
		return true
	}
	return agentproviderbiz.Normalize(provider) == agentproviderbiz.Codex &&
		isExternalImportCodexScratchCwd(home, cwd)
}

func isExternalImportCodexScratchCwd(home string, cwd string) bool {
	rel, err := filepath.Rel(home, cwd)
	if err != nil || rel == "." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || rel == ".." {
		return false
	}
	parts := strings.Split(filepath.ToSlash(rel), "/")
	if len(parts) != 4 || parts[0] != "Documents" || parts[1] != "Codex" || parts[3] == "" {
		return false
	}
	return isExternalImportDateSegment(parts[2])
}

func isExternalImportDateSegment(value string) bool {
	if len(value) != len("2006-01-02") || value[4] != '-' || value[7] != '-' {
		return false
	}
	for index, char := range value {
		if index == 4 || index == 7 {
			continue
		}
		if char < '0' || char > '9' {
			return false
		}
	}
	return true
}

func externalImportedMessageHasContent(message externalImportedMessage) bool {
	if strings.TrimSpace(message.Text) != "" {
		return true
	}
	return strings.TrimSpace(message.Kind) == "tool_call" && len(message.Payload) > 0
}

// resolveExternalSessionTitle picks the best conversation title using the
// priority: provider-supplied summary title -> first real user message (with
// system preambles skipped) -> raw first message text.
func resolveExternalSessionTitle(provider string, summaryTitle string, hint string, messages []externalImportedMessage) string {
	if title, ok := externalImportTitleCandidate(provider, summaryTitle); ok {
		return truncateExternalTitle(title)
	}
	if title, ok := externalImportTitleCandidate(provider, hint); ok {
		return truncateExternalTitle(title)
	}
	for _, message := range messages {
		if message.Role != "user" {
			continue
		}
		if title, ok := externalImportTitleCandidate(provider, message.Text); ok {
			return truncateExternalTitle(title)
		}
	}
	return externalSessionTitle(messages)
}

// VS Code injects IDE context ahead of the real Codex prompt; the actual
// request lives under the final "## My request for Codex:" heading.
const (
	codexIDEContextPrefix       = "# Context from my IDE setup:"
	codexRequestMarker          = "my request for codex"
	tuttiMentionRoutingReminder = "<system-reminder>mention:// links are Tutti internal references; use the exact visible tutti-cli skill first to route them.</system-reminder>"
)

// externalImportTitleCandidate cleans a user message for use as a session title,
// returning false when the text is a system-injected preamble that should not be
// surfaced. The Codex/Claude preamble rules are ported from cc-switch (MIT, see
// NOTICE).
func externalImportTitleCandidate(provider string, text string) (string, bool) {
	return externalImportCleanUserText(provider, text)
}

func externalImportDisplayTextCandidate(provider string, text string) (string, bool) {
	return externalImportCleanUserText(provider, text)
}

func externalImportCleanUserText(provider string, text string) (string, bool) {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return "", false
	}
	trimmed = stripTuttiMentionRoutingReminder(trimmed)
	if trimmed == "" {
		return "", false
	}
	switch provider {
	case agentproviderbiz.ClaudeCode:
		if strings.Contains(trimmed, "<local-command-caveat>") || strings.HasPrefix(trimmed, "<command-name>") {
			return "", false
		}
		return trimmed, true
	default:
		if strings.HasPrefix(trimmed, "# AGENTS.md") || strings.HasPrefix(trimmed, "<environment_context>") {
			return "", false
		}
		if strings.HasPrefix(trimmed, codexIDEContextPrefix) {
			return extractCodexPromptFromIDEContext(trimmed)
		}
		return trimmed, true
	}
}

func stripTuttiMentionRoutingReminder(text string) string {
	trimmed := strings.TrimSpace(text)
	if !strings.HasSuffix(trimmed, tuttiMentionRoutingReminder) {
		return trimmed
	}
	return strings.TrimSpace(strings.TrimSuffix(trimmed, tuttiMentionRoutingReminder))
}

func extractCodexPromptFromIDEContext(text string) (string, bool) {
	normalized := strings.ReplaceAll(text, "\r\n", "\n")
	lines := strings.Split(normalized, "\n")
	prompt := ""
	found := false
	for index, line := range lines {
		inline, ok := codexRequestHeadingPayload(line)
		if !ok {
			continue
		}
		if inline != "" {
			prompt = inline
			found = true
			continue
		}
		following := strings.TrimSpace(strings.Join(lines[index+1:], "\n"))
		prompt = following
		found = following != ""
	}
	if !found || strings.TrimSpace(prompt) == "" {
		return "", false
	}
	return strings.TrimSpace(prompt), true
}

func codexRequestHeadingPayload(line string) (string, bool) {
	trimmed := strings.TrimSpace(line)
	if !strings.HasPrefix(trimmed, "#") {
		return "", false
	}
	heading := strings.TrimLeft(trimmed, "#")
	heading = strings.TrimLeft(heading, " \t")
	if !strings.HasPrefix(strings.ToLower(heading), codexRequestMarker) {
		return "", false
	}
	suffix := strings.TrimLeft(heading[len(codexRequestMarker):], " \t")
	if suffix == "" {
		return "", true
	}
	separator := []rune(suffix)[0]
	switch separator {
	case ':', '：', '-', '—':
	default:
		return "", false
	}
	return strings.TrimSpace(strings.TrimLeft(suffix, ":：-— \t")), true
}

func readJSONLLines(reader io.Reader, handle func(int, map[string]any)) error {
	buf := bufio.NewReader(reader)
	for index := 0; ; index++ {
		line, err := buf.ReadString('\n')
		if err != nil && !errors.Is(err, io.EOF) {
			return err
		}
		line = strings.TrimSpace(line)
		if line != "" {
			var raw map[string]any
			if decodeErr := json.Unmarshal([]byte(line), &raw); decodeErr != nil {
				return decodeErr
			}
			handle(index, raw)
		}
		if errors.Is(err, io.EOF) {
			return nil
		}
	}
}
