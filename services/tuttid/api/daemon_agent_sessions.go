package api

import (
	"context"
	"log/slog"
	"strings"
	"time"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	"github.com/tutti-os/tutti/services/tuttid/apierrors"
	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
)

type AgentSessionService interface {
	List(context.Context, string) ([]agentservice.Session, error)
	ListFiltered(context.Context, string, agentservice.ListSessionsInput) ([]agentservice.Session, error)
	ListSessionSections(context.Context, string, agentservice.ListSessionSectionsInput) (agentservice.SessionSectionsPage, error)
	ListSessionSectionPage(context.Context, string, agentservice.ListSessionSectionPageInput) (agentservice.SessionSection, error)
	GetComposerOptions(context.Context, agentservice.ComposerOptionsInput) (agentservice.ComposerOptions, error)
	ListGeneratedFiles(context.Context, string, agentservice.ListGeneratedFilesInput) (agentservice.GeneratedFileList, error)
	ListMessages(context.Context, string, string, agentservice.ListMessagesInput) (agentservice.SessionMessagesPage, error)
	ScanExternalImports(context.Context, agentservice.ExternalImportScanInput) (agentservice.ExternalImportScanResult, error)
	ImportExternalSessions(context.Context, string, agentservice.ExternalImportInput) (agentservice.ExternalImportResult, error)
	ExternalImportValidProjectPaths(context.Context, agentservice.ExternalImportInput) ([]string, error)
	Create(context.Context, string, agentservice.CreateSessionInput) (agentservice.Session, error)
	Get(context.Context, string, string) (agentservice.Session, error)
	ReadAttachment(context.Context, string, string, string) (agentservice.PromptAttachment, error)
	ListGitBranches(context.Context, string, string) (agentservice.GitBranches, error)
	ListGitBranchesForPath(context.Context, string, string) (agentservice.GitBranches, error)
	ResolveGitPatchSupportForPath(context.Context, string, string) (agentservice.GitPatchSupport, error)
	ApplyGitPatchForPath(context.Context, string, agentservice.ApplyGitPatchInput) (agentservice.ApplyGitPatchResult, error)
	Clear(context.Context, string) (agentservice.ClearSessionsResult, error)
	Delete(context.Context, string, string) (bool, error)
	Cancel(context.Context, string, string) (agentservice.CancelSessionResult, error)
	SendInput(context.Context, string, string, agentservice.SendInput) (agentservice.SendInputResult, error)
	UpdatePin(context.Context, string, string, bool) (agentservice.Session, error)
	UpdateVisible(context.Context, string, string, bool) (agentservice.Session, error)
	UpdateSettings(context.Context, string, string, agentservice.ComposerSettingsPatch) (agentservice.Session, error)
	SubmitInteractive(context.Context, string, string, string, agentservice.SubmitInteractiveInput) (agentservice.Session, error)
}

func (api DaemonAPI) ClearWorkspaceAgentSessions(ctx context.Context, request tuttigenerated.ClearWorkspaceAgentSessionsRequestObject) (tuttigenerated.ClearWorkspaceAgentSessionsResponseObject, error) {
	if api.AgentSessionService == nil {
		return tuttigenerated.ClearWorkspaceAgentSessions503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentSessionServiceUnavailableError(),
		}, nil
	}
	result, err := api.AgentSessionService.Clear(ctx, string(request.WorkspaceID))
	if err != nil {
		return writeClearWorkspaceAgentSessionsError(err), nil
	}
	return tuttigenerated.ClearWorkspaceAgentSessions200JSONResponse{
		RemovedMessages: result.RemovedMessages,
		RemovedSessions: result.RemovedSessions,
	}, nil
}

func (api DaemonAPI) GetAgentProviderComposerOptions(ctx context.Context, request tuttigenerated.GetAgentProviderComposerOptionsRequestObject) (tuttigenerated.GetAgentProviderComposerOptionsResponseObject, error) {
	if api.AgentSessionService == nil {
		return tuttigenerated.GetAgentProviderComposerOptions503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentSessionServiceUnavailableError(),
		}, nil
	}
	input := agentservice.ComposerOptionsInput{
		Provider: string(request.Provider),
	}
	if request.Body != nil {
		input.Cwd = optionalStringValue(request.Body.Cwd)
		input.WorkspaceID = optionalStringValue(request.Body.WorkspaceId)
	}
	input.Settings = api.composerDefaultsForProvider(ctx, input.Provider)
	if request.Body != nil && request.Body.Settings != nil {
		input.Settings = mergeComposerSettings(input.Settings, composerSettingsFromGenerated(*request.Body.Settings))
	}
	if request.Body != nil && request.Body.Locale != nil {
		input.Locale = string(*request.Body.Locale)
	} else {
		input.Locale = api.composerDefaultLocale(ctx)
	}
	options, err := api.AgentSessionService.GetComposerOptions(ctx, input)
	if err != nil {
		return writeGetAgentProviderComposerOptionsError(err), nil
	}
	return tuttigenerated.GetAgentProviderComposerOptions200JSONResponse(
		generatedAgentProviderComposerOptions(options),
	), nil
}

