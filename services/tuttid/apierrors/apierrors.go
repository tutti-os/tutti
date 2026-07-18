package apierrors

import (
	"errors"
	"strings"

	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
	runtimeprep "github.com/tutti-os/tutti/packages/agent/runtimeprep"
	workspacefiles "github.com/tutti-os/tutti/packages/workspace/files"
	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
	workspaceservice "github.com/tutti-os/tutti/services/tuttid/service/workspace"
)

const (
	StatusInvalidRequest             = 400
	StatusMethodNotAllowed           = 405
	StatusWorkspaceIssueExists       = 409
	StatusWorkspaceNotFound          = 404
	StatusWorkspaceFileNotFound      = 404
	StatusWorkspaceIssueNotFound     = 404
	StatusWorkspaceOperationFailed   = 502
	StatusPreferencesOperationFailed = 502
	StatusServiceUnavailable         = 503
)

const (
	ReasonEmptyBody                                      = "empty_body"
	ReasonEntryAlreadyExists                             = "entry_already_exists"
	ReasonAgentSubmitDeliveryUnknown                     = "agent_submit_delivery_unknown"
	ReasonEventStreamServiceUnavailable                  = "event_stream_service_unavailable"
	ReasonInvalidEntryKind                               = "invalid_entry_kind"
	ReasonInvalidPath                                    = "invalid_path"
	ReasonNotAGitRepo                                    = "not_a_git_repo"
	ReasonGitUnavailable                                 = "git_unavailable"
	ReasonUnsupportedRepoLayout                          = "unsupported_repo_layout"
	ReasonWorktreeCreateFailed                           = "worktree_create_failed"
	ReasonInvalidUploadSource                            = "invalid_upload_source"
	ReasonInvalidWorkbenchSnapshot                       = "invalid_workbench_snapshot"
	ReasonMalformedRequest                               = "malformed_request"
	ReasonMethodNotAllowed                               = "method_not_allowed"
	ReasonMissingDesktopAgentConversationDetailMode      = "missing_desktop_agent_conversation_detail_mode"
	ReasonMissingDesktopAgentDockLayout                  = "missing_desktop_agent_dock_layout"
	ReasonMissingDesktopDockIconStyle                    = "missing_desktop_dock_icon_style"
	ReasonMissingDesktopDockPlacement                    = "missing_desktop_dock_placement"
	ReasonMissingDesktopAppCatalogChannel                = "missing_desktop_app_catalog_channel"
	ReasonMissingDesktopBrowserUseConnectionMode         = "missing_desktop_browser_use_connection_mode"
	ReasonMissingDesktopLocale                           = "missing_desktop_locale"
	ReasonMissingDesktopMinimizeAnimation                = "missing_desktop_minimize_animation"
	ReasonMissingDesktopSleepPreventionMode              = "missing_desktop_sleep_prevention_mode"
	ReasonMissingDesktopThemeSource                      = "missing_desktop_theme_source"
	ReasonMissingDesktopUpdateChannel                    = "missing_desktop_update_channel"
	ReasonMissingDesktopUpdatePolicy                     = "missing_desktop_update_policy"
	ReasonMissingDesktopWindowSnappingShortcutPreset     = "missing_desktop_window_snapping_shortcut_preset"
	ReasonPreferencesOperationFailed                     = "preferences_operation_failed"
	ReasonPreferencesServiceUnavailable                  = "preferences_service_unavailable"
	ReasonMissingWorkspaceID                             = "missing_workspace_id"
	ReasonMissingWorkspaceName                           = "missing_workspace_name"
	ReasonPathEscapesRoot                                = "path_escapes_root"
	ReasonRootDeleteForbidden                            = "root_delete_forbidden"
	ReasonUnsupportedDesktopAgentConversationDetailMode  = "unsupported_desktop_agent_conversation_detail_mode"
	ReasonUnsupportedDesktopAgentDockLayout              = "unsupported_desktop_agent_dock_layout"
	ReasonUnsupportedDesktopDefaultAgentProvider         = "unsupported_desktop_default_agent_provider"
	ReasonUnsupportedDesktopDockIconStyle                = "unsupported_desktop_dock_icon_style"
	ReasonUnsupportedDesktopDockPlacement                = "unsupported_desktop_dock_placement"
	ReasonUnsupportedDeletedAgentConversationRetention   = "unsupported_deleted_agent_conversation_retention"
	ReasonUnsupportedDesktopAppCatalogChannel            = "unsupported_desktop_app_catalog_channel"
	ReasonUnsupportedDesktopBrowserUseConnectionMode     = "unsupported_desktop_browser_use_connection_mode"
	ReasonUnsupportedDesktopLocale                       = "unsupported_desktop_locale"
	ReasonUnsupportedDesktopMinimizeAnimation            = "unsupported_desktop_minimize_animation"
	ReasonUnsupportedDesktopSleepPreventionMode          = "unsupported_desktop_sleep_prevention_mode"
	ReasonUnsupportedDesktopThemeSource                  = "unsupported_desktop_theme_source"
	ReasonUnsupportedDesktopUpdateChannel                = "unsupported_desktop_update_channel"
	ReasonUnsupportedDesktopUpdatePolicy                 = "unsupported_desktop_update_policy"
	ReasonUnsupportedDesktopWindowSnappingShortcutPreset = "unsupported_desktop_window_snapping_shortcut_preset"
	ReasonWorkspaceFileNotFound                          = "workspace_file_not_found"
	ReasonWorkspaceFileServiceUnavailable                = "workspace_file_service_unavailable"
	ReasonWorkspaceAgentSessionNotFound                  = "workspace_agent_session_not_found"
	ReasonWorkspaceAgentSessionTitleTooLong              = "workspace_agent_session_title_too_long"
	ReasonWorkspaceAgentSessionUnavailable               = "workspace_agent_session_service_unavailable"
	ReasonAgentProviderUnavailable                       = "agent_provider_unavailable"
	ReasonAgentRuntimeOperationReconciling               = "agent_runtime_operation_reconciling"
	ReasonAgentRuntimeOperationFailed                    = "agent_runtime_operation_failed"
	ReasonWorkspaceAppNotFound                           = "workspace_app_not_found"
	ReasonWorkspaceAppDeleteForbidden                    = "workspace_app_delete_forbidden"
	ReasonWorkspaceAppIconInvalid                        = "workspace_app_icon_invalid"
	ReasonWorkspaceAppIconReplaceForbidden               = "workspace_app_icon_replace_forbidden"
	ReasonWorkspaceAppPackageExists                      = "workspace_app_package_exists"
	ReasonWorkspaceAppUnavailable                        = "workspace_app_service_unavailable"
	ReasonWorkspaceIssueContextRefNotFound               = "workspace_issue_context_ref_not_found"
	ReasonWorkspaceIssueContextRefExists                 = "workspace_issue_context_ref_already_exists"
	ReasonWorkspaceIssueExists                           = "workspace_issue_already_exists"
	ReasonWorkspaceIssueNotFound                         = "workspace_issue_not_found"
	ReasonWorkspaceIssueResourceExists                   = "workspace_issue_resource_exists"
	ReasonWorkspaceIssueRunNotFound                      = "workspace_issue_run_not_found"
	ReasonWorkspaceIssueRunExists                        = "workspace_issue_run_already_exists"
	ReasonWorkspaceIssueServiceUnavailable               = "workspace_issue_service_unavailable"
	ReasonWorkspaceIssueTaskExists                       = "workspace_issue_task_already_exists"
	ReasonWorkspaceIssueTaskNotFound                     = "workspace_issue_task_not_found"
	ReasonWorkspaceIssueTopicExists                      = "workspace_issue_topic_already_exists"
	ReasonWorkspaceIssueTopicNotEmpty                    = "workspace_issue_topic_not_empty"
	ReasonWorkspaceIssueTopicNotFound                    = "workspace_issue_topic_not_found"
	ReasonWorkspaceNotFound                              = "workspace_not_found"
	ReasonWorkspaceOperationFailed                       = "workspace_operation_failed"
	ReasonWorkspaceServiceUnavailable                    = "workspace_service_unavailable"
	ReasonWorkspaceTerminalNotFound                      = "workspace_terminal_not_found"
	ReasonWorkspaceTerminalNotRunning                    = "workspace_terminal_not_running"
	ReasonWorkspaceTerminalUnavailable                   = "workspace_terminal_service_unavailable"
	ReasonWorkspaceWorkbenchUnavailable                  = "workspace_workbench_service_unavailable"
)

