package agentprovider

import "strings"

const (
	ClaudeCode  = "claude-code"
	Codex       = "codex"
	Cursor      = "cursor"
	Gemini      = "gemini"
	Hermes      = "hermes"
	Nexight     = "nexight"
	OpenClaw    = "openclaw"
	Antigravity = "antigravity"
)

var allProviders = []string{
	ClaudeCode,
	Codex,
	Cursor,
	Nexight,
	Gemini,
	Hermes,
	OpenClaw,
	Antigravity,
}

func All() []string {
	return append([]string(nil), allProviders...)
}

func Normalize(provider string) string {
	switch strings.TrimSpace(strings.ToLower(provider)) {
	case "claude", ClaudeCode:
		return ClaudeCode
	case Codex:
		return Codex
	case "cursor-agent", "cursor-cli", Cursor:
		return Cursor
	case "gemini-cli", Gemini:
		return Gemini
	case "hermes-agent", Hermes:
		return Hermes
	case "tutti", Nexight:
		return Nexight
	case "open-claw", OpenClaw:
		return OpenClaw
	case "antigravity-cli", "agy", Antigravity:
		return Antigravity
	default:
		return ""
	}
}

func IsSupported(provider string) bool {
	return Normalize(provider) != ""
}