func (api DaemonAPI) GetWorkspaceAgentSession(ctx context.Context, request tuttigenerated.GetWorkspaceAgentSessionRequestObject) (tuttigenerated.GetWorkspaceAgentSessionResponseObject, error) {
	if api.AgentSessionService == nil {
		return tuttigenerated.GetWorkspaceAgentSession503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentSessionServiceUnavailableError(),
		}, nil
	}
	session, err := api.AgentSessionService.Get(ctx, string(request.WorkspaceID), string(request.AgentSessionID))
	if err != nil {
		return writeGetWorkspaceAgentSessionError(err), nil
	}
	return tuttigenerated.GetWorkspaceAgentSession200JSONResponse{
		Session: generatedAgentSession(session),
	}, nil
}

func (api DaemonAPI) DeleteWorkspaceAgentSession(ctx context.Context, request tuttigenerated.DeleteWorkspaceAgentSessionRequestObject) (tuttigenerated.DeleteWorkspaceAgentSessionResponseObject, error) {
	if api.AgentSessionService == nil {
		return tuttigenerated.DeleteWorkspaceAgentSession503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentSessionServiceUnavailableError(),
		}, nil
	}
	removed, err := api.AgentSessionService.Delete(ctx, string(request.WorkspaceID), string(request.AgentSessionID))
	if err != nil {
		return writeDeleteWorkspaceAgentSessionError(err), nil
	}
	return tuttigenerated.DeleteWorkspaceAgentSession200JSONResponse{
		Removed: removed,
	}, nil
}

func (api DaemonAPI) ListWorkspaceAgentSessionMessages(ctx context.Context, request tuttigenerated.ListWorkspaceAgentSessionMessagesRequestObject) (tuttigenerated.ListWorkspaceAgentSessionMessagesResponseObject, error) {
	if api.AgentSessionService == nil {
		return tuttigenerated.ListWorkspaceAgentSessionMessages503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentSessionServiceUnavailableError(),
		}, nil
	}
	startedAt := time.Now()
	workspaceID := string(request.WorkspaceID)
	agentSessionID := string(request.AgentSessionID)
	input := agentservice.ListMessagesInput{}
	if request.Params.AfterVersion != nil {
		if *request.Params.AfterVersion < 0 {
			return writeListWorkspaceAgentSessionMessagesError(agentservice.ErrInvalidArgument), nil
		}
		input.AfterVersion = uint64(*request.Params.AfterVersion)
	}
	if request.Params.BeforeVersion != nil {
		if *request.Params.BeforeVersion < 0 {
			return writeListWorkspaceAgentSessionMessagesError(agentservice.ErrInvalidArgument), nil
		}
		input.BeforeVersion = uint64(*request.Params.BeforeVersion)
	}
	if request.Params.Order != nil {
		switch *request.Params.Order {
		case tuttigenerated.Asc:
			input.Order = agentactivitybiz.MessageOrderAsc
		case tuttigenerated.Desc:
			input.Order = agentactivitybiz.MessageOrderDesc
		default:
			return writeListWorkspaceAgentSessionMessagesError(agentservice.ErrInvalidArgument), nil
		}
	}
	if request.Params.Limit != nil {
		if *request.Params.Limit <= 0 {
			return writeListWorkspaceAgentSessionMessagesError(agentservice.ErrInvalidArgument), nil
		}
		input.Limit = *request.Params.Limit
	}
	slog.Info("workspace agent session messages list requested",
		"event", "workspace.agent_session.messages.api.list_requested",
		"workspace_id", workspaceID,
		"agent_session_id", agentSessionID,
		"after_version", input.AfterVersion,
		"before_version", input.BeforeVersion,
		"order", input.Order,
		"limit", input.Limit,
	)
	page, err := api.AgentSessionService.ListMessages(
		ctx,
		workspaceID,
		agentSessionID,
		input,
	)
	if err != nil {
		slog.Warn("workspace agent session messages list failed",
			"event", "workspace.agent_session.messages.api.list_failed",
			"workspace_id", workspaceID,
			"agent_session_id", agentSessionID,
			"after_version", input.AfterVersion,
			"before_version", input.BeforeVersion,
			"order", input.Order,
			"limit", input.Limit,
			"duration_ms", time.Since(startedAt).Milliseconds(),
			"error", err,
		)
		return writeListWorkspaceAgentSessionMessagesError(err), nil
	}
	messages, err := generatedAgentSessionMessages(page.Messages)
	if err != nil {
		firstVersion, lastVersion := agentSessionMessageVersionRange(page.Messages)
		slog.Warn("workspace agent session messages response transform failed",
			"event", "workspace.agent_session.messages.api.transform_failed",
			"workspace_id", workspaceID,
			"agent_session_id", agentSessionID,
			"after_version", input.AfterVersion,
			"before_version", input.BeforeVersion,
			"order", input.Order,
			"limit", input.Limit,
			"message_count", len(page.Messages),
			"first_version", firstVersion,
			"last_version", lastVersion,
			"latest_version", page.LatestVersion,
			"has_more", page.HasMore,
			"duration_ms", time.Since(startedAt).Milliseconds(),
			"error", err,
		)
		return writeListWorkspaceAgentSessionMessagesError(err), nil
	}
	firstVersion, lastVersion := generatedAgentSessionMessageVersionRange(messages)
	slog.Info("workspace agent session messages list completed",
		"event", "workspace.agent_session.messages.api.list_completed",
		"workspace_id", workspaceID,
		"agent_session_id", agentSessionID,
		"after_version", input.AfterVersion,
		"before_version", input.BeforeVersion,
		"order", input.Order,
		"limit", input.Limit,
		"message_count", len(messages),
		"first_version", firstVersion,
		"last_version", lastVersion,
		"latest_version", page.LatestVersion,
		"has_more", page.HasMore,
		"duration_ms", time.Since(startedAt).Milliseconds(),
	)
	return tuttigenerated.ListWorkspaceAgentSessionMessages200JSONResponse{
		AgentSessionId: page.AgentSessionID,
		HasMore:        page.HasMore,
		LatestVersion:  int64(page.LatestVersion),
		Messages:       messages,
	}, nil
}

