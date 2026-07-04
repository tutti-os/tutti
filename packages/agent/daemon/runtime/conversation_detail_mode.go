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

func agentConversationDetailModeDeveloperInstructions(conversationDetailMode string) string {
	switch normalizeAgentConversationDetailMode(conversationDetailMode) {
	case AgentConversationDetailModeGeneral:
		return nonTechnicalUIConversationDetailModeDeveloperInstructions
	default:
		return ""
	}
}

func agentConversationDetailModePromptAppend(settings SessionSettings) string {
	instructions := agentConversationDetailModeDeveloperInstructions(settings.ConversationDetailMode)
	if strings.TrimSpace(instructions) == "" {
		return ""
	}
	return instructions
}

func promptHasAgentConversationDetailMode(content string) bool {
	return strings.Contains(content, "### Non-technical UI")
}

const nonTechnicalUIConversationDetailModeDeveloperInstructions = `### Non-technical UI
- The user has requested a non-technical UI.
- The app will take care of aspects of this, such as hiding bash tool outputs and similar.
- Prefer non-technical language when conversing with the user. For example, don't name bash commands you're running. Instead, describe what they do.
- When writing code to perform non-coding tasks--such as writing and running python to build slide artifacts--avoid mentioning or citing these intermediate code items. Just focus on outputs.
- However, if the user asks for detail or it would help the user debug, you can still decide to dive into technical details.`
