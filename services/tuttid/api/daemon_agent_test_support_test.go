package api

import (
	"context"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	agentactivitybiz "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
	agentstatusservice "github.com/tutti-os/tutti/services/tuttid/service/agentstatus"
	agenttargetservice "github.com/tutti-os/tutti/services/tuttid/service/agenttarget"
)

type stubAgentSessionService struct {
	cancelTurnFn                      func(context.Context, string, string, string) (agentservice.CancelTurnResult, error)
	clearFn                           func(context.Context, string) (agentservice.ClearSessionsResult, error)
	composerOptionsFn                 func(context.Context, agentservice.ComposerOptionsInput) (agentservice.ComposerOptions, error)
	createFn                          func(context.Context, string, agentservice.CreateSessionInput) (agentservice.Session, error)
	forkFn                            func(context.Context, string, string, agentservice.ForkSessionInput) (agentservice.SessionForkOperation, error)
	getSessionForkOperationFn         func(context.Context, string, string) (agentservice.SessionForkOperation, error)
	acknowledgeSessionForkOperationFn func(context.Context, string, string) (agentservice.SessionForkOperation, error)
	getDetailFn                       func(context.Context, string, string) (agentservice.SessionDetail, error)
	getDetailWithProjectionFn         func(context.Context, string, string, agentservice.SessionDetailProjection) (agentservice.SessionDetail, error)
	getFn                             func(context.Context, string, string) (agentservice.Session, error)
	deleteFn                          func(context.Context, string, string) (agentservice.DeleteSessionResult, error)
	listSectionDeletionCandidatesFn   func(context.Context, string, agentservice.ListSessionSectionDeletionCandidatesInput) (agentservice.SessionSectionDeletionCandidates, error)
	deleteSessionsBatchFn             func(context.Context, string, agentservice.DeleteSessionsBatchInput) (agentservice.DeleteSessionsBatchResult, error)
	importExternalFn                  func(context.Context, string, agentservice.ExternalImportInput) (agentservice.ExternalImportResult, error)
	validImportPathsFn                func(context.Context, agentservice.ExternalImportInput) ([]string, error)
	listFn                            func(context.Context, string, agentservice.ListSessionsInput) ([]agentservice.Session, error)
	listPageFn                        func(context.Context, string, agentservice.ListSessionsInput) (agentservice.SessionListPage, error)
	listSessionSectionsFn             func(context.Context, string, agentservice.ListSessionSectionsInput) (agentservice.SessionSectionsPage, error)
	listSessionSectionPageFn          func(context.Context, string, agentservice.ListSessionSectionPageInput) (agentservice.SessionSection, error)
	listPinnedSessionPageFn           func(context.Context, string, agentservice.ListPinnedSessionPageInput) (agentservice.SessionPage, error)
	listGeneratedFilesFn              func(context.Context, string, agentservice.ListGeneratedFilesInput) (agentservice.GeneratedFileList, error)
	listMessagesFn                    func(context.Context, string, string, agentservice.ListMessagesInput) (agentservice.SessionMessagesPage, error)
	readAttachmentFn                  func(context.Context, string, string, string) (agentservice.PromptAttachment, error)
	scanExternalFn                    func(context.Context, agentservice.ExternalImportScanInput) (agentservice.ExternalImportScanResult, error)
	sendInputFn                       func(context.Context, string, string, agentservice.SendInput) (agentservice.SendInputResult, error)
	listGitBranchesFn                 func(context.Context, string, string) (agentservice.GitBranches, error)
	listGitBranchesForPathFn          func(context.Context, string, string) (agentservice.GitBranches, error)
	resolveGitPatchSupportForPathFn   func(context.Context, string, string) (agentservice.GitPatchSupport, error)
	resolveWorktreeSupportFn          func(context.Context, string, string, string) (agentservice.SessionWorktreeSupport, error)
	listManagedWorktreesFn            func(context.Context, string) ([]agentservice.ManagedWorktree, error)
	deleteManagedWorktreeFn           func(context.Context, string, string) (bool, error)
	applyGitPatchForPathFn            func(context.Context, string, agentservice.ApplyGitPatchInput) (agentservice.ApplyGitPatchResult, error)
	updatePinFn                       func(context.Context, string, string, bool) (agentservice.Session, error)
	updateTitleFn                     func(context.Context, string, string, string) (agentservice.Session, error)
	updateVisibleFn                   func(context.Context, string, string, bool) (agentservice.Session, error)
	updateSettingsFn                  func(context.Context, string, string, agentservice.ComposerSettingsPatch) (agentservice.Session, error)
	submitInteractiveFn               func(context.Context, agenthost.InteractionRef, agenthost.SubmitInteractiveInput) (agentservice.Session, error)
	planDecisionFn                    func(context.Context, string, string, string, string, agentservice.SubmitPlanDecisionInput) (agentactivitybiz.RuntimeOperation, error)
}