func (api DaemonAPI) ListWorkspaceAgentGeneratedFiles(ctx context.Context, request tuttigenerated.ListWorkspaceAgentGeneratedFilesRequestObject) (tuttigenerated.ListWorkspaceAgentGeneratedFilesResponseObject, error) {
	if api.AgentSessionService == nil {
		return tuttigenerated.ListWorkspaceAgentGeneratedFiles503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentSessionServiceUnavailableError(),
		}, nil
	}
	input := agentservice.ListGeneratedFilesInput{}
	if request.Params.Query != nil {
		input.Query = strings.TrimSpace(*request.Params.Query)
	}
	if request.Params.SessionCwd != nil {
		input.SessionCwd = strings.TrimSpace(*request.Params.SessionCwd)
	}
	if request.Params.Limit != nil {
		if *request.Params.Limit <= 0 || *request.Params.Limit > 100 {
			return writeListWorkspaceAgentGeneratedFilesError(agentservice.ErrInvalidArgument), nil
		}
		input.Limit = *request.Params.Limit
	}
	result, err := api.AgentSessionService.ListGeneratedFiles(
		ctx,
		string(request.WorkspaceID),
		input,
	)
	if err != nil {
		return writeListWorkspaceAgentGeneratedFilesError(err), nil
	}
	return tuttigenerated.ListWorkspaceAgentGeneratedFiles200JSONResponse{
		Entries:     generatedAgentGeneratedFiles(result.Files),
		WorkspaceId: result.WorkspaceID,
	}, nil
}

func (api DaemonAPI) CancelWorkspaceAgentSession(ctx context.Context, request tuttigenerated.CancelWorkspaceAgentSessionRequestObject) (tuttigenerated.CancelWorkspaceAgentSessionResponseObject, error) {
	if api.AgentSessionService == nil {
		return tuttigenerated.CancelWorkspaceAgentSession503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentSessionServiceUnavailableError(),
		}, nil
	}
	result, err := api.AgentSessionService.Cancel(ctx, string(request.WorkspaceID), string(request.AgentSessionID))
	if err != nil {
		return writeCancelWorkspaceAgentSessionError(err), nil
	}
	return tuttigenerated.CancelWorkspaceAgentSession200JSONResponse{
		Cancel:  generatedAgentSessionCancelResult(result),
		Session: generatedAgentSession(result.Session),
	}, nil
}

