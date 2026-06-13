package api

import (
	"context"
	"strings"

	"github.com/google/uuid"
	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	"github.com/tutti-os/tutti/services/tuttid/apierrors"
	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
	agentproviderbiz "github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
)

type AgentSessionService interface {
	List(context.Context, string) ([]agentservice.Session, error)
	ListFiltered(context.Context, string, agentservice.ListSessionsInput) ([]agentservice.Session, error)
	GetComposerOptions(context.Context, agentservice.ComposerOptionsInput) (agentservice.ComposerOptions, error)
	ListMessages(context.Context, string, string, agentservice.ListMessagesInput) (agentservice.SessionMessagesPage, error)
	Create(context.Context, string, agentservice.CreateSessionInput) (agentservice.Session, error)
	Get(context.Context, string, string) (agentservice.Session, error)
	ReadAttachment(context.Context, string, string, string) (agentservice.PromptAttachment, error)
	Delete(context.Context, string, string) (bool, error)
	Cancel(context.Context, string, string) (agentservice.CancelSessionResult, error)
	SendInput(context.Context, string, string, agentservice.SendInput) (agentservice.Session, error)
	UpdatePin(context.Context, string, string, bool) (agentservice.Session, error)
	UpdateSettings(context.Context, string, string, agentservice.ComposerSettingsPatch) (agentservice.Session, error)
	SubmitInteractive(context.Context, string, string, string, agentservice.SubmitInteractiveInput) (agentservice.Session, error)
}

const listWorkspaceAgentSessionsLimitMax = 100

func agentSessionServiceUnavailableError() tuttigenerated.ServiceUnavailableErrorJSONResponse {
	return serviceUnavailableError(
		apierrors.WorkspaceAgentSessionServiceUnavailable(
			apierrors.WithDeveloperMessage("workspace agent session service is unavailable"),
		),
	)
}

