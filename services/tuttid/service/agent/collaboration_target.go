package agent

import (
	"context"
	"fmt"
	"net/url"
	"strings"

	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
	collabrunbiz "github.com/tutti-os/tutti/services/tuttid/biz/collabrun"
	collabrunservice "github.com/tutti-os/tutti/services/tuttid/service/collabrun"
)

const (
	recentCollaborationContextMessages = 12
	recentCollaborationContextChars    = 8 * 1024
	fullCollaborationContextMessages   = 48
	fullCollaborationContextChars      = 32 * 1024
)

// LaunchCollaborationTarget implements collabrun.TargetSessionLauncher on the
// canonical agent service. The source transcript is selected at the daemon
// boundary, so renderer callers cannot claim one context scope while sending
// another payload.
func (s *Service) LaunchCollaborationTarget(ctx context.Context, input collabrunservice.TargetSessionLaunchInput) error {
	if s == nil {
		return ErrSessionNotFound
	}
	source, err := s.Get(ctx, input.WorkspaceID, input.SourceSessionID)
	if err != nil {
		return err
	}
	contextText, err := s.collaborationSourceContext(ctx, input.WorkspaceID, input.SourceSessionID, input.ContextScope)
	if err != nil {
		return err
	}
	prompt := collaborationTargetPrompt(input, contextText)
	cwd := strings.TrimSpace(source.Cwd)
	var cwdPointer *string
	if cwd != "" {
		cwdPointer = &cwd
	}
	model := optionalCollaborationString(input.Model)
	modelPlanID := optionalCollaborationString(input.ModelPlanID)
	_, err = s.Create(ctx, input.WorkspaceID, CreateSessionInput{
		AgentSessionID:       input.TargetSessionID,
		AgentTargetID:        input.TargetAgentTargetID,
		InitialContent:       []PromptContentBlock{{Type: "text", Text: prompt}},
		InitialDisplayPrompt: strings.TrimSpace(input.Question),
		ClientSubmitID:       "collaboration-run:" + input.RunID,
		Cwd:                  cwdPointer,
		Model:                model,
		ModelPlanID:          modelPlanID,
		RuntimeContext: map[string]any{
			"collaboration": map[string]any{
				"runId":           input.RunID,
				"mode":            input.Mode,
				"sourceSessionId": input.SourceSessionID,
				"contextScope":    input.ContextScope,
			},
		},
		Metadata: map[string]any{
			"collaborationRunId": input.RunID,
		},
	})
	return err
}

func (s *Service) collaborationSourceContext(ctx context.Context, workspaceID string, sourceSessionID string, scope string) (string, error) {
	limit := 0
	maxChars := 0
	switch strings.TrimSpace(scope) {
	case "none":
		return "", nil
	case "recent":
		limit = recentCollaborationContextMessages
		maxChars = recentCollaborationContextChars
	case "full":
		limit = fullCollaborationContextMessages
		maxChars = fullCollaborationContextChars
	default:
		return "", fmt.Errorf("%w: unsupported collaboration context scope", ErrInvalidArgument)
	}
	page, err := s.ListMessages(ctx, workspaceID, sourceSessionID, ListMessagesInput{
		Limit: limit,
		Order: agentactivitybiz.MessageOrderDesc,
	})
	if err != nil {
		return "", err
	}
	lines := make([]string, 0, len(page.Messages))
	for index := len(page.Messages) - 1; index >= 0; index-- {
		message := page.Messages[index]
		role := strings.TrimSpace(message.Role)
		if role != "user" && role != "assistant" {
			continue
		}
		text := collaborationMessageText(message.Payload)
		if text == "" {
			continue
		}
		lines = append(lines, strings.ToUpper(role[:1])+role[1:]+": "+text)
	}
	contextText := strings.Join(lines, "\n\n")
	if len(contextText) > maxChars {
		contextText = "[Earlier context omitted]\n\n" + strings.TrimLeft(contextText[len(contextText)-maxChars:], "\n")
	}
	return strings.TrimSpace(contextText), nil
}

func collaborationTargetPrompt(input collabrunservice.TargetSessionLaunchInput, sourceContext string) string {
	modeInstruction := "Continue this work in an independent target session."
	switch collabrunbiz.Mode(strings.TrimSpace(input.Mode)) {
	case collabrunbiz.ModeFork:
		modeInstruction = "Fork the source work: independently re-evaluate the approach and produce a complete result without changing the source session."
	case collabrunbiz.ModeDelegate:
		modeInstruction = "Take ownership of this delegated request, complete it, and report the result clearly to the source session."
	case collabrunbiz.ModeHandoff:
		modeInstruction = "Take over this request from the source session and continue ownership of the next steps."
	}
	sections := []string{
		modeInstruction,
		"Source session: mention://agent-session/" + strings.TrimSpace(input.SourceSessionID) + "?workspaceId=" + url.QueryEscape(strings.TrimSpace(input.WorkspaceID)),
		"User request:\n\n" + strings.TrimSpace(input.Question),
	}
	if sourceContext = strings.TrimSpace(sourceContext); sourceContext != "" {
		sections = append(sections, "Selected source context ("+input.ContextScope+"):\n\n"+sourceContext)
	}
	if supplement := strings.TrimSpace(input.ContextText); supplement != "" {
		sections = append(sections, "User-supplied context supplement:\n\n"+supplement)
	}
	return strings.Join(sections, "\n\n")
}

func collaborationMessageText(payload map[string]any) string {
	for _, key := range []string{"text", "content", "message"} {
		if value, ok := payload[key].(string); ok && strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	blocks, _ := payload["content"].([]any)
	parts := make([]string, 0, len(blocks))
	for _, raw := range blocks {
		block, _ := raw.(map[string]any)
		text, _ := block["text"].(string)
		if strings.TrimSpace(text) != "" {
			parts = append(parts, strings.TrimSpace(text))
		}
	}
	return strings.Join(parts, "\n")
}

func optionalCollaborationString(value string) *string {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return &value
}