func (api DaemonAPI) ReadWorkspaceAgentSessionAttachment(ctx context.Context, request tuttigenerated.ReadWorkspaceAgentSessionAttachmentRequestObject) (tuttigenerated.ReadWorkspaceAgentSessionAttachmentResponseObject, error) {
	if api.AgentSessionService == nil {
		return tuttigenerated.ReadWorkspaceAgentSessionAttachment503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentSessionServiceUnavailableError(),
		}, nil
	}
	attachment, err := api.AgentSessionService.ReadAttachment(
		ctx,
		string(request.WorkspaceID),
		string(request.AgentSessionID),
		string(request.AttachmentID),
	)
	if err != nil {
		return writeReadWorkspaceAgentSessionAttachmentError(err), nil
	}
	return tuttigenerated.ReadWorkspaceAgentSessionAttachment200JSONResponse{
		AttachmentId: attachment.AttachmentID,
		MimeType:     tuttigenerated.WorkspaceAgentSessionAttachmentResponseMimeType(attachment.MimeType),
		Data:         attachment.Data,
	}, nil
}

func (api DaemonAPI) ListWorkspaceAgentSessionGitBranches(ctx context.Context, request tuttigenerated.ListWorkspaceAgentSessionGitBranchesRequestObject) (tuttigenerated.ListWorkspaceAgentSessionGitBranchesResponseObject, error) {
	if api.AgentSessionService == nil {
		return tuttigenerated.ListWorkspaceAgentSessionGitBranches503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentSessionServiceUnavailableError(),
		}, nil
	}
	branches, err := api.AgentSessionService.ListGitBranches(ctx, string(request.WorkspaceID), string(request.AgentSessionID))
	if err != nil {
		return writeListWorkspaceAgentSessionGitBranchesError(err), nil
	}
	response := tuttigenerated.ListWorkspaceAgentSessionGitBranches200JSONResponse{Branches: branches.Branches}
	if response.Branches == nil {
		response.Branches = []string{}
	}
	if branches.CurrentBranch != "" {
		current := branches.CurrentBranch
		response.CurrentBranch = &current
	}
	return response, nil
}

func (api DaemonAPI) ListWorkspaceGitBranches(ctx context.Context, request tuttigenerated.ListWorkspaceGitBranchesRequestObject) (tuttigenerated.ListWorkspaceGitBranchesResponseObject, error) {
	if api.AgentSessionService == nil {
		return tuttigenerated.ListWorkspaceGitBranches503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentSessionServiceUnavailableError(),
		}, nil
	}
	branches, err := api.AgentSessionService.ListGitBranchesForPath(ctx, string(request.WorkspaceID), request.Params.WorkingDirectory)
	if err != nil {
		return writeListWorkspaceGitBranchesError(err), nil
	}
	response := tuttigenerated.ListWorkspaceGitBranches200JSONResponse{Branches: branches.Branches}
	if response.Branches == nil {
		response.Branches = []string{}
	}
	if branches.CurrentBranch != "" {
		current := branches.CurrentBranch
		response.CurrentBranch = &current
	}
	return response, nil
}

func (api DaemonAPI) UpdateWorkspaceAgentSessionSettings(ctx context.Context, request tuttigenerated.UpdateWorkspaceAgentSessionSettingsRequestObject) (tuttigenerated.UpdateWorkspaceAgentSessionSettingsResponseObject, error) {
	if api.AgentSessionService == nil {
		return tuttigenerated.UpdateWorkspaceAgentSessionSettings503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentSessionServiceUnavailableError(),
		}, nil
	}
	if request.Body == nil {
		return tuttigenerated.UpdateWorkspaceAgentSessionSettings400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(apierrors.EmptyBody(apierrors.WithDeveloperMessage("empty body"))),
		}, nil
	}
	session, err := api.AgentSessionService.UpdateSettings(
		ctx,
		string(request.WorkspaceID),
		string(request.AgentSessionID),
		composerSettingsPatchFromGenerated(*request.Body),
	)
	if err != nil {
		return writeUpdateWorkspaceAgentSessionSettingsError(err), nil
	}
	return tuttigenerated.UpdateWorkspaceAgentSessionSettings200JSONResponse{
		Session: generatedAgentSession(session),
	}, nil
}

