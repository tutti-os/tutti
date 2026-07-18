package api

import (
	"context"
	"log/slog"
	"strings"
	"time"

	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	"github.com/tutti-os/tutti/services/tuttid/apierrors"
	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
)

type AgentSessionService interface {
	List(context.Context, string) ([]agentservice.Session, error)
	ListFiltered(context.Context, string, agentservice.ListSessionsInput) ([]agentservice.Session, error)
	ListPage(context.Context, string, agentservice.ListSessionsInput) (agentservice.SessionListPage, error)
	ListSessionSections(context.Context, string, agentservice.ListSessionSectionsInput) (agentservice.SessionSectionsPage, error)
	ListSessionSectionPage(context.Context, string, agentservice.ListSessionSectionPageInput) (agentservice.SessionSection, error)
	ListSessionSectionDeletionCandidates(context.Context, string, agentservice.ListSessionSectionDeletionCandidatesInput) (agentservice.SessionSectionDeletionCandidates, error)
	DeleteSessionsBatch(context.Context, string, agentservice.DeleteSessionsBatchInput) (agentservice.DeleteSessionsBatchResult, error)
	ListPinnedSessionPage(context.Context, string, agentservice.ListPinnedSessionPageInput) (agentservice.SessionPage, error)
	GetComposerOptions(context.Context, agentservice.ComposerOptionsInput) (agentservice.ComposerOptions, error)
	ListGeneratedFiles(context.Context, string, agentservice.ListGeneratedFilesInput) (agentservice.GeneratedFileList, error)
	ListMessages(context.Context, string, string, agentservice.ListMessagesInput) (agentservice.SessionMessagesPage, error)
	ScanExternalImports(context.Context, agentservice.ExternalImportScanInput) (agentservice.ExternalImportScanResult, error)
	ImportExternalSessions(context.Context, string, agentservice.ExternalImportInput) (agentservice.ExternalImportResult, error)
	ExternalImportValidProjectPaths(context.Context, agentservice.ExternalImportInput) ([]string, error)
	Create(context.Context, string, agentservice.CreateSessionInput) (agentservice.Session, error)
	Get(context.Context, string, string) (agentservice.Session, error)
	GetDetail(context.Context, string, string) (agentservice.SessionDetail, error)
	ReadAttachment(context.Context, string, string, string) (agentservice.PromptAttachment, error)
	ListGitBranches(context.Context, string, string) (agentservice.GitBranches, error)
	ListGitBranchesForPath(context.Context, string, string) (agentservice.GitBranches, error)
	ResolveGitPatchSupportForPath(context.Context, string, string) (agentservice.GitPatchSupport, error)
	ApplyGitPatchForPath(context.Context, string, agentservice.ApplyGitPatchInput) (agentservice.ApplyGitPatchResult, error)
	Clear(context.Context, string) (agentservice.ClearSessionsResult, error)
	Delete(context.Context, string, string) (bool, error)
	CancelTurn(context.Context, string, string, string) (agentservice.CancelTurnResult, error)
	GoalControl(ctx context.Context, workspaceID string, agentSessionID string, action string, objective string) (agentservice.GoalControlSessionResult, error)
	GetGoalState(context.Context, string, string) (agentservice.GoalStateSessionResult, error)
	ReconcileGoal(context.Context, string, string) (agentservice.GoalStateSessionResult, error)
	SendInput(context.Context, string, string, agentservice.SendInput) (agentservice.SendInputResult, error)
	UpdatePin(context.Context, string, string, bool) (agentservice.Session, error)
	UpdateTitle(context.Context, string, string, string) (agentservice.Session, error)
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
		input.AgentTargetID = optionalStringValue(request.Body.AgentTargetId)
		input.Cwd = optionalStringValue(request.Body.Cwd)
		input.WorkspaceID = optionalStringValue(request.Body.WorkspaceId)
	}
	if request.Body != nil && request.Body.Settings != nil {
		input.Settings = composerSettingsFromGenerated(*request.Body.Settings)
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
	detail, err := api.AgentSessionService.GetDetail(ctx, string(request.WorkspaceID), string(request.AgentSessionID))
	if err != nil {
		return writeGetWorkspaceAgentSessionError(err), nil
	}
	return tuttigenerated.GetWorkspaceAgentSession200JSONResponse{
		Session:       generatedAgentSession(detail.Session),
		ChildSessions: generatedAgentSessions(detail.ChildSessions),
		Turns:         generatedAgentTurns(detail.Turns),
	}, nil
}