func (s stubAgentSessionService) SubmitPlanDecision(ctx context.Context, workspaceID, agentSessionID, turnID, requestID string, input agentservice.SubmitPlanDecisionInput) (agentactivitybiz.RuntimeOperation, error) {
	if s.planDecisionFn == nil {
		return agentactivitybiz.RuntimeOperation{}, nil
	}
	return s.planDecisionFn(ctx, workspaceID, agentSessionID, turnID, requestID, input)
}

func (stubAgentSessionService) List(context.Context, string) ([]agentservice.Session, error) {
	return nil, nil
}

func (s stubAgentSessionService) ListFiltered(ctx context.Context, workspaceID string, input agentservice.ListSessionsInput) ([]agentservice.Session, error) {
	if s.listFn == nil {
		return nil, nil
	}
	return s.listFn(ctx, workspaceID, input)
}

func (s stubAgentSessionService) ListPage(ctx context.Context, workspaceID string, input agentservice.ListSessionsInput) (agentservice.SessionListPage, error) {
	if s.listPageFn == nil {
		return agentservice.SessionListPage{}, nil
	}
	return s.listPageFn(ctx, workspaceID, input)
}

func (s stubAgentSessionService) ListSessionSections(ctx context.Context, workspaceID string, input agentservice.ListSessionSectionsInput) (agentservice.SessionSectionsPage, error) {
	if s.listSessionSectionsFn == nil {
		return agentservice.SessionSectionsPage{}, nil
	}
	return s.listSessionSectionsFn(ctx, workspaceID, input)
}

func (s stubAgentSessionService) ListSessionSectionPage(ctx context.Context, workspaceID string, input agentservice.ListSessionSectionPageInput) (agentservice.SessionSection, error) {
	if s.listSessionSectionPageFn == nil {
		return agentservice.SessionSection{}, nil
	}
	return s.listSessionSectionPageFn(ctx, workspaceID, input)
}

func (s stubAgentSessionService) ListSessionSectionDeletionCandidates(ctx context.Context, workspaceID string, input agentservice.ListSessionSectionDeletionCandidatesInput) (agentservice.SessionSectionDeletionCandidates, error) {
	if s.listSectionDeletionCandidatesFn == nil {
		return agentservice.SessionSectionDeletionCandidates{}, nil
	}
	return s.listSectionDeletionCandidatesFn(ctx, workspaceID, input)
}

func (s stubAgentSessionService) DeleteSessionsBatch(ctx context.Context, workspaceID string, input agentservice.DeleteSessionsBatchInput) (agentservice.DeleteSessionsBatchResult, error) {
	if s.deleteSessionsBatchFn == nil {
		return agentservice.DeleteSessionsBatchResult{}, nil
	}
	return s.deleteSessionsBatchFn(ctx, workspaceID, input)
}

func (s stubAgentSessionService) ListPinnedSessionPage(ctx context.Context, workspaceID string, input agentservice.ListPinnedSessionPageInput) (agentservice.SessionPage, error) {
	if s.listPinnedSessionPageFn == nil {
		return agentservice.SessionPage{}, nil
	}
	return s.listPinnedSessionPageFn(ctx, workspaceID, input)
}

func (s stubAgentSessionService) Clear(ctx context.Context, workspaceID string) (agentservice.ClearSessionsResult, error) {
	if s.clearFn == nil {
		return agentservice.ClearSessionsResult{}, nil
	}
	return s.clearFn(ctx, workspaceID)
}

