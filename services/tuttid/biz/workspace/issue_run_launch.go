package workspace

import (
	"encoding/json"
	"errors"
	"strings"
)

var ErrInvalidIssueRunLaunchPayload = errors.New("issue Run launch payload is invalid")

// IssueRunLaunchPayload is the tuttid-local immutable delivery snapshot shared
// by Issue orchestration and its SQLite adapter. It intentionally stays out of
// packages/workspace because paths are resolved in the daemon host.
type IssueRunLaunchPayload struct {
	Title              string                     `json:"title"`
	Prompt             string                     `json:"prompt"`
	Attachments        []IssueRunLaunchAttachment `json:"attachments,omitempty"`
	ExecutionDirectory string                     `json:"executionDirectory,omitempty"`
	ModelPlanID        string                     `json:"modelPlanId,omitempty"`
	Model              string                     `json:"model,omitempty"`
	ReasoningIntensity int                        `json:"reasoningIntensity,omitempty"`
}

type IssueRunLaunchAttachment struct {
	MimeType string `json:"mimeType"`
	Name     string `json:"name"`
	Path     string `json:"path"`
}

func EncodeIssueRunLaunchPayload(payload IssueRunLaunchPayload) (string, error) {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	return string(encoded), nil
}

func DecodeIssueRunLaunchPayload(encoded string) (IssueRunLaunchPayload, error) {
	if strings.TrimSpace(encoded) == "" {
		return IssueRunLaunchPayload{}, ErrInvalidIssueRunLaunchPayload
	}
	var payload IssueRunLaunchPayload
	if err := json.Unmarshal([]byte(encoded), &payload); err != nil {
		return IssueRunLaunchPayload{}, errors.Join(ErrInvalidIssueRunLaunchPayload, err)
	}
	return payload, nil
}
