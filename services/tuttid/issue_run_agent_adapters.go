package main

import (
	"context"
	"errors"
	"strings"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	agentstoresqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
	workspaceservice "github.com/tutti-os/tutti/services/tuttid/service/workspace"
)

type issueRunAgentSessionCreator interface {
	CreateWithResult(context.Context, string, agentservice.CreateSessionInput) (agentservice.CreateSessionResult, error)
}

type issueRunCanonicalTurnFinder interface {
	FindTurnByClientSubmitID(context.Context, agenthost.SessionRef, string) (string, bool, error)
}

type issueRunSessionCanceller struct {
	Host     issueRunSettlementHost
	Sessions *agentservice.Service
}

type issueRunSettlementHost interface {
	issueRunCanonicalTurnFinder
	GetTurn(context.Context, agenthost.SessionRef, string) (agentstoresqlite.Turn, bool, error)
}

type issueRunSettlementReader struct {
	Host issueRunSettlementHost
}

func (c issueRunSessionCanceller) CancelAutomationTurn(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
	turnID string,
) error {
	if c.Sessions == nil {
		return errors.New("automation Turn canceller is unavailable")
	}
	_, err := c.Sessions.CancelTurn(ctx, workspaceID, agentSessionID, turnID)
	return err
}

func (r issueRunSettlementReader) ReadRunSettlement(ctx context.Context, workspaceID string, agentSessionID string, clientSubmitID string) (workspaceservice.IssueRunSettlement, bool, error) {
	if r.Host == nil {
		return workspaceservice.IssueRunSettlement{}, false, nil
	}
	ref := agenthost.SessionRef{WorkspaceID: workspaceID, AgentSessionID: agentSessionID}
	turnID, found, err := r.Host.FindTurnByClientSubmitID(ctx, ref, clientSubmitID)
	if err != nil || !found {
		return workspaceservice.IssueRunSettlement{}, false, err
	}
	turn, found, err := r.Host.GetTurn(ctx, ref, turnID)
	if err != nil || !found || strings.TrimSpace(turn.Phase) != "settled" {
		return workspaceservice.IssueRunSettlement{}, false, err
	}
	status := workspaceissues.StatusFailed
	switch strings.TrimSpace(turn.Outcome) {
	case "completed":
		status = workspaceissues.StatusCompleted
	case "canceled":
		status = workspaceissues.StatusCanceled
	case "":
		return workspaceservice.IssueRunSettlement{}, false, nil
	}
	return workspaceservice.IssueRunSettlement{
		WorkspaceID:    workspaceID,
		AgentSessionID: agentSessionID,
		TurnID:         turnID,
		Status:         status,
		ErrorMessage:   strings.TrimSpace(turn.ErrorMessage),
	}, true, nil
}

func (c issueRunSessionCanceller) RequestRunCancellation(ctx context.Context, request workspaceservice.IssueRunCancellationRequest) (workspaceservice.IssueRunCancelResult, error) {
	if c.Host == nil || c.Sessions == nil {
		return workspaceservice.IssueRunCancelResult{}, errors.New("issue run session canceller is unavailable")
	}
	clientSubmitID := strings.TrimSpace(request.ClientSubmitID)
	if clientSubmitID == "" {
		return workspaceservice.IssueRunCancelResult{}, errors.New("issue run client submit identity is required")
	}
	ref := agenthost.SessionRef{WorkspaceID: request.WorkspaceID, AgentSessionID: request.AgentSessionID}
	turnID, found, err := c.Host.FindTurnByClientSubmitID(ctx, ref, clientSubmitID)
	if err != nil {
		return workspaceservice.IssueRunCancelResult{}, err
	}
	if !found {
		return workspaceservice.IssueRunCancelResult{State: workspaceservice.IssueRunCancelNotFound}, nil
	}
	result, err := c.Sessions.CancelTurn(ctx, request.WorkspaceID, request.AgentSessionID, turnID)
	if err != nil {
		return workspaceservice.IssueRunCancelResult{}, err
	}
	reader := issueRunSettlementReader{Host: c.Host}
	settlement, settled, readErr := reader.ReadRunSettlement(
		ctx, request.WorkspaceID, request.AgentSessionID, clientSubmitID,
	)
	if readErr != nil {
		return workspaceservice.IssueRunCancelResult{}, readErr
	}
	switch result.Reason {
	case agentservice.CancelTurnReasonTurnCanceled:
		if !settled {
			settlement = workspaceservice.IssueRunSettlement{
				WorkspaceID:    request.WorkspaceID,
				AgentSessionID: request.AgentSessionID,
				TurnID:         turnID,
				Status:         workspaceissues.StatusCanceled,
			}
		}
		return workspaceservice.IssueRunCancelResult{
			State:      workspaceservice.IssueRunCancelCanceled,
			Settlement: &settlement,
		}, nil
	case agentservice.CancelTurnReasonAlreadySettled:
		if !settled {
			return workspaceservice.IssueRunCancelResult{}, errors.New("settled Agent turn is unavailable")
		}
		return workspaceservice.IssueRunCancelResult{
			State:      workspaceservice.IssueRunCancelSettled,
			Settlement: &settlement,
		}, nil
	case agentservice.CancelTurnReasonNotFound:
		return workspaceservice.IssueRunCancelResult{State: workspaceservice.IssueRunCancelNotFound}, nil
	default:
		return workspaceservice.IssueRunCancelResult{State: workspaceservice.IssueRunCancelAccepted}, nil
	}
}