func (s stubAgentSessionService) GetComposerOptions(ctx context.Context, input agentservice.ComposerOptionsInput) (agentservice.ComposerOptions, error) {
	if s.composerOptionsFn == nil {
		return agentservice.ComposerOptions{
			Provider:          input.Provider,
			EffectiveSettings: input.Settings,
		}, nil
	}
	return s.composerOptionsFn(ctx, input)
}

func (s stubAgentSessionService) ListMessages(ctx context.Context, workspaceID string, agentSessionID string, input agentservice.ListMessagesInput) (agentservice.SessionMessagesPage, error) {
	if s.listMessagesFn == nil {
		return agentservice.SessionMessagesPage{}, nil
	}
	return s.listMessagesFn(ctx, workspaceID, agentSessionID, input)
}

func (s stubAgentSessionService) ListGeneratedFiles(ctx context.Context, workspaceID string, input agentservice.ListGeneratedFilesInput) (agentservice.GeneratedFileList, error) {
	if s.listGeneratedFilesFn == nil {
		return agentservice.GeneratedFileList{WorkspaceID: workspaceID, Files: []agentservice.GeneratedFile{}}, nil
	}
	return s.listGeneratedFilesFn(ctx, workspaceID, input)
}

func (s stubAgentSessionService) ScanExternalImports(ctx context.Context, input agentservice.ExternalImportScanInput) (agentservice.ExternalImportScanResult, error) {
	if s.scanExternalFn == nil {
		return agentservice.ExternalImportScanResult{}, nil
	}
	return s.scanExternalFn(ctx, input)
}

func (s stubAgentSessionService) ImportExternalSessions(ctx context.Context, workspaceID string, input agentservice.ExternalImportInput) (agentservice.ExternalImportResult, error) {
	if s.importExternalFn == nil {
		return agentservice.ExternalImportResult{}, nil
	}
	return s.importExternalFn(ctx, workspaceID, input)
}

func (s stubAgentSessionService) ExternalImportValidProjectPaths(ctx context.Context, input agentservice.ExternalImportInput) ([]string, error) {
	if s.validImportPathsFn == nil {
		return nil, nil
	}
	return s.validImportPathsFn(ctx, input)
}

func (s stubAgentSessionService) Create(ctx context.Context, workspaceID string, input agentservice.CreateSessionInput) (agentservice.Session, error) {
	if s.createFn == nil {
		return agentservice.Session{}, nil
	}
	return s.createFn(ctx, workspaceID, input)
}

func (s stubAgentSessionService) Fork(ctx context.Context, workspaceID, agentSessionID string, input agentservice.ForkSessionInput) (agentservice.SessionForkOperation, error) {
	if s.forkFn == nil {
		return agentservice.SessionForkOperation{}, nil
	}
	return s.forkFn(ctx, workspaceID, agentSessionID, input)
}

func (s stubAgentSessionService) GetSessionForkOperation(
	ctx context.Context,
	workspaceID, operationID string,
) (agentservice.SessionForkOperation, error) {
	if s.getSessionForkOperationFn == nil {
		return agentservice.SessionForkOperation{}, nil
	}
	return s.getSessionForkOperationFn(ctx, workspaceID, operationID)
}

func (s stubAgentSessionService) AcknowledgeSessionForkOperation(
	ctx context.Context,
	workspaceID, operationID string,
) (agentservice.SessionForkOperation, error) {
	if s.acknowledgeSessionForkOperationFn == nil {
		return agentservice.SessionForkOperation{}, nil
	}
	return s.acknowledgeSessionForkOperationFn(ctx, workspaceID, operationID)
}

func (s stubAgentSessionService) Get(ctx context.Context, workspaceID, agentSessionID string) (agentservice.Session, error) {
	if s.getFn == nil {
		return agentservice.Session{}, nil
	}
	return s.getFn(ctx, workspaceID, agentSessionID)
}

func (s stubAgentSessionService) GetDetail(ctx context.Context, workspaceID, agentSessionID string) (agentservice.SessionDetail, error) {
	if s.getDetailFn != nil {
		return s.getDetailFn(ctx, workspaceID, agentSessionID)
	}
	return agentservice.SessionDetail{ChildSessions: []agentservice.Session{}}, nil
}