type ProtocolError struct {
	Code             tuttigenerated.ApiErrorDetailsCode
	Reason           string
	Params           map[string]any
	Retryable        bool
	DeveloperMessage string
	CorrelationID    string
	StatusCode       int
	Cause            error
}

func (e *ProtocolError) Error() string {
	if e == nil {
		return ""
	}
	if e.DeveloperMessage != "" {
		return e.DeveloperMessage
	}
	if e.Cause != nil {
		return e.Cause.Error()
	}
	return string(e.Code)
}

func (e *ProtocolError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Cause
}

type Option func(*ProtocolError)

func WithCause(err error) Option {
	return func(target *ProtocolError) {
		target.Cause = err
		if target.DeveloperMessage == "" && err != nil {
			target.DeveloperMessage = err.Error()
		}
	}
}

func WithDeveloperMessage(message string) Option {
	return func(target *ProtocolError) {
		target.DeveloperMessage = message
	}
}

func WithParams(params map[string]any) Option {
	return func(target *ProtocolError) {
		if len(params) == 0 {
			return
		}
		target.Params = params
	}
}

func New(
	statusCode int,
	code tuttigenerated.ApiErrorDetailsCode,
	reason string,
	options ...Option,
) *ProtocolError {
	result := &ProtocolError{
		Code:       code,
		Reason:     reason,
		StatusCode: statusCode,
	}
	for _, option := range options {
		option(result)
	}
	return result
}

