package agentprovider

import "strings"

const (
	ClaudeCode = "claude-code"
	Codex      = "codex"
	Cursor     = "cursor"
	Hermes     = "hermes"
	Nexight    = "nexight"
	OpenClaw   = "openclaw"
	OpenCode   = "opencode"
	TuttiAgent = "tutti-agent"
)

var allProviders = []string{
	ClaudeCode,
	Codex,
	TuttiAgent,
	Cursor,
	Nexight,
	Hermes,
	OpenClaw,
	OpenCode,
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
	case TuttiAgent:
		return TuttiAgent
	case "cursor-agent", "cursor-cli", Cursor:
		return Cursor
	case "hermes-agent", Hermes:
		return Hermes
	case "tutti", Nexight:
		return Nexight
	case "open-claw", OpenClaw:
		return OpenClaw
	case "open-code", "opencode-ai", OpenCode:
		return OpenCode
	default:
		return ""
	}
}

func IsSupported(provider string) bool {
	return Normalize(provider) != ""
}