func (api DaemonAPI) UpdateWorkspaceAgentSessionPin(ctx context.Context, request tuttigenerated.UpdateWorkspaceAgentSessionPinRequestObject) (tuttigenerated.UpdateWorkspaceAgentSessionPinResponseObject, error) {
	if api.AgentSessionService == nil {
		return tuttigenerated.UpdateWorkspaceAgentSessionPin503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentSessionServiceUnavailableError(),
		}, nil
	}
	if request.Body == nil {
		return tuttigenerated.UpdateWorkspaceAgentSessionPin400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(apierrors.EmptyBody(apierrors.WithDeveloperMessage("empty body"))),
		}, nil
	}
	session, err := api.AgentSessionService.UpdatePin(
		ctx,
		string(request.WorkspaceID),
		string(request.AgentSessionID),
		request.Body.Pinned,
	)
	if err != nil {
		return writeUpdateWorkspaceAgentSessionPinError(err), nil
	}
	return tuttigenerated.UpdateWorkspaceAgentSessionPin200JSONResponse{
		Session: generatedAgentSession(session),
	}, nil
}

func (api DaemonAPI) UpdateWorkspaceAgentSessionVisibility(ctx context.Context, request tuttigenerated.UpdateWorkspaceAgentSessionVisibilityRequestObject) (tuttigenerated.UpdateWorkspaceAgentSessionVisibilityResponseObject, error) {
	if api.AgentSessionService == nil {
		return tuttigenerated.UpdateWorkspaceAgentSessionVisibility503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentSessionServiceUnavailableError(),
		}, nil
	}
	if request.Body == nil {
		return tuttigenerated.UpdateWorkspaceAgentSessionVisibility400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(apierrors.EmptyBody(apierrors.WithDeveloperMessage("empty body"))),
		}, nil
	}
	session, err := api.AgentSessionService.UpdateVisible(
		ctx,
		string(request.WorkspaceID),
		string(request.AgentSessionID),
		request.Body.Visible,
	)
	if err != nil {
		return writeUpdateWorkspaceAgentSessionVisibilityError(err), nil
	}
	return tuttigenerated.UpdateWorkspaceAgentSessionVisibility200JSONResponse{
		Session: generatedAgentSession(session),
	}, nil
}

func (api DaemonAPI) SubmitWorkspaceAgentInteractive(ctx context.Context, request tuttigenerated.SubmitWorkspaceAgentInteractiveRequestObject) (tuttigenerated.SubmitWorkspaceAgentInteractiveResponseObject, error) {
	if api.AgentSessionService == nil {
		return tuttigenerated.SubmitWorkspaceAgentInteractive503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentSessionServiceUnavailableError(),
		}, nil
	}
	if request.Body == nil {
		return tuttigenerated.SubmitWorkspaceAgentInteractive400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(apierrors.EmptyBody(apierrors.WithDeveloperMessage("empty body"))),
		}, nil
	}
	session, err := api.AgentSessionService.SubmitInteractive(ctx, string(request.WorkspaceID), string(request.AgentSessionID), string(request.RequestID), agentservice.SubmitInteractiveInput{
		Action:   request.Body.Action,
		OptionID: request.Body.OptionId,
		Payload:  optionalPayloadMap(request.Body.Payload),
	})
	if err != nil {
		return writeSubmitWorkspaceAgentInteractiveError(err), nil
	}
	return tuttigenerated.SubmitWorkspaceAgentInteractive200JSONResponse{
		Session: generatedAgentSession(session),
	}, nil
}

func generatedAgentSessions(sessions []agentservice.Session) []tuttigenerated.WorkspaceAgentSession {
	result := make([]tuttigenerated.WorkspaceAgentSession, 0, len(sessions))
	for _, session := range sessions {
		result = append(result, generatedAgentSession(session))
	}
	return result
}

func generatedAgentSessionSections(sections []agentservice.SessionSection) []tuttigenerated.WorkspaceAgentSessionSection {
	result := make([]tuttigenerated.WorkspaceAgentSessionSection, 0, len(sections))
	for _, section := range sections {
		result = append(result, generatedAgentSessionSection(section))
	}
	return result
}

func generatedAgentSessionSection(section agentservice.SessionSection) tuttigenerated.WorkspaceAgentSessionSection {
	var userProject *tuttigenerated.UserProject
	if section.UserProject != nil {
		value := generatedUserProject(*section.UserProject)
		userProject = &value
	}
	response := tuttigenerated.WorkspaceAgentSessionSection{
		HasMore:     section.HasMore,
		Kind:        tuttigenerated.WorkspaceAgentSessionSectionKind(section.Kind),
		SectionKey:  section.SectionKey,
		Sessions:    generatedAgentSessions(section.Sessions),
		UserProject: userProject,
	}
	if strings.TrimSpace(section.NextCursor) != "" {
		response.NextCursor = &section.NextCursor
	}
	return response
}

