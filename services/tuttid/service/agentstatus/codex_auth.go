package agentstatus

import (
	"encoding/json"
	"os"
	"strings"
)

// parseCodexAuthMarkerFile validates the current AuthDotJson shapes written by
// Codex: either a non-empty OPENAI_API_KEY or a refreshable ChatGPT token set.
func parseCodexAuthMarkerFile(path string) (AuthInfo, bool) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return AuthInfo{}, false
	}
	var payload struct {
		AuthMode     string `json:"auth_mode"`
		OpenAIAPIKey string `json:"OPENAI_API_KEY"`
		Tokens       *struct {
			AccessToken  string `json:"access_token"`
			RefreshToken string `json:"refresh_token"`
			AccountID    string `json:"account_id"`
		} `json:"tokens"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return AuthInfo{}, false
	}
	if strings.TrimSpace(payload.OpenAIAPIKey) != "" {
		return AuthInfo{Status: AuthAuthenticated, AuthMethod: "apiKey"}, true
	}
	if payload.Tokens != nil &&
		strings.TrimSpace(payload.Tokens.AccessToken) != "" &&
		strings.TrimSpace(payload.Tokens.RefreshToken) != "" {
		return AuthInfo{
			Status:       AuthAuthenticated,
			AccountLabel: strings.TrimSpace(payload.Tokens.AccountID),
			AuthMethod:   firstNonBlank(strings.TrimSpace(payload.AuthMode), "chatgpt"),
		}, true
	}
	return AuthInfo{Status: AuthRequired}, true
}
