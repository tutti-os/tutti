package agentruntime

import "strings"

const (
	AgentConversationDetailModeCoding  = "coding"
	AgentConversationDetailModeGeneral = "general"
)

func normalizeAgentConversationDetailMode(value string) string {
	switch strings.TrimSpace(value) {
	case AgentConversationDetailModeGeneral:
		return AgentConversationDetailModeGeneral
	default:
		return AgentConversationDetailModeCoding
	}
}