func generatedAgentTurns(turns []agentactivitybiz.Turn) []tuttigenerated.WorkspaceAgentTurn {
	result := make([]tuttigenerated.WorkspaceAgentTurn, 0, len(turns))
	for _, turn := range turns {
		result = append(result, agentservice.GeneratedWorkspaceAgentTurn(turn))
	}
	return result
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
	input.SectionKey = strings.TrimSpace(request.Params.SectionKey)
	if request.Params.Query != nil {
		input.Query = strings.TrimSpace(*request.Params.Query)
	}
	if request.Params.AgentTargetIds != nil {
		if len(*request.Params.AgentTargetIds) > agentservice.MaxGeneratedFileAgentTargetFilters {
			return writeListWorkspaceAgentGeneratedFilesError(agentservice.ErrInvalidArgument), nil
		}
		input.AgentTargetIDs = append([]string(nil), (*request.Params.AgentTargetIds)...)
	}
	if request.Params.Cursor != nil {
		input.Cursor = strings.TrimSpace(*request.Params.Cursor)
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
	response := tuttigenerated.ListWorkspaceAgentGeneratedFiles200JSONResponse{
		Entries:     generatedAgentGeneratedFiles(result.Files),
		HasMore:     result.HasMore,
		WorkspaceId: result.WorkspaceID,
	}
	if result.NextCursor != "" {
		response.NextCursor = &result.NextCursor
	}
	return response, nil
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
		TurnID:   request.Body.TurnId,
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

func generatedAgentSessionPage(page agentservice.SessionPage) tuttigenerated.WorkspaceAgentSessionPage {
	response := tuttigenerated.WorkspaceAgentSessionPage{
		HasMore:    page.HasMore,
		Sessions:   generatedAgentSessions(page.Sessions),
		TotalCount: page.TotalCount,
	}
	if strings.TrimSpace(page.NextCursor) != "" {
		response.NextCursor = &page.NextCursor
	}
	return response
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
		TotalCount:  section.TotalCount,
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
		Behavior: tuttigenerated.AgentProviderComposerBehavior{
			CollapseModelOptionsToLatest:        options.Behavior.CollapseModelOptionsToLatest,
			ModelOptionsAuthoritative:           options.Behavior.ModelOptionsAuthoritative,
			RefreshModelOptionsAfterSettings:    options.Behavior.RefreshModelOptionsAfterSettings,
			PrewarmDraftSession:                 options.Behavior.PrewarmDraftSession,
			PlanModeExclusiveWithPermissionMode: options.Behavior.PlanModeExclusiveWithPermissionMode,
		},
		Capabilities:      generatedAgentSessionCapabilities(options.Capabilities),
		CapabilityCatalog: generatedAgentProviderCapabilityOptions(options.CapabilityCatalog),
		Commands:          generatedAgentProviderComposerCommands(options.Commands),
		EffectiveSettings: effectiveSettings,
		ModelConfig:       generatedComposerConfigOption(options.ModelConfig),
		PermissionConfig:  generatedPermissionConfig(options.PermissionConfig),
		Provider:          tuttigenerated.WorkspaceAgentProvider(options.Provider),
		ReasoningConfig:   generatedComposerConfigOption(options.ReasoningConfig),
		ReasoningOptionsByModel: generatedAgentProviderComposerReasoningOptionsByModel(
			options.ReasoningOptionsByModel,
		),
		SpeedConfig:        generatedComposerConfigOptionPointer(options.SpeedConfig),
		RuntimeContext:     options.RuntimeContext,
		Skills:             generatedAgentProviderSkillOptions(options.Skills),
		SlashCommandPolicy: generatedAgentSlashCommandPolicy(options.SlashCommandPolicy),
	}
}

func generatedAgentSlashCommandPolicy(
	policy *providerregistry.SlashCommandPolicyDescriptor,
) *tuttigenerated.AgentSlashCommandPolicy {
	if policy == nil {
		return nil
	}
	effects := make([]tuttigenerated.AgentSlashCommandEffectDescriptor, 0, len(policy.CommandEffects))
	for _, effect := range policy.CommandEffects {
		effects = append(effects, tuttigenerated.AgentSlashCommandEffectDescriptor{
			Command: strings.TrimSpace(effect.Command),
			Effect:  tuttigenerated.AgentSlashCommandEffect(effect.Effect),
		})
	}
	return &tuttigenerated.AgentSlashCommandPolicy{
		FallbackCommands:            append(make([]string, 0, len(policy.FallbackCommands)), policy.FallbackCommands...),
		CommandEffects:              effects,
		CommandCatalogAuthoritative: boolPointer(policy.CommandCatalogAuthoritative),
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
		if block.Url != nil {
			item.URL = *block.Url
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

func generatedAgentSession(session agentservice.Session) tuttigenerated.WorkspaceAgentSession {
	var settings *tuttigenerated.AgentSessionComposerSettings
	if session.Settings != nil {
		value := generatedAgentSessionComposerSettings(*session.Settings)
		settings = &value
	}
	// Protocol v2 turn state: the session carries an activeTurnId reference
	// plus the embedded active turn and pending interactions.
	var activeTurn *tuttigenerated.WorkspaceAgentTurn
	if session.ActiveTurn != nil {
		turn := agentservice.GeneratedWorkspaceAgentTurn(*session.ActiveTurn)
		activeTurn = &turn
	}
	var latestTurn *tuttigenerated.WorkspaceAgentTurn
	if session.LatestTurn != nil {
		turn := agentservice.GeneratedWorkspaceAgentTurn(*session.LatestTurn)
		latestTurn = &turn
	}
	pendingInteractions := make([]tuttigenerated.WorkspaceAgentInteraction, 0, len(session.PendingInteractions))
	for _, interaction := range session.PendingInteractions {
		pendingInteractions = append(pendingInteractions, agentservice.GeneratedWorkspaceAgentInteraction(interaction))
	}
	latestTurnInteractions := make([]tuttigenerated.WorkspaceAgentInteraction, 0, len(session.LatestTurnInteractions))
	for _, interaction := range session.LatestTurnInteractions {
		latestTurnInteractions = append(latestTurnInteractions, agentservice.GeneratedWorkspaceAgentInteraction(interaction))
	}
	updatedAtUnixMS := session.CreatedAt.UnixMilli()
	if session.UpdatedAt != nil {
		updatedAtUnixMS = session.UpdatedAt.UnixMilli()
	}
	var endedAtUnixMS *int64
	if session.EndedAt != nil {
		value := session.EndedAt.UnixMilli()
		endedAtUnixMS = &value
	}
	generatedSettings := tuttigenerated.AgentSessionComposerSettings{}
	if settings != nil {
		generatedSettings = *settings
	}
	return tuttigenerated.WorkspaceAgentSession{
		ActiveTurn:             activeTurn,
		ActiveTurnId:           optionalStringPointer(strings.TrimSpace(session.ActiveTurnID)),
		AgentTargetId:          optionalStringPointer(strings.TrimSpace(session.AgentTargetID)),
		Capabilities:           generatedAgentSessionCapabilities(session.Metadata.Capabilities),
		CreatedAtUnixMs:        session.CreatedAt.UnixMilli(),
		Cwd:                    stringPointer(strings.TrimSpace(session.Cwd)),
		EndedAtUnixMs:          endedAtUnixMS,
		Goal:                   generatedAgentSessionGoal(session.Metadata.Goal),
		Id:                     session.ID,
		Imported:               session.Metadata.Imported,
		Kind:                   tuttigenerated.WorkspaceAgentSessionKind(session.Kind),
		LatestTurn:             latestTurn,
		LatestTurnInteractions: latestTurnInteractions,
		ParentAgentSessionId:   optionalStringPointer(strings.TrimSpace(session.ParentAgentSessionID)),
		ParentToolCallId:       optionalStringPointer(strings.TrimSpace(session.ParentToolCallID)),
		ParentTurnId:           optionalStringPointer(strings.TrimSpace(session.ParentTurnID)),
		PendingInteractions:    pendingInteractions,
		PermissionConfig:       generatedPermissionConfig(session.PermissionConfig),
		Provider:               tuttigenerated.WorkspaceAgentProvider(session.Provider),
		ProviderSessionId:      stringPointer(strings.TrimSpace(session.ProviderSessionID)),
		PinnedAtUnixMs:         int64Pointer(session.PinnedAtUnixMS),
		RailSectionKey:         strings.TrimSpace(session.RailSectionKey),
		Resumable:              session.Resumable,
		RootAgentSessionId:     optionalStringPointer(strings.TrimSpace(session.RootAgentSessionID)),
		RootTurnId:             optionalStringPointer(strings.TrimSpace(session.RootTurnID)),
		Settings:               generatedSettings,
		Title:                  session.Title,
		UpdatedAtUnixMs:        updatedAtUnixMS,
		Usage:                  generatedAgentSessionUsage(session.Metadata.Usage),
		Visible:                session.Visible,
	}
}

func int64Pointer(value int64) *int64 {
	if value == 0 {
		return nil
	}
	return &value
}