func composerSettingsFromGenerated(settings tuttigenerated.AgentSessionComposerSettings) agentservice.ComposerSettings {
	return agentservice.ComposerSettings{
		Model:            optionalStringValue(settings.Model),
		PermissionModeID: optionalStringValue(settings.PermissionModeId),
		PlanMode:         settings.PlanMode != nil && *settings.PlanMode,
		BrowserUse:       settings.BrowserUse,
		ReasoningEffort:  optionalStringValue(settings.ReasoningEffort),
		Speed:            optionalStringValue(settings.Speed),
	}
}

func (api DaemonAPI) composerDefaultsForProvider(ctx context.Context, provider string) agentservice.ComposerSettings {
	if api.PreferencesService == nil {
		return agentservice.ComposerSettings{}
	}
	preferences, err := api.PreferencesService.Get(ctx)
	if err != nil {
		return agentservice.ComposerSettings{}
	}
	// Legacy provider-keyed defaults were copied onto local agent target ids
	// by a one-time sqlite data migration, so this lookup covers old data too.
	defaults := preferences.AgentComposerDefaultsByAgentTarget[preferencesbiz.LocalAgentTargetIDForProvider(provider)]
	return agentservice.ComposerSettings{
		Model:            defaults.Model,
		PermissionModeID: defaults.PermissionModeID,
		ReasoningEffort:  defaults.ReasoningEffort,
		Speed:            defaults.Speed,
	}
}

func (api DaemonAPI) composerDefaultsForAgentTarget(ctx context.Context, agentTargetID string) agentservice.ComposerSettings {
	if api.PreferencesService == nil {
		return agentservice.ComposerSettings{}
	}
	preferences, err := api.PreferencesService.Get(ctx)
	if err != nil {
		return agentservice.ComposerSettings{}
	}
	defaults := preferences.AgentComposerDefaultsByAgentTarget[strings.TrimSpace(agentTargetID)]
	return agentservice.ComposerSettings{
		Model:            defaults.Model,
		PermissionModeID: defaults.PermissionModeID,
		ReasoningEffort:  defaults.ReasoningEffort,
		Speed:            defaults.Speed,
	}
}

func (api DaemonAPI) composerDefaultLocale(ctx context.Context) string {
	if api.PreferencesService == nil {
		return ""
	}
	preferences, err := api.PreferencesService.Get(ctx)
	if err != nil {
		return ""
	}
	return preferences.Locale
}

func (api DaemonAPI) agentConversationDetailMode(ctx context.Context) string {
	if api.PreferencesService == nil {
		return preferencesbiz.DefaultDesktopAgentConversationDetailMode
	}
	preferences, err := api.PreferencesService.Get(ctx)
	if err != nil {
		return preferencesbiz.DefaultDesktopAgentConversationDetailMode
	}
	return preferencesbiz.NormalizeDesktopAgentConversationDetailMode(preferences.AgentConversationDetailMode)
}

func mergeComposerSettings(base agentservice.ComposerSettings, override agentservice.ComposerSettings) agentservice.ComposerSettings {
	if strings.TrimSpace(override.Model) != "" {
		base.Model = override.Model
	}
	if strings.TrimSpace(override.PermissionModeID) != "" {
		base.PermissionModeID = override.PermissionModeID
	}
	if override.PlanMode {
		base.PlanMode = override.PlanMode
	}
	if strings.TrimSpace(override.ReasoningEffort) != "" {
		base.ReasoningEffort = override.ReasoningEffort
	}
	if strings.TrimSpace(override.Speed) != "" {
		base.Speed = override.Speed
	}
	return base
}

func composerSettingsPatchFromGenerated(settings tuttigenerated.AgentSessionComposerSettings) agentservice.ComposerSettingsPatch {
	return agentservice.ComposerSettingsPatch{
		Model:            settings.Model,
		PermissionModeID: settings.PermissionModeId,
		PlanMode:         settings.PlanMode,
		BrowserUse:       settings.BrowserUse,
		ReasoningEffort:  settings.ReasoningEffort,
		Speed:            settings.Speed,
	}
}