func (s stubAgentSessionService) GetDetailWithProjection(
	ctx context.Context,
	workspaceID, agentSessionID string,
	projection agentservice.SessionDetailProjection,
) (agentservice.SessionDetail, error) {
	if s.getDetailWithProjectionFn != nil {
		return s.getDetailWithProjectionFn(
			ctx,
			workspaceID,
			agentSessionID,
			projection,
		)
	}
	return s.GetDetail(ctx, workspaceID, agentSessionID)
}

func (s stubAgentSessionService) ReadAttachment(ctx context.Context, workspaceID string, agentSessionID string, attachmentID string) (agentservice.PromptAttachment, error) {
	if s.readAttachmentFn != nil {
		return s.readAttachmentFn(ctx, workspaceID, agentSessionID, attachmentID)
	}
	return agentservice.PromptAttachment{}, nil
}

func (s stubAgentSessionService) ListGitBranches(ctx context.Context, workspaceID string, agentSessionID string) (agentservice.GitBranches, error) {
	if s.listGitBranchesFn != nil {
		return s.listGitBranchesFn(ctx, workspaceID, agentSessionID)
	}
	return agentservice.GitBranches{}, nil
}

func (s stubAgentSessionService) ListGitBranchesForPath(ctx context.Context, workspaceID string, workingDirectory string) (agentservice.GitBranches, error) {
	if s.listGitBranchesForPathFn != nil {
		return s.listGitBranchesForPathFn(ctx, workspaceID, workingDirectory)
	}
	return agentservice.GitBranches{}, nil
}

func (s stubAgentSessionService) ResolveGitPatchSupportForPath(ctx context.Context, workspaceID string, cwd string) (agentservice.GitPatchSupport, error) {
	if s.resolveGitPatchSupportForPathFn != nil {
		return s.resolveGitPatchSupportForPathFn(ctx, workspaceID, cwd)
	}
	return agentservice.GitPatchSupport{}, nil
}

func (s stubAgentSessionService) ResolveSessionWorktreeSupport(ctx context.Context, workspaceID string, agentTargetID string, cwd string) (agentservice.SessionWorktreeSupport, error) {
	if s.resolveWorktreeSupportFn != nil {
		return s.resolveWorktreeSupportFn(ctx, workspaceID, agentTargetID, cwd)
	}
	return agentservice.SessionWorktreeSupport{}, nil
}

func (s stubAgentSessionService) ListManagedWorktrees(ctx context.Context, workspaceID string) ([]agentservice.ManagedWorktree, error) {
	if s.listManagedWorktreesFn == nil {
		return []agentservice.ManagedWorktree{}, nil
	}
	return s.listManagedWorktreesFn(ctx, workspaceID)
}

func (s stubAgentSessionService) DeleteManagedWorktree(ctx context.Context, workspaceID string, worktreeID string) (bool, error) {
	if s.deleteManagedWorktreeFn == nil {
		return false, agentservice.ErrManagedWorktreeNotFound
	}
	return s.deleteManagedWorktreeFn(ctx, workspaceID, worktreeID)
}

func (s stubAgentSessionService) ApplyGitPatchForPath(ctx context.Context, workspaceID string, input agentservice.ApplyGitPatchInput) (agentservice.ApplyGitPatchResult, error) {
	if s.applyGitPatchForPathFn != nil {
		return s.applyGitPatchForPathFn(ctx, workspaceID, input)
	}
	return agentservice.ApplyGitPatchResult{}, nil
}

func (s stubAgentSessionService) Delete(ctx context.Context, workspaceID string, agentSessionID string) (agentservice.DeleteSessionResult, error) {
	if s.deleteFn == nil {
		return agentservice.DeleteSessionResult{Removed: true}, nil
	}
	return s.deleteFn(ctx, workspaceID, agentSessionID)
}

func (s stubAgentSessionService) CancelTurn(ctx context.Context, workspaceID string, agentSessionID string, turnID string) (agentservice.CancelTurnResult, error) {
	if s.cancelTurnFn == nil {
		return agentservice.CancelTurnResult{}, nil
	}
	return s.cancelTurnFn(ctx, workspaceID, agentSessionID, turnID)
}

