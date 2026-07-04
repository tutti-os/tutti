package agentsidecar

import "strings"

const (
	agentConversationDetailModeCoding  = "coding"
	agentConversationDetailModeGeneral = "general"
)

func agentConversationDetailModeSystemPromptAppend(conversationDetailMode string) string {
	instructions := agentConversationDetailModeInstructions(conversationDetailMode)
	if strings.TrimSpace(instructions) == "" {
		return ""
	}
	return instructions
}

func agentConversationDetailModeInstructions(conversationDetailMode string) string {
	switch normalizeAgentConversationDetailMode(conversationDetailMode) {
	case agentConversationDetailModeGeneral:
		return nonTechnicalUIConversationDetailModeInstructions
	default:
		return ""
	}
}

func normalizeAgentConversationDetailMode(conversationDetailMode string) string {
	switch strings.TrimSpace(conversationDetailMode) {
	case agentConversationDetailModeGeneral:
		return agentConversationDetailModeGeneral
	default:
		return agentConversationDetailModeCoding
	}
}

func joinPromptSections(sections ...string) string {
	trimmed := make([]string, 0, len(sections))
	for _, section := range sections {
		if value := strings.TrimSpace(section); value != "" {
			trimmed = append(trimmed, value)
		}
	}
	return strings.Join(trimmed, "\n\n")
}

const nonTechnicalUIConversationDetailModeInstructions = `### Non-technical UI
- The user has requested a non-technical UI.
- The app will take care of aspects of this, such as hiding bash tool outputs and similar.
- Prefer non-technical language when conversing with the user. For example, don't name bash commands you're running. Instead, describe what they do.
- When writing code to perform non-coding tasks--such as writing and running python to build slide artifacts--avoid mentioning or citing these intermediate code items. Just focus on outputs.
- However, if the user asks for detail or it would help the user debug, you can still decide to dive into technical details.`