func InvalidRequest(reason string, options ...Option) *ProtocolError {
	return New(StatusInvalidRequest, tuttigenerated.InvalidRequest, reason, options...)
}

func EmptyBody(options ...Option) *ProtocolError {
	return InvalidRequest(ReasonEmptyBody, options...)
}

func MalformedRequest(options ...Option) *ProtocolError {
	return InvalidRequest(ReasonMalformedRequest, options...)
}

func ServiceUnavailable(reason string, options ...Option) *ProtocolError {
	return New(StatusServiceUnavailable, tuttigenerated.ServiceUnavailable, reason, options...)
}

func WorkspaceServiceUnavailable(options ...Option) *ProtocolError {
	return ServiceUnavailable(ReasonWorkspaceServiceUnavailable, options...)
}

func WorkspaceWorkbenchUnavailable(options ...Option) *ProtocolError {
	return ServiceUnavailable(ReasonWorkspaceWorkbenchUnavailable, options...)
}

func WorkspaceFileServiceUnavailable(options ...Option) *ProtocolError {
	return ServiceUnavailable(ReasonWorkspaceFileServiceUnavailable, options...)
}

func WorkspaceAgentSessionServiceUnavailable(options ...Option) *ProtocolError {
	return ServiceUnavailable(ReasonWorkspaceAgentSessionUnavailable, options...)
}

func WorkspaceIssueServiceUnavailable(options ...Option) *ProtocolError {
	return ServiceUnavailable(ReasonWorkspaceIssueServiceUnavailable, options...)
}

func WorkspaceTerminalServiceUnavailable(options ...Option) *ProtocolError {
	return ServiceUnavailable(ReasonWorkspaceTerminalUnavailable, options...)
}

func WorkspaceAppServiceUnavailable(options ...Option) *ProtocolError {
	return ServiceUnavailable(ReasonWorkspaceAppUnavailable, options...)
}

func PreferencesServiceUnavailable(options ...Option) *ProtocolError {
	return ServiceUnavailable(ReasonPreferencesServiceUnavailable, options...)
}

func EventStreamServiceUnavailable(options ...Option) *ProtocolError {
	return ServiceUnavailable(ReasonEventStreamServiceUnavailable, options...)
}

func WorkspaceNotFound(reason string, options ...Option) *ProtocolError {
	return New(StatusWorkspaceNotFound, tuttigenerated.WorkspaceNotFound, reason, options...)
}

func WorkspaceFileNotFound(reason string, options ...Option) *ProtocolError {
	return New(StatusWorkspaceFileNotFound, tuttigenerated.WorkspaceFileNotFound, reason, options...)
}

func WorkspaceIssueResourceNotFound(reason string, options ...Option) *ProtocolError {
	return New(StatusWorkspaceIssueNotFound, tuttigenerated.WorkspaceIssueResourceNotFound, reason, options...)
}

func WorkspaceIssueResourceExists(reason string, options ...Option) *ProtocolError {
	return New(StatusWorkspaceIssueExists, tuttigenerated.WorkspaceIssueResourceExists, reason, options...)
}