func (stubAgentSessionService) GoalControl(
	context.Context,
	agentservice.GoalControlInput,
) (agentservice.GoalControlSessionResult, error) {
	return agentservice.GoalControlSessionResult{}, nil
}

func (stubAgentSessionService) GetGoalState(context.Context, string, string) (agentservice.GoalStateSessionResult, error) {
	return agentservice.GoalStateSessionResult{}, nil
}

func (stubAgentSessionService) ReconcileGoal(context.Context, string, string) (agentservice.GoalStateSessionResult, error) {
	return agentservice.GoalStateSessionResult{}, nil
}

func (s stubAgentSessionService) SendInput(ctx context.Context, workspaceID string, agentSessionID string, input agentservice.SendInput) (agentservice.SendInputResult, error) {
	if s.sendInputFn != nil {
		return s.sendInputFn(ctx, workspaceID, agentSessionID, input)
	}
	return agentservice.SendInputResult{}, nil
}

func (s stubAgentSessionService) UpdatePin(ctx context.Context, workspaceID string, agentSessionID string, pinned bool) (agentservice.Session, error) {
	if s.updatePinFn == nil {
		return agentservice.Session{}, nil
	}
	return s.updatePinFn(ctx, workspaceID, agentSessionID, pinned)
}

func (s stubAgentSessionService) UpdateTitle(ctx context.Context, workspaceID string, agentSessionID string, title string) (agentservice.Session, error) {
	if s.updateTitleFn == nil {
		return agentservice.Session{}, nil
	}
	return s.updateTitleFn(ctx, workspaceID, agentSessionID, title)
}

func (s stubAgentSessionService) UpdateVisible(ctx context.Context, workspaceID string, agentSessionID string, visible bool) (agentservice.Session, error) {
	if s.updateVisibleFn == nil {
		return agentservice.Session{}, nil
	}
	return s.updateVisibleFn(ctx, workspaceID, agentSessionID, visible)
}

func (s stubAgentSessionService) UpdateSettings(ctx context.Context, workspaceID string, agentSessionID string, settings agentservice.ComposerSettingsPatch) (agentservice.Session, error) {
	if s.updateSettingsFn == nil {
		return agentservice.Session{}, nil
	}
	return s.updateSettingsFn(ctx, workspaceID, agentSessionID, settings)
}

func (s stubAgentSessionService) SubmitInteractive(ctx context.Context, ref agenthost.InteractionRef, input agenthost.SubmitInteractiveInput) (agentservice.Session, error) {
	if s.submitInteractiveFn == nil {
		return agentservice.Session{}, nil
	}
	return s.submitInteractiveFn(ctx, ref, input)
}

type stubAgentTargetService struct {
	listFn       func(context.Context) ([]agenttargetbiz.Target, error)
	setEnabledFn func(context.Context, agenttargetservice.SetEnabledInput) (agenttargetbiz.Target, error)
}

type stubTuttiAgentReadiness struct {
	triggerFn                 func(string)
	providerActionCompletedFn func(agentstatusservice.RunActionResult)
}

func (s stubTuttiAgentReadiness) Trigger(reason string) {
	if s.triggerFn != nil {
		s.triggerFn(reason)
	}
}

func (s stubTuttiAgentReadiness) ProviderActionCompleted(result agentstatusservice.RunActionResult) {
	if s.providerActionCompletedFn != nil {
		s.providerActionCompletedFn(result)
	}
}

func (s stubAgentTargetService) List(ctx context.Context) ([]agenttargetbiz.Target, error) {
	if s.listFn == nil {
		return agenttargetbiz.DefaultSystemTargets(1), nil
	}
	return s.listFn(ctx)
}

func (s stubAgentTargetService) SetEnabled(ctx context.Context, input agenttargetservice.SetEnabledInput) (agenttargetbiz.Target, error) {
	if s.setEnabledFn != nil {
		return s.setEnabledFn(ctx, input)
	}
	for _, target := range agenttargetbiz.DefaultSystemTargets(1) {
		if target.ID == input.ID {
			target.Enabled = input.Enabled
			return target, nil
		}
	}
	return agenttargetbiz.Target{}, workspacedata.ErrAgentTargetNotFound
}
