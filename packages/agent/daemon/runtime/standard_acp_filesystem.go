package agentruntime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

const acpMethodWriteTextFile = "fs/write_text_file"

type acpWriteTextFileParams struct {
	SessionID string `json:"sessionId"`
	Path      string `json:"path"`
	Content   string `json:"content"`
}

func standardACPWriteTextFileEvents(
	ctx context.Context,
	client *acpClient,
	session Session,
	turnID string,
	message acpMessage,
	normalizer *acpTurnNormalizer,
) ([]activityshared.Event, error) {
	if client == nil {
		return nil, errors.New("ACP client is unavailable")
	}
	if normalizer == nil || strings.TrimSpace(turnID) == "" {
		return nil, respondACPWriteTextFileError(
			ctx,
			client,
			message.ID,
			-32000,
			"file writes require an active turn",
		)
	}
	var params acpWriteTextFileParams
	if err := json.Unmarshal(message.Params, &params); err != nil {
		return nil, respondACPWriteTextFileError(ctx, client, message.ID, -32602, "invalid file write parameters")
	}
	params.SessionID = strings.TrimSpace(params.SessionID)
	params.Path = strings.TrimSpace(params.Path)
	if params.SessionID == "" || params.Path == "" || !filepath.IsAbs(params.Path) {
		return nil, respondACPWriteTextFileError(ctx, client, message.ID, -32602, "sessionId and an absolute path are required")
	}
	providerSessionID := strings.TrimSpace(session.ProviderSessionID)
	if providerSessionID == "" || params.SessionID != providerSessionID {
		return nil, respondACPWriteTextFileError(ctx, client, message.ID, -32602, "file write session does not match the active session")
	}

	previous, err := os.ReadFile(params.Path)
	change := "modified"
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			return nil, respondACPWriteTextFileError(ctx, client, message.ID, -32000, fmt.Sprintf("unable to read existing file: %v", err))
		}
		previous = nil
		change = "added"
	}
	if string(previous) == params.Content && change == "modified" {
		return nil, client.Respond(ctx, message.ID, nil, nil)
	}
	if err := os.WriteFile(params.Path, []byte(params.Content), 0o666); err != nil {
		return nil, respondACPWriteTextFileError(ctx, client, message.ID, -32000, fmt.Sprintf("unable to write file: %v", err))
	}

	events := normalizer.recordFileChangesEvents(session, turnID, []map[string]any{{
		"path":      params.Path,
		"change":    change,
		"oldString": string(previous),
		"newString": params.Content,
	}})
	return events, client.Respond(ctx, message.ID, nil, nil)
}

func respondACPWriteTextFileError(
	ctx context.Context,
	client *acpClient,
	id json.RawMessage,
	code int,
	message string,
) error {
	return client.Respond(ctx, id, nil, &acpError{Code: code, Message: message})
}