func WorkspaceTerminalNotFound(options ...Option) *ProtocolError {
	return New(StatusWorkspaceFileNotFound, tuttigenerated.WorkspaceTerminalNotFound, ReasonWorkspaceTerminalNotFound, options...)
}

func WorkspaceAppNotFound(options ...Option) *ProtocolError {
	return New(StatusWorkspaceNotFound, tuttigenerated.WorkspaceAppNotFound, ReasonWorkspaceAppNotFound, options...)
}

func WorkspaceOperationFailed(options ...Option) *ProtocolError {
	return New(StatusWorkspaceOperationFailed, tuttigenerated.WorkspaceOperationFailed, ReasonWorkspaceOperationFailed, options...)
}

func AgentProviderUnavailable(err *agentservice.ProviderUnavailableError) *ProtocolError {
	reason := ReasonAgentProviderUnavailable
	params := map[string]any{}
	if err != nil {
		if reasonCode := strings.TrimSpace(err.ReasonCode); reasonCode != "" {
			reason = reasonCode
		}
		if provider := strings.TrimSpace(err.Provider); provider != "" {
			params["provider"] = provider
		}
	}
	return New(
		StatusWorkspaceOperationFailed,
		tuttigenerated.WorkspaceOperationFailed,
		reason,
		WithCause(err),
		WithParams(params),
	)
}

func PreferencesOperationFailed(options ...Option) *ProtocolError {
	return New(StatusPreferencesOperationFailed, tuttigenerated.PreferencesOperationFailed, ReasonPreferencesOperationFailed, options...)
}

func MissingWorkspaceID(options ...Option) *ProtocolError {
	return InvalidRequest(ReasonMissingWorkspaceID, options...)
}

func MissingWorkspaceName(options ...Option) *ProtocolError {
	return InvalidRequest(ReasonMissingWorkspaceName, options...)
}

