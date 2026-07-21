package eventstream

import (
	"fmt"
	"strings"
)

type agentQuickPromptUpdatedPayload struct {
	PromptID         string `json:"promptId"`
	ChangeKind       string `json:"changeKind"`
	Version          int64  `json:"version"`
	OccurredAtUnixMS int64  `json:"occurredAtUnixMs"`
}

func validateAgentQuickPromptUpdatedPayload(payload []byte) error {
	var decoded agentQuickPromptUpdatedPayload
	if err := decodeJSONStrict(payload, &decoded); err != nil {
		return fmt.Errorf("decode payload: %w", err)
	}
	if strings.TrimSpace(decoded.PromptID) == "" {
		return fmt.Errorf("promptId is required")
	}
	switch decoded.ChangeKind {
	case "created", "updated", "deleted":
	default:
		return fmt.Errorf("changeKind is unsupported")
	}
	if decoded.Version < 1 {
		return fmt.Errorf("version must be positive")
	}
	if decoded.OccurredAtUnixMS < 1 {
		return fmt.Errorf("occurredAtUnixMs must be positive")
	}
	return nil
}