func generatedAgentProviderComposerOptions(options agentservice.ComposerOptions) tuttigenerated.AgentProviderComposerOptionsResponse {
	effectiveSettings := generatedAgentSessionComposerSettings(options.EffectiveSettings)
	return tuttigenerated.AgentProviderComposerOptionsResponse{
		CapabilityCatalog: generatedAgentProviderCapabilityOptions(options.CapabilityCatalog),
		EffectiveSettings: effectiveSettings,
		ModelConfig:       generatedComposerConfigOption(options.ModelConfig),
		PermissionConfig:  generatedPermissionConfig(options.PermissionConfig),
		Provider:          tuttigenerated.WorkspaceAgentProvider(options.Provider),
		ReasoningConfig:   generatedComposerConfigOption(options.ReasoningConfig),
		SpeedConfig:       generatedComposerConfigOptionPointer(options.SpeedConfig),
		RuntimeContext:    options.RuntimeContext,
		Skills:            generatedAgentProviderSkillOptions(options.Skills),
	}
}

func generatedAgentSessionComposerSettings(settings agentservice.ComposerSettings) tuttigenerated.AgentSessionComposerSettings {
	result := tuttigenerated.AgentSessionComposerSettings{
		Model:            optionalStringPointer(strings.TrimSpace(settings.Model)),
		PermissionModeId: optionalStringPointer(strings.TrimSpace(settings.PermissionModeID)),
		PlanMode:         boolPointer(settings.PlanMode),
		ReasoningEffort:  optionalStringPointer(strings.TrimSpace(settings.ReasoningEffort)),
		Speed:            optionalStringPointer(strings.TrimSpace(settings.Speed)),
	}
	if settings.BrowserUse != nil {
		result.BrowserUse = settings.BrowserUse
	}
	return result
}

func generatedPermissionConfig(config agentservice.PermissionConfig) tuttigenerated.PermissionConfig {
	result := tuttigenerated.PermissionConfig{
		Configurable: config.Configurable,
		Modes:        make([]tuttigenerated.PermissionModeOption, 0, len(config.Modes)),
	}
	if strings.TrimSpace(config.DefaultValue) != "" {
		result.DefaultValue = optionalStringPointer(config.DefaultValue)
	}
	for _, mode := range config.Modes {
		option := tuttigenerated.PermissionModeOption{
			Id:       strings.TrimSpace(mode.ID),
			Label:    strings.TrimSpace(mode.Label),
			Semantic: tuttigenerated.PermissionModeSemantic(mode.Semantic),
		}
		if strings.TrimSpace(mode.Description) != "" {
			option.Description = optionalStringPointer(mode.Description)
		}
		if option.Id != "" && option.Label != "" {
			result.Modes = append(result.Modes, option)
		}
	}
	return result
}

func optionalStringValue(input *string) string {
	if input == nil {
		return ""
	}
	return strings.TrimSpace(*input)
}

func optionalPayloadMap(input *map[string]interface{}) map[string]any {
	if input == nil {
		return nil
	}
	return map[string]any(*input)
}

func optionalStringPointer(value string) *string {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return &value
}

func generatedAgentGeneratedFiles(files []agentservice.GeneratedFile) []tuttigenerated.WorkspaceAgentGeneratedFileEntry {
	result := make([]tuttigenerated.WorkspaceAgentGeneratedFileEntry, 0, len(files))
	for _, file := range files {
		path := strings.TrimSpace(file.Path)
		if path == "" {
			continue
		}
		label := strings.TrimSpace(file.Label)
		if label == "" {
			label = path
		}
		result = append(result, tuttigenerated.WorkspaceAgentGeneratedFileEntry{
			Label: label,
			Path:  path,
		})
	}
	return result
}

func stringPtrValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func agentPromptContentFromGenerated(content []tuttigenerated.AgentPromptContentBlock) []agentservice.PromptContentBlock {
	result := make([]agentservice.PromptContentBlock, 0, len(content))
	for _, block := range content {
		item := agentservice.PromptContentBlock{
			Type: string(block.Type),
		}
		if block.Text != nil {
			item.Text = *block.Text
		}
		if block.MimeType != nil {
			item.MimeType = string(*block.MimeType)
		}
		if block.Data != nil {
			item.Data = *block.Data
		}
		if block.AttachmentId != nil {
			item.AttachmentID = *block.AttachmentId
		}
		if block.Name != nil {
			item.Name = *block.Name
		}
		if block.Path != nil {
			item.Path = *block.Path
		}
		result = append(result, item)
	}
	return result
}

func generatedAgentSessionCancelResult(result agentservice.CancelSessionResult) tuttigenerated.WorkspaceAgentSessionCancelResult {
	return tuttigenerated.WorkspaceAgentSessionCancelResult{
		Canceled: result.Canceled,
		Reason:   tuttigenerated.WorkspaceAgentSessionCancelResultReason(result.Reason),
	}
}

