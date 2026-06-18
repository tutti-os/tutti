package agent

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
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
			if message.Text != "" {
				session.Messages = append(session.Messages, message)
			}
		case "event_msg":
			payload := mapField(raw, "payload")
			if stringField(payload, "type") == "user_message" {
				session.Title = firstNonEmptyString(session.Title, externalContentText(payload["message"]))
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
			RawID:            rawID,
			Role:             normalizeExternalMessageRole(stringField(payload, "role")),
			Text:             externalContentText(payload["content"]),
			OccurredAtUnixMS: timestamp,
		}
	case "function_call":
		name := firstNonEmptyString(stringField(payload, "name"), stringField(payload, "call_id"))
		return externalImportedMessage{
			RawID:            rawID,
			Role:             "assistant",
			Text:             externalToolText(name),
			OccurredAtUnixMS: timestamp,
		}
	case "function_call_output":
		return externalImportedMessage{
			RawID:            rawID,
			Role:             "tool",
			Text:             firstNonEmptyString(externalContentText(payload["output"]), externalContentText(payload["content"])),
			OccurredAtUnixMS: timestamp,
		}
	default:
		return externalImportedMessage{}
	}
}

func parseClaudeCodeJSONL(path string, reader io.Reader) (externalImportedSession, bool, error) {
	session := externalImportedSession{Provider: agentproviderbiz.ClaudeCode, SourcePath: path}
	err := readJSONLLines(reader, func(index int, raw map[string]any) {
		session.ProviderSessionID = firstNonEmptyString(session.ProviderSessionID, stringField(raw, "sessionId"), stringField(raw, "session_id"))
		session.Cwd = firstNonEmptyString(session.Cwd, stringField(raw, "cwd"))
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
			Text:             externalContentText(content),
			OccurredAtUnixMS: unixMSFromAny(raw["timestamp"]),
		}
		if message.Text != "" {
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
	session.Cwd = cwd
	messages := make([]externalImportedMessage, 0, len(session.Messages))
	for i, message := range session.Messages {
		message.Role = normalizeExternalMessageRole(message.Role)
		message.Text = strings.TrimSpace(message.Text)
		if message.Role == "" || message.Text == "" {
			continue
		}
		if message.RawID == "" {
			message.RawID = strconv.Itoa(i)
		}
		messages = append(messages, message)
	}
	if len(messages) == 0 {
		return externalImportedSession{}, false, nil
	}
	session.Messages = messages
	session.StartedAtUnixMS = firstExternalMessageUnixMS(messages)
	session.UpdatedAtUnixMS = lastExternalMessageUnixMS(messages)
	session.Title = externalParsedSessionTitle(session.Title, messages)
	return session, true, nil
}

func externalParsedSessionTitle(hint string, messages []externalImportedMessage) string {
	if hint = strings.TrimSpace(hint); hint != "" {
		return truncateExternalTitle(hint)
	}
	for _, message := range messages {
		if message.Role == "user" && !strings.HasPrefix(message.Text, "<environment_context>") {
			return truncateExternalTitle(message.Text)
		}
	}
	return externalSessionTitle(messages)
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