func (api DaemonAPI) ListWorkspaceAgentSessions(ctx context.Context, request tuttigenerated.ListWorkspaceAgentSessionsRequestObject) (tuttigenerated.ListWorkspaceAgentSessionsResponseObject, error) {
	if api.AgentSessionService == nil {
		return tuttigenerated.ListWorkspaceAgentSessions503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentSessionServiceUnavailableError(),
		}, nil
	}
	input := agentservice.ListSessionsInput{}
	if request.Params.SearchQuery != nil {
		input.SearchQuery = strings.TrimSpace(*request.Params.SearchQuery)
	}
	if request.Params.Limit != nil {
		if *request.Params.Limit <= 0 || *request.Params.Limit > listWorkspaceAgentSessionsLimitMax {
			return writeListWorkspaceAgentSessionsError(agentservice.ErrInvalidArgument), nil
		}
		input.Limit = int(*request.Params.Limit)
	}
	if request.Params.VisibleOnly != nil {
		input.VisibleOnly = *request.Params.VisibleOnly
	}
	sessions, err := api.AgentSessionService.ListFiltered(ctx, string(request.WorkspaceID), input)
	if err != nil {
		return writeListWorkspaceAgentSessionsError(err), nil
	}
	return tuttigenerated.ListWorkspaceAgentSessions200JSONResponse{
		Sessions:    generatedAgentSessions(sessions),
		WorkspaceId: string(request.WorkspaceID),
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

func (api DaemonAPI) CreateWorkspaceAgentSession(ctx context.Context, request tuttigenerated.CreateWorkspaceAgentSessionRequestObject) (tuttigenerated.CreateWorkspaceAgentSessionResponseObject, error) {
	if api.AgentSessionService == nil {
		return tuttigenerated.CreateWorkspaceAgentSession503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentSessionServiceUnavailableError(),
		}, nil
	}
	if request.Body == nil {
		return tuttigenerated.CreateWorkspaceAgentSession400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(apierrors.EmptyBody(apierrors.WithDeveloperMessage("empty body"))),
		}, nil
	}
	if request.Body.AgentSessionId == uuid.Nil {
		return tuttigenerated.CreateWorkspaceAgentSession400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(
				apierrors.MalformedRequest(apierrors.WithDeveloperMessage("agentSessionId must be a UUID")),
			),
		}, nil
	}
	agentSessionID := request.Body.AgentSessionId.String()
	session, err := api.AgentSessionService.Create(ctx, string(request.WorkspaceID), agentservice.CreateSessionInput{
		AgentSessionID:   agentSessionID,
		Cwd:              request.Body.Cwd,
		InitialContent:   agentPromptContentFromGenerated(request.Body.InitialContent),
		Model:            request.Body.Model,
		PermissionModeID: request.Body.PermissionModeId,
		PlanMode:         request.Body.PlanMode,
		Provider:         string(request.Body.Provider),
		ReasoningEffort:  request.Body.ReasoningEffort,
		Title:            request.Body.Title,
		Visible:          request.Body.Visible,
	})
	if err != nil {
		return writeCreateWorkspaceAgentSessionError(err), nil
	}
	return tuttigenerated.CreateWorkspaceAgentSession201JSONResponse{
		Session: generatedAgentSession(session),
	}, nil
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
	page, err := api.AgentSessionService.ListMessages(
		ctx,
		string(request.WorkspaceID),
		string(request.AgentSessionID),
		input,
	)
	if err != nil {
		return writeListWorkspaceAgentSessionMessagesError(err), nil
	}
	return tuttigenerated.ListWorkspaceAgentSessionMessages200JSONResponse{
		AgentSessionId: page.AgentSessionID,
		HasMore:        page.HasMore,
		LatestVersion:  int64(page.LatestVersion),
		Messages:       generatedAgentSessionMessages(page.Messages),
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

func (api DaemonAPI) SendWorkspaceAgentSessionInput(ctx context.Context, request tuttigenerated.SendWorkspaceAgentSessionInputRequestObject) (tuttigenerated.SendWorkspaceAgentSessionInputResponseObject, error) {
	if api.AgentSessionService == nil {
		return tuttigenerated.SendWorkspaceAgentSessionInput503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentSessionServiceUnavailableError(),
		}, nil
	}
	if request.Body == nil {
		return tuttigenerated.SendWorkspaceAgentSessionInput400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(apierrors.EmptyBody(apierrors.WithDeveloperMessage("empty body"))),
		}, nil
	}
	session, err := api.AgentSessionService.SendInput(ctx, string(request.WorkspaceID), string(request.AgentSessionID), agentservice.SendInput{
		Content: agentPromptContentFromGenerated(request.Body.Content),
	})
	if err != nil {
		return writeSendWorkspaceAgentSessionInputError(err), nil
	}
	return tuttigenerated.SendWorkspaceAgentSessionInput200JSONResponse{
		Session: generatedAgentSession(session),
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

func composerSettingsFromGenerated(settings tuttigenerated.AgentSessionComposerSettings) agentservice.ComposerSettings {
	return agentservice.ComposerSettings{
		Model:            optionalStringValue(settings.Model),
		PermissionModeID: optionalStringValue(settings.PermissionModeId),
		PlanMode:         settings.PlanMode != nil && *settings.PlanMode,
		ReasoningEffort:  optionalStringValue(settings.ReasoningEffort),
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
	defaults := preferences.AgentComposerDefaultsByProvider[agentproviderbiz.Normalize(provider)]
	return agentservice.ComposerSettings{
		Model:            defaults.Model,
		PermissionModeID: defaults.PermissionModeID,
		ReasoningEffort:  defaults.ReasoningEffort,
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
	return base
}

func composerSettingsPatchFromGenerated(settings tuttigenerated.AgentSessionComposerSettings) agentservice.ComposerSettingsPatch {
	return agentservice.ComposerSettingsPatch{
		Model:            settings.Model,
		PermissionModeID: settings.PermissionModeId,
		PlanMode:         settings.PlanMode,
		ReasoningEffort:  settings.ReasoningEffort,
	}
}

func generatedAgentProviderComposerOptions(options agentservice.ComposerOptions) tuttigenerated.AgentProviderComposerOptionsResponse {
	effectiveSettings := generatedAgentSessionComposerSettings(options.EffectiveSettings)
	return tuttigenerated.AgentProviderComposerOptionsResponse{
		EffectiveSettings: effectiveSettings,
		ModelConfig:       generatedComposerConfigOption(options.ModelConfig),
		PermissionConfig:  generatedPermissionConfig(options.PermissionConfig),
		Provider:          tuttigenerated.WorkspaceAgentProvider(options.Provider),
		ReasoningConfig:   generatedComposerConfigOption(options.ReasoningConfig),
		RuntimeContext:    options.RuntimeContext,
		Skills:            generatedAgentProviderSkillOptions(options.Skills),
	}
}

func generatedAgentProviderSkillOptions(options []agentservice.ComposerSkillOption) []tuttigenerated.AgentProviderSkillOption {
	if len(options) == 0 {
		return []tuttigenerated.AgentProviderSkillOption{}
	}
	result := make([]tuttigenerated.AgentProviderSkillOption, 0, len(options))
	for _, option := range options {
		name := strings.TrimSpace(option.Name)
		trigger := strings.TrimSpace(option.Trigger)
		sourceKind := strings.TrimSpace(option.SourceKind)
		if name == "" || trigger == "" || sourceKind == "" {
			continue
		}
		generated := tuttigenerated.AgentProviderSkillOption{
			Name:       name,
			Trigger:    trigger,
			SourceKind: tuttigenerated.AgentProviderSkillOptionSourceKind(sourceKind),
		}
		if description := strings.TrimSpace(option.Description); description != "" {
			generated.Description = optionalStringPointer(description)
		}
		if pluginName := strings.TrimSpace(option.PluginName); pluginName != "" {
			generated.PluginName = optionalStringPointer(pluginName)
		}
		result = append(result, generated)
	}
	return result
}

func generatedComposerConfigOption(config agentservice.ComposerConfigOption) tuttigenerated.AgentProviderComposerConfig {
	result := tuttigenerated.AgentProviderComposerConfig{
		Configurable: config.Configurable,
		Options:      make([]tuttigenerated.AgentProviderComposerConfigOptionValue, 0, len(config.Options)),
	}
	if strings.TrimSpace(config.CurrentValue) != "" {
		result.CurrentValue = optionalStringPointer(config.CurrentValue)
	}
	if strings.TrimSpace(config.DefaultValue) != "" {
		result.DefaultValue = optionalStringPointer(config.DefaultValue)
	}
	for _, option := range config.Options {
		value := strings.TrimSpace(option.Value)
		id := strings.TrimSpace(option.ID)
		label := strings.TrimSpace(option.Label)
		if value == "" || id == "" || label == "" {
			continue
		}
		resultOption := tuttigenerated.AgentProviderComposerConfigOptionValue{
			Id:    id,
			Label: label,
			Value: value,
		}
		if strings.TrimSpace(option.Description) != "" {
			resultOption.Description = optionalStringPointer(option.Description)
		}
		result.Options = append(result.Options, resultOption)
	}
	return result
}

func generatedAgentSessionComposerSettings(settings agentservice.ComposerSettings) tuttigenerated.AgentSessionComposerSettings {
	return tuttigenerated.AgentSessionComposerSettings{
		Model:            optionalStringPointer(strings.TrimSpace(settings.Model)),
		PermissionModeId: optionalStringPointer(strings.TrimSpace(settings.PermissionModeID)),
		PlanMode:         boolPointer(settings.PlanMode),
		ReasoningEffort:  optionalStringPointer(strings.TrimSpace(settings.ReasoningEffort)),
	}
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

func generatedAgentSessionMessages(messages []agentservice.SessionMessage) []tuttigenerated.WorkspaceAgentSessionMessage {
	result := make([]tuttigenerated.WorkspaceAgentSessionMessage, 0, len(messages))
	for _, message := range messages {
		result = append(result, tuttigenerated.WorkspaceAgentSessionMessage{
			AgentSessionId:    strings.TrimSpace(message.AgentSessionID),
			CompletedAtUnixMs: int64Pointer(message.CompletedAtUnixMS),
			CreatedAtUnixMs:   int64Pointer(message.CreatedAtUnixMS),
			Id:                int64(message.ID),
			Kind:              strings.TrimSpace(message.Kind),
			MessageId:         strings.TrimSpace(message.MessageID),
			OccurredAtUnixMs:  int64Pointer(message.OccurredAtUnixMS),
			Payload:           clonePayloadPointer(message.Payload),
			Role:              strings.TrimSpace(message.Role),
			StartedAtUnixMs:   int64Pointer(message.StartedAtUnixMS),
			Status:            stringPointer(strings.TrimSpace(message.Status)),
			TurnId:            stringPointer(strings.TrimSpace(message.TurnID)),
			UpdatedAtUnixMs:   int64Pointer(message.UpdatedAtUnixMS),
			Version:           int64(message.Version),
		})
	}
	return result
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
		CreatedAt:         session.CreatedAt,
		Cwd:               stringPointer(strings.TrimSpace(session.Cwd)),
		EndedAt:           session.EndedAt,
		Id:                session.ID,
		LastError:         session.LastError,
		PermissionConfig:  permissionConfigPointer(session.PermissionConfig),
		Provider:          tuttigenerated.WorkspaceAgentProvider(session.Provider),
		ProviderSessionId: stringPointer(strings.TrimSpace(session.ProviderSessionID)),
		PinnedAtUnixMs:    int64Pointer(session.PinnedAtUnixMS),
		Resumable:         boolPointer(session.Resumable),
		RuntimeContext:    runtimeContext,
		Settings:          settings,
		Status:            tuttigenerated.WorkspaceAgentSessionStatus(session.Status),
		Title:             session.Title,
		UpdatedAt:         session.UpdatedAt,
		Visible:           session.Visible,
	}
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
		out[key] = value
	}
	return &out
}
