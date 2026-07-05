package agentruntime

import (
	"regexp"
	"strings"
)

const tuttiMentionRoutingReminder = "<system-reminder>mention:// links are Tutti internal references; use the exact visible tutti-cli skill first to route them.</system-reminder>"

var markdownMentionURIRegex = regexp.MustCompile(`\[(?:\\.|[^\]\\\r\n])*\]\((mention://[A-Za-z0-9][A-Za-z0-9._~-]*(?:[/?#][^\s)]*)?)\)`)

func tuttiMentionRoutingSkills(visibleText string) (bool, []string) {
	var skills []string
	seenSkills := map[string]struct{}{}
	for _, mention := range extractMentionURIs(visibleText) {
		skill := skillForMentionURI(mention)
		if skill == "" {
			continue
		}
		if _, ok := seenSkills[skill]; !ok {
			skills = append(skills, skill)
			seenSkills[skill] = struct{}{}
		}
	}
	return len(skills) > 0, skills
}

func skillForMentionURI(uri string) string {
	switch {
	case strings.HasPrefix(uri, "mention://workspace-issue/"):
		return "issue-manager"
	case strings.HasPrefix(uri, "mention://workspace-app/"):
		return "workspace-app"
	case strings.HasPrefix(uri, "mention://workspace-reference/"):
		return "reference"
	case strings.HasPrefix(uri, "mention://agent-session/"):
		return "tutti-cli"
	case strings.HasPrefix(uri, "mention://agent-target/"):
		return "tutti-cli"
	default:
		return ""
	}
}

func extractMentionURIs(text string) []string {
	var mentions []string
	seen := map[string]struct{}{}
	for _, match := range markdownMentionURIRegex.FindAllStringSubmatch(text, -1) {
		if len(match) < 2 {
			continue
		}
		mention := strings.TrimSpace(match[1])
		if _, ok := seen[mention]; mention != "" && !ok {
			mentions = append(mentions, mention)
			seen[mention] = struct{}{}
		}
	}
	return mentions
}

func isInternalMentionRoutingTitle(title string) bool {
	return strings.HasPrefix(strings.TrimSpace(title), tuttiMentionRoutingReminder)
}

func appendTuttiMentionRoutingPrompt(content []map[string]any, skills []string) []map[string]any {
	routingPrompt := strings.TrimSpace(tuttiMentionRoutingPrompt(skills))
	if routingPrompt == "" {
		return content
	}
	out := make([]map[string]any, 0, len(content)+1)
	out = append(out, content...)
	out = append(out, map[string]any{
		"type": "text",
		"text": routingPrompt,
	})
	return out
}

func appendTuttiMentionRoutingContent(content []PromptContentBlock, skills []string) []PromptContentBlock {
	routingPrompt := strings.TrimSpace(tuttiMentionRoutingPrompt(skills))
	if routingPrompt == "" {
		return content
	}
	out := make([]PromptContentBlock, 0, len(content)+1)
	out = append(out, content...)
	out = append(out, PromptContentBlock{
		Type: "text",
		Text: routingPrompt,
	})
	return out
}

func tuttiMentionRoutingPrompt(skills []string) string {
	for _, skill := range skills {
		if strings.TrimSpace(skill) != "" {
			return tuttiMentionRoutingReminder
		}
	}
	return ""
}
