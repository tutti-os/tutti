package agent

import (
	"context"
	"strings"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
)

// SideConversation is a runtime-only projection. It must never be converted
// to, or persisted as, a canonical Session.
type SideConversation struct {
	WorkspaceID          string
	SourceAgentSessionID string
	SideAgentSessionID   string
	Provider             string
	Status               string
	Capabilities         agenthost.SideConversationCapabilities
}

type OpenSideConversationInput struct {
	SideAgentSessionID string
	RequestID          string
}

type SendSideConversationInput struct {
	TurnID         string
	ClientSubmitID string
	Content        []PromptContentBlock
	DisplayPrompt  string
}

func (s *Service) ResolveSideConversation(
	ctx context.Context,
	workspaceID string,
	sourceAgentSessionID string,
) (agenthost.SideConversationCapabilities, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	sourceAgentSessionID = strings.TrimSpace(sourceAgentSessionID)
	if workspaceID == "" || sourceAgentSessionID == "" {
		return agenthost.SideConversationCapabilities{}, ErrInvalidArgument
	}
	return s.ApplicationHost().ResolveSideConversation(
		ctx,
		workspaceID,
		sourceAgentSessionID,
	)
}

func (s *Service) OpenSideConversation(
	ctx context.Context,
	workspaceID string,
	sourceAgentSessionID string,
	input OpenSideConversationInput,
) (SideConversation, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	sourceAgentSessionID = strings.TrimSpace(sourceAgentSessionID)
	input.SideAgentSessionID = strings.TrimSpace(input.SideAgentSessionID)
	input.RequestID = strings.TrimSpace(input.RequestID)
	if workspaceID == "" || sourceAgentSessionID == "" ||
		input.SideAgentSessionID == "" || input.RequestID == "" {
		return SideConversation{}, ErrInvalidArgument
	}
	result, err := s.ApplicationHost().OpenSideConversation(
		ctx,
		agenthost.OpenSideConversationInput{
			WorkspaceID:          workspaceID,
			SourceAgentSessionID: sourceAgentSessionID,
			SideAgentSessionID:   input.SideAgentSessionID,
			RequestID:            input.RequestID,
		},
	)
	if err != nil {
		return SideConversation{}, err
	}
	return SideConversation{
		WorkspaceID:          result.Session.WorkspaceID,
		SourceAgentSessionID: result.Session.SourceAgentSessionID,
		SideAgentSessionID:   result.Session.ID,
		Provider:             result.Session.Provider,
		Status:               result.Session.Status,
		Capabilities:         result.Capabilities,
	}, nil
}

func (s *Service) SendSideConversation(
	ctx context.Context,
	workspaceID string,
	sideAgentSessionID string,
	input SendSideConversationInput,
) (agenthost.RuntimeExecResult, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	sideAgentSessionID = strings.TrimSpace(sideAgentSessionID)
	input.TurnID = strings.TrimSpace(input.TurnID)
	input.ClientSubmitID = strings.TrimSpace(input.ClientSubmitID)
	if workspaceID == "" || sideAgentSessionID == "" ||
		input.TurnID == "" || input.ClientSubmitID == "" ||
		len(input.Content) == 0 {
		return agenthost.RuntimeExecResult{}, ErrInvalidArgument
	}
	return s.ApplicationHost().SendSideConversation(ctx, agenthost.RuntimeExecInput{
		WorkspaceID:    workspaceID,
		AgentSessionID: sideAgentSessionID,
		TurnID:         input.TurnID,
		ClientSubmitID: input.ClientSubmitID,
		Content:        append([]PromptContentBlock(nil), input.Content...),
		DisplayPrompt:  input.DisplayPrompt,
	})
}

func (s *Service) CancelSideConversation(
	ctx context.Context,
	workspaceID string,
	sideAgentSessionID string,
	turnID string,
) (agenthost.RuntimeCancelResult, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	sideAgentSessionID = strings.TrimSpace(sideAgentSessionID)
	turnID = strings.TrimSpace(turnID)
	if workspaceID == "" || sideAgentSessionID == "" || turnID == "" {
		return agenthost.RuntimeCancelResult{}, ErrInvalidArgument
	}
	return s.ApplicationHost().CancelSideConversation(
		ctx,
		workspaceID,
		sideAgentSessionID,
		turnID,
		"user_requested",
	)
}

func (s *Service) SubmitSideConversationInteractive(
	ctx context.Context,
	input agenthost.RuntimeSubmitInteractiveInput,
) (agenthost.RuntimeSubmitInteractiveResult, error) {
	input.WorkspaceID = strings.TrimSpace(input.WorkspaceID)
	input.RootAgentSessionID = strings.TrimSpace(input.RootAgentSessionID)
	input.AgentSessionID = strings.TrimSpace(input.AgentSessionID)
	input.TurnID = strings.TrimSpace(input.TurnID)
	input.RequestID = strings.TrimSpace(input.RequestID)
	if input.WorkspaceID == "" || input.AgentSessionID == "" ||
		input.RootAgentSessionID != input.AgentSessionID ||
		input.TurnID == "" || input.RequestID == "" {
		return agenthost.RuntimeSubmitInteractiveResult{}, ErrInvalidArgument
	}
	return s.ApplicationHost().SubmitSideConversationInteractive(ctx, input)
}

func (s *Service) CloseSideConversation(
	ctx context.Context,
	workspaceID string,
	sideAgentSessionID string,
) error {
	workspaceID = strings.TrimSpace(workspaceID)
	sideAgentSessionID = strings.TrimSpace(sideAgentSessionID)
	if workspaceID == "" || sideAgentSessionID == "" {
		return ErrInvalidArgument
	}
	return s.ApplicationHost().CloseSideConversation(
		ctx,
		workspaceID,
		sideAgentSessionID,
	)
}