func Classify(err error) *ProtocolError {
	if err == nil {
		return nil
	}
	var protocolErr *ProtocolError
	if errors.As(err, &protocolErr) {
		return protocolErr
	}
	var runtimeAppErr *agentruntime.AppError
	if errors.As(err, &runtimeAppErr) {
		reason := strings.TrimSpace(runtimeAppErr.Code)
		if reason == "" {
			reason = ReasonWorkspaceOperationFailed
		}
		return New(StatusWorkspaceOperationFailed, tuttigenerated.WorkspaceOperationFailed, reason, WithCause(err))
	}
	var providerUnavailableErr *agentservice.ProviderUnavailableError
	if errors.As(err, &providerUnavailableErr) {
		return AgentProviderUnavailable(providerUnavailableErr)
	}
	var invalidModelErr *agentservice.InvalidModelError
	if errors.As(err, &invalidModelErr) {
		params := map[string]any{
			"provider": strings.TrimSpace(invalidModelErr.Provider),
			"model":    strings.TrimSpace(invalidModelErr.Model),
		}
		if len(invalidModelErr.AvailableModels) > 0 {
			params["availableModels"] = invalidModelErr.AvailableModels
		}
		return InvalidRequest("agent.invalid_model", WithCause(err), WithParams(params))
	}
	switch {
	case errors.Is(err, agentservice.ErrNotAGitRepo):
		return InvalidRequest(ReasonNotAGitRepo, WithCause(err))
	case errors.Is(err, agentservice.ErrGitUnavailable):
		return ServiceUnavailable(ReasonGitUnavailable, WithCause(err))
	case errors.Is(err, agentservice.ErrUnsupportedRepoLayout):
		return InvalidRequest(ReasonUnsupportedRepoLayout, WithCause(err))
	case errors.Is(err, agentservice.ErrWorktreeCreateFailed):
		return New(StatusWorkspaceOperationFailed, tuttigenerated.WorkspaceOperationFailed, ReasonWorktreeCreateFailed,
			WithCause(err), WithParams(map[string]any{"detail": err.Error()}))
	case errors.Is(err, agentservice.ErrSubmitDeliveryUnknown):
		return New(StatusWorkspaceOperationFailed, tuttigenerated.WorkspaceOperationFailed, ReasonAgentSubmitDeliveryUnknown, WithCause(err))
	case errors.Is(err, workspacedata.ErrWorkspaceNotFound):
		return WorkspaceNotFound(ReasonWorkspaceNotFound, WithCause(err))
	case errors.Is(err, workspacedata.ErrWorkspaceAppNotFound):
		return WorkspaceAppNotFound(WithCause(err))
	case errors.Is(err, workspacedata.ErrWorkspaceAppFactoryJobNotFound):
		return WorkspaceAppNotFound(WithCause(err))
	case errors.Is(err, workspacefiles.ErrWorkspaceNotFound):
		return WorkspaceNotFound(ReasonWorkspaceNotFound, WithCause(err))
	case errors.Is(err, workspacefiles.ErrEntryNotFound):
		return WorkspaceFileNotFound(ReasonWorkspaceFileNotFound, WithCause(err))
	case errors.Is(err, workspacefiles.ErrEntryAlreadyExists):
		return InvalidRequest(ReasonEntryAlreadyExists, WithCause(err))
	case errors.Is(err, workspacefiles.ErrInvalidEntryKind):
		return InvalidRequest(ReasonInvalidEntryKind, WithCause(err))
	case errors.Is(err, workspacefiles.ErrInvalidPath):
		return InvalidRequest(ReasonInvalidPath, WithCause(err))
	case errors.Is(err, runtimeprep.ErrCwdNotDirectory):
		return InvalidRequest(ReasonInvalidPath, WithCause(err))
	case errors.Is(err, workspacefiles.ErrInvalidUploadSource):
		return InvalidRequest(ReasonInvalidUploadSource, WithCause(err))
	case errors.Is(err, workspacefiles.ErrFileTooLarge):
		return InvalidRequest(ReasonMalformedRequest, WithCause(err))
	case errors.Is(err, workspacefiles.ErrPathEscapesRoot):
		return InvalidRequest(ReasonPathEscapesRoot, WithCause(err))
	case errors.Is(err, workspacefiles.ErrRootDeleteForbidden):
		return InvalidRequest(ReasonRootDeleteForbidden, WithCause(err))
	case errors.Is(err, workspacefiles.ErrAdapterNotConfigured), errors.Is(err, workspacefiles.ErrResolverNotConfigured):
		return WorkspaceFileServiceUnavailable(WithCause(err))
	case errors.Is(err, workspaceissues.ErrInvalidArgument):
		return InvalidRequest(ReasonMalformedRequest, WithCause(err))
	case errors.Is(err, workspaceissues.ErrStoreNotConfigured):
		return WorkspaceIssueServiceUnavailable(WithCause(err))
	case errors.Is(err, workspaceissues.ErrWorkspaceNotFound):
		return WorkspaceNotFound(ReasonWorkspaceNotFound, WithCause(err))
	case errors.Is(err, workspaceissues.ErrIssueNotFound):
		return WorkspaceIssueResourceNotFound(ReasonWorkspaceIssueNotFound, WithCause(err))
	case errors.Is(err, workspaceissues.ErrIssueAlreadyExists):
		return WorkspaceIssueResourceExists(ReasonWorkspaceIssueExists, WithCause(err))
	case errors.Is(err, workspaceissues.ErrTaskNotFound):
		return WorkspaceIssueResourceNotFound(ReasonWorkspaceIssueTaskNotFound, WithCause(err))
	case errors.Is(err, workspaceissues.ErrTaskAlreadyExists):
		return WorkspaceIssueResourceExists(ReasonWorkspaceIssueTaskExists, WithCause(err))
	case errors.Is(err, workspaceissues.ErrRunNotFound):
		return WorkspaceIssueResourceNotFound(ReasonWorkspaceIssueRunNotFound, WithCause(err))
	case errors.Is(err, workspaceissues.ErrRunAlreadyExists):
		return WorkspaceIssueResourceExists(ReasonWorkspaceIssueRunExists, WithCause(err))
	case errors.Is(err, workspaceissues.ErrContextRefNotFound):
		return WorkspaceIssueResourceNotFound(ReasonWorkspaceIssueContextRefNotFound, WithCause(err))
	case errors.Is(err, workspaceissues.ErrContextRefAlreadyExists):
		return WorkspaceIssueResourceExists(ReasonWorkspaceIssueContextRefExists, WithCause(err))
	case errors.Is(err, workspaceissues.ErrTopicNotFound):
		return WorkspaceIssueResourceNotFound(ReasonWorkspaceIssueTopicNotFound, WithCause(err))
	case errors.Is(err, workspaceissues.ErrTopicAlreadyExists):
		return WorkspaceIssueResourceExists(ReasonWorkspaceIssueTopicExists, WithCause(err))
	case errors.Is(err, workspaceissues.ErrTopicNotEmpty):
		return WorkspaceIssueResourceExists(ReasonWorkspaceIssueTopicNotEmpty, WithCause(err))
	case errors.Is(err, workspaceservice.ErrInvalidWorkspaceAppRuntimeState):
		return InvalidRequest(ReasonMalformedRequest, WithCause(err))
	case errors.Is(err, workspaceservice.ErrInvalidAppFactoryJobState):
		return InvalidRequest(ReasonMalformedRequest, WithCause(err))
	case errors.Is(err, workspaceservice.ErrAppPackageAlreadyExists):
		return InvalidRequest(ReasonWorkspaceAppPackageExists, WithCause(err))
	case errors.Is(err, workspaceservice.ErrAppPackageDeleteForbidden):
		return InvalidRequest(ReasonWorkspaceAppDeleteForbidden, WithCause(err))
	case errors.Is(err, workspaceservice.ErrLocalAppPackageInvalid):
		return InvalidRequest(ReasonMalformedRequest, WithCause(err))
	case errors.Is(err, workspaceservice.ErrAppPackageIconInvalid):
		return InvalidRequest(ReasonWorkspaceAppIconInvalid, WithCause(err))
	case errors.Is(err, workspaceservice.ErrAppPackageIconReplaceForbidden):
		return InvalidRequest(ReasonWorkspaceAppIconReplaceForbidden, WithCause(err))
	case errors.Is(err, workspaceservice.ErrInvalidWorkspaceAppUpload),
		errors.Is(err, workspaceservice.ErrWorkspaceAppUploadExpired),
		errors.Is(err, workspaceservice.ErrWorkspaceAppUploadNotReady):
		return InvalidRequest(ReasonMalformedRequest, WithCause(err))
	case errors.Is(err, workspaceservice.ErrWorkspaceAppUploadNotFound):
		return WorkspaceAppNotFound(WithCause(err))
	case errors.Is(err, workspaceservice.ErrInvalidWorkbenchSnapshot):
		return InvalidRequest(ReasonInvalidWorkbenchSnapshot, WithCause(err))
	case errors.Is(err, workspaceservice.ErrTerminalNotFound):
		return WorkspaceTerminalNotFound(WithCause(err))
	case errors.Is(err, workspaceservice.ErrTerminalNotRunning):
		return InvalidRequest(ReasonWorkspaceTerminalNotRunning, WithCause(err))
	case errors.Is(err, agentservice.ErrSessionTitleTooLong):
		return InvalidRequest(
			ReasonWorkspaceAgentSessionTitleTooLong,
			WithCause(err),
			WithParams(map[string]any{"maxCharacters": agentservice.MaxSessionTitleRunes}),
		)
	case errors.Is(err, agentservice.ErrInvalidArgument):
		return InvalidRequest(ReasonMalformedRequest, WithCause(err))
	case errors.Is(err, agentservice.ErrPromptImageUnsupported):
		return InvalidRequest("agent.prompt_image_unsupported", WithCause(err))
	case errors.Is(err, agentservice.ErrSessionNoActiveTurn):
		return InvalidRequest("agent.no_active_turn", WithCause(err))
	case errors.Is(err, agentservice.ErrActiveTurnGuidanceUnsupported):
		return InvalidRequest("agent.active_turn_guidance_unsupported", WithCause(err))
	case errors.Is(err, agentservice.ErrSessionNotFound):
		return WorkspaceNotFound(ReasonWorkspaceAgentSessionNotFound, WithCause(err))
	case errors.Is(err, agentservice.ErrSessionSettingsRequireNewSession):
		return InvalidRequest("agent.settings_require_new_session", WithCause(err))
	case errors.Is(err, agentservice.ErrRuntimeOperationInProgress):
		result := WorkspaceOperationFailed(WithCause(err))
		result.Reason = ReasonAgentRuntimeOperationReconciling
		result.Retryable = true
		return result
	case errors.Is(err, agentservice.ErrRuntimeOperationFailed):
		result := WorkspaceOperationFailed(WithCause(err))
		result.Reason = ReasonAgentRuntimeOperationFailed
		return result
	default:
		return WorkspaceOperationFailed(WithCause(err))
	}
}