type issueRunAgentLauncher struct {
	Sessions issueRunAgentSessionCreator
	Host     issueRunCanonicalTurnFinder
}

func (l issueRunAgentLauncher) Launch(ctx context.Context, launch workspaceservice.IssueRunLaunch) error {
	if l.Sessions == nil {
		return errors.New("issue run agent launcher is unavailable")
	}
	clientSubmitID := strings.TrimSpace(launch.ClientSubmitID)
	if clientSubmitID == "" {
		return errors.New("issue run client submit id is required")
	}
	title := launch.Title
	reasoningIntensity := launch.ReasoningIntensity
	permissionModeID := optionalString(launch.PermissionModeID)
	initialContent := []agentservice.PromptContentBlock{{Type: "text", Text: launch.Prompt}}
	for _, attachment := range launch.Attachments {
		initialContent = append(initialContent, agentservice.PromptContentBlock{
			Type:     "image",
			MimeType: attachment.MimeType,
			Name:     attachment.Name,
			Path:     attachment.Path,
		})
	}
	result, err := l.Sessions.CreateWithResult(ctx, launch.WorkspaceID, agentservice.CreateSessionInput{
		AgentSessionID:       launch.AgentSessionID,
		AgentTargetID:        launch.AgentTargetID,
		ReasoningIntensity:   &reasoningIntensity,
		ReasoningEffort:      optionalString(launch.ReasoningEffort),
		PermissionModeID:     permissionModeID,
		StrictPermissionMode: permissionModeID != nil,
		InitialContent:       initialContent,
		ClientSubmitID:       clientSubmitID,
		Title:                &title,
		Cwd:                  optionalString(launch.ExecutionDirectory),
		Model:                optionalString(launch.Model),
		ModelPlanID:          optionalString(launch.ModelPlanID),
		Visible:              boolPointer(!launch.HideSession),
		RailPlacement:        agentRailPlacementFromIssueRun(launch.RailPlacement),
	})
	if err == nil ||
		strings.TrimSpace(result.TurnID) != "" ||
		errors.Is(err, agentservice.ErrSubmitDeliveryUnknown) {
		return err
	}
	if l.Host == nil {
		return err
	}
	_, found, lookupErr := l.Host.FindTurnByClientSubmitID(
		ctx,
		agenthost.SessionRef{
			WorkspaceID:    launch.WorkspaceID,
			AgentSessionID: launch.AgentSessionID,
		},
		clientSubmitID,
	)
	if lookupErr != nil || found {
		return err
	}
	return workspaceservice.NewIssueRunLaunchNotStartedError(err)
}

func agentRailPlacementFromIssueRun(
	placement *workspaceservice.IssueRunRailPlacement,
) *agenthost.RailPlacement {
	if placement == nil {
		return nil
	}
	return &agenthost.RailPlacement{
		Version:     1,
		Kind:        agenthost.RailPlacementKind(strings.TrimSpace(placement.Kind)),
		ProjectPath: strings.TrimSpace(placement.ProjectPath),
		SectionKey:  strings.TrimSpace(placement.SectionKey),
	}
}

type issueSourceSessionContextResolver struct {
	Sessions agentservice.SessionReader
}

func (r issueSourceSessionContextResolver) ResolveSourceSessionContext(
	workspaceID string,
	agentSessionID string,
) (workspaceservice.IssueSourceSessionContext, bool) {
	if r.Sessions == nil {
		return workspaceservice.IssueSourceSessionContext{}, false
	}
	session, ok := r.Sessions.GetSession(workspaceID, agentSessionID)
	if !ok {
		return workspaceservice.IssueSourceSessionContext{}, false
	}
	context := workspaceservice.IssueSourceSessionContext{
		WorkingDirectory: strings.TrimSpace(session.Cwd),
	}
	if strings.TrimSpace(session.RailSectionKey) != "" {
		context.RailPlacement = &workspaceservice.IssueRunRailPlacement{
			Kind:        strings.TrimSpace(session.RailSectionKind),
			ProjectPath: strings.TrimSpace(session.RailProjectPath),
			SectionKey:  strings.TrimSpace(session.RailSectionKey),
		}
		if context.WorkingDirectory == "" &&
			context.RailPlacement.Kind == "project" {
			context.WorkingDirectory = context.RailPlacement.ProjectPath
		}
	}
	return context, true
}

func optionalString(value string) *string {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return &value
}

func boolPointer(value bool) *bool {
	return &value
}