func generatedAgentSession(session agentservice.Session) tuttigenerated.WorkspaceAgentSession {
	var settings *tuttigenerated.AgentSessionComposerSettings
	if session.Settings != nil {
		value := generatedAgentSessionComposerSettings(*session.Settings)
		settings = &value
	}
	runtimeContext := clonePayloadPointer(session.RuntimeContext)
	return tuttigenerated.WorkspaceAgentSession{
		AgentTargetId:      optionalStringPointer(strings.TrimSpace(session.AgentTargetID)),
		CreatedAt:          session.CreatedAt,
		Cwd:                stringPointer(strings.TrimSpace(session.Cwd)),
		EndedAt:            session.EndedAt,
		Id:                 session.ID,
		LastError:          session.LastError,
		PermissionConfig:   permissionConfigPointer(session.PermissionConfig),
		Provider:           tuttigenerated.WorkspaceAgentProvider(session.Provider),
		ProviderSessionId:  stringPointer(strings.TrimSpace(session.ProviderSessionID)),
		PinnedAtUnixMs:     int64Pointer(session.PinnedAtUnixMS),
		Resumable:          boolPointer(session.Resumable),
		RuntimeContext:     runtimeContext,
		Settings:           settings,
		Status:             tuttigenerated.WorkspaceAgentSessionStatus(session.Status),
		TurnLifecycle:      generatedAgentTurnLifecyclePointer(session.TurnLifecycle),
		SubmitAvailability: generatedAgentSubmitAvailabilityPointer(session.SubmitAvailability),
		Title:              session.Title,
		UpdatedAt:          session.UpdatedAt,
		Visible:            session.Visible,
	}
}

func generatedAgentSubmitAvailability(value agentservice.SubmitAvailability) tuttigenerated.AgentActivitySubmitAvailability {
	return tuttigenerated.AgentActivitySubmitAvailability{
		State:  value.State,
		Reason: stringPointer(strings.TrimSpace(value.Reason)),
	}
}

func generatedAgentSubmitAvailabilityPointer(value *agentservice.SubmitAvailability) *tuttigenerated.AgentActivitySubmitAvailability {
	if value == nil {
		return nil
	}
	converted := generatedAgentSubmitAvailability(*value)
	return &converted
}

func generatedAgentCompletedCommand(value *agentservice.CompletedCommand) *tuttigenerated.AgentActivityCompletedCommand {
	if value == nil {
		return nil
	}
	return &tuttigenerated.AgentActivityCompletedCommand{
		Kind:   value.Kind,
		Status: value.Status,
	}
}

func generatedAgentTurnLifecycle(value agentservice.TurnLifecycle) tuttigenerated.AgentActivityTurnLifecycle {
	return tuttigenerated.AgentActivityTurnLifecycle{
		ActiveTurnId:     value.ActiveTurnID,
		Phase:            value.Phase,
		Settling:         boolPointer(value.Settling),
		Outcome:          value.Outcome,
		CompletedCommand: generatedAgentCompletedCommand(value.CompletedCommand),
	}
}

func generatedAgentTurnLifecyclePointer(value *agentservice.TurnLifecycle) *tuttigenerated.AgentActivityTurnLifecycle {
	if value == nil {
		return nil
	}
	converted := generatedAgentTurnLifecycle(*value)
	return &converted
}

func permissionConfigPointer(config agentservice.PermissionConfig) *tuttigenerated.PermissionConfig {
	value := generatedPermissionConfig(config)
	return &value
}

func int64Pointer(value int64) *int64 {
	if value == 0 {
		return nil
	}
	return &value
}

func clonePayloadPointer(payload map[string]any) *map[string]any {
	if len(payload) == 0 {
		return nil
	}
	out := make(map[string]any, len(payload))
	for key, value := range payload {
		out[key] = clonePayloadValue(value)
	}
	return &out
}

func mapValue(payload *map[string]any) map[string]any {
	if payload == nil || len(*payload) == 0 {
		return nil
	}
	out := make(map[string]any, len(*payload))
	for key, value := range *payload {
		if trimmed := strings.TrimSpace(key); trimmed != "" {
			out[trimmed] = clonePayloadValue(value)
		}
	}
	return out
}

func clonePayloadValue(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		out := make(map[string]any, len(typed))
		for key, item := range typed {
			out[key] = clonePayloadValue(item)
		}
		return out
	case []any:
		out := make([]any, len(typed))
		for index, item := range typed {
			out[index] = clonePayloadValue(item)
		}
		return out
	default:
		return value
	}
}
