package appcli

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"

	appclicore "github.com/tutti-os/tutti/packages/appcli/core"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
)

const invokeSchemaVersion = appclicore.InvokeSchemaVersion

var reservedScopes = map[string]struct{}{
	"agent":  {},
	"help":   {},
	"issue":  {},
	"plan":   {},
	"status": {},
}

type WorkspaceCatalog interface {
	Startup(context.Context) (*workspacebiz.Summary, error)
	Get(context.Context, string) (workspacebiz.Summary, error)
}

type RuntimeController interface {
	EnsureAppRunningForCLI(context.Context, string, string) (string, error)
}

type Registry struct {
	Workspaces WorkspaceCatalog
	Runtime    RuntimeController
	HTTPClient *http.Client

	mu        sync.RWMutex
	scopeSets map[string]*appclicore.ScopeSet
}

type Activation struct {
	WorkspaceID string
	AppPackage  workspacebiz.AppPackage
	BaseURL     string
}

func NewRegistry(workspaces WorkspaceCatalog, runtime RuntimeController) *Registry {
	return &Registry{Workspaces: workspaces, Runtime: runtime}
}

func (r *Registry) Activate(_ context.Context, activation Activation) workspacebiz.AppCLIState {
	workspaceID := strings.TrimSpace(activation.WorkspaceID)
	appPackage := activation.AppPackage
	if appPackage.Manifest.CLI == nil {
		r.Deactivate(workspaceID, appPackage.AppID)
		return workspacebiz.AppCLIState{Status: workspacebiz.AppCLIStatusNone}
	}

	cliPath, err := CLIManifestPath(appPackage.PackageDir, appPackage.Manifest.CLI.Manifest)
	if err != nil {
		return r.setError(workspaceID, appPackage.AppID, "", "app_cli_manifest_path_invalid", err.Error())
	}
	manifest, err := ReadManifest(cliPath)
	if err != nil {
		return r.setError(workspaceID, appPackage.AppID, "", "app_cli_manifest_invalid", err.Error())
	}
	documentationFile, documentationPath, err := resolveDocumentation(appPackage.PackageDir, manifest)
	if err != nil {
		return r.setError(workspaceID, appPackage.AppID, manifest.Scope, errCode(err), err.Error())
	}
	iconURL := ""
	if appIconURL := appPackage.IconDataURL(); appIconURL != nil {
		iconURL = strings.TrimSpace(*appIconURL)
	}
	commands := appclicore.BuildCommands(manifest, appclicore.CommandBuildOptions{
		AppID:             appPackage.AppID,
		AppName:           appPackage.DisplayName(),
		IconURL:           iconURL,
		AppDescription:    appPackage.Description(),
		DocumentationFile: documentationFile,
		DocumentationPath: documentationPath,
	})

	r.mu.Lock()
	defer r.mu.Unlock()
	scopeSet := r.scopeSetLocked(workspaceID)
	state := scopeSet.Upsert(appclicore.RegisteredApp{
		AppID:    appPackage.AppID,
		AppName:  appPackage.DisplayName(),
		Scope:    manifest.Scope,
		BaseURL:  strings.TrimRight(strings.TrimSpace(activation.BaseURL), "/"),
		Commands: commands,
	})
	return serviceState(state)
}

func (r *Registry) Deactivate(workspaceID string, appID string) {
	workspaceID = strings.TrimSpace(workspaceID)
	appID = strings.TrimSpace(appID)
	if workspaceID == "" || appID == "" {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.scopeSets == nil {
		return
	}
	if scopeSet := r.scopeSets[workspaceID]; scopeSet != nil {
		scopeSet.Remove(appID)
		if scopeSet.Empty() {
			delete(r.scopeSets, workspaceID)
		}
	}
}

func (r *Registry) DeactivateApp(appID string) {
	appID = strings.TrimSpace(appID)
	if appID == "" {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	for workspaceID, scopeSet := range r.scopeSets {
		if scopeSet == nil {
			continue
		}
		scopeSet.Remove(appID)
		if scopeSet.Empty() {
			delete(r.scopeSets, workspaceID)
		}
	}
}

func (r *Registry) Status(workspaceID string, app workspacebiz.WorkspaceApp) workspacebiz.AppCLIState {
	if app.Installation == nil || app.Package.Manifest.CLI == nil {
		return workspacebiz.AppCLIState{Status: workspacebiz.AppCLIStatusNone}
	}
	workspaceID = strings.TrimSpace(workspaceID)
	r.mu.RLock()
	defer r.mu.RUnlock()
	if r.scopeSets != nil {
		if scopeSet := r.scopeSets[workspaceID]; scopeSet != nil {
			if state := serviceState(scopeSet.State(app.Package.AppID)); state.Status != "" {
				return state
			}
		}
	}
	return workspacebiz.AppCLIState{Status: workspacebiz.AppCLIStatusPending}
}

func (r *Registry) Capabilities(ctx context.Context, invokeContext cliservice.InvokeContext) []cliservice.Capability {
	workspaceID, err := r.resolveWorkspaceID(ctx, invokeContext.WorkspaceID)
	if err != nil {
		return []cliservice.Capability{}
	}
	r.mu.RLock()
	scopeSet := r.scopeSet(workspaceID)
	if scopeSet == nil {
		r.mu.RUnlock()
		return []cliservice.Capability{}
	}
	capabilities := scopeSet.Capabilities(appclicore.CapabilityListOptions{
		IncludeIntegration: invokeContext.IncludeIntegrationCapabilities,
	})
	r.mu.RUnlock()
	return serviceCapabilities(capabilities)
}

func (r *Registry) Invoke(ctx context.Context, request cliservice.InvokeRequest) (cliservice.CommandOutput, error) {
	commandID := strings.TrimSpace(request.CommandID)
	if commandID == "" {
		return cliservice.CommandOutput{}, cliservice.ErrCommandNotFound
	}
	if strings.TrimSpace(request.Context.ParentCommandID) == commandID {
		return cliservice.CommandOutput{}, fmt.Errorf("%w: recursive app cli command invocation", cliservice.ErrInvalidInput)
	}
	workspaceID, err := r.resolveWorkspaceID(ctx, request.Context.WorkspaceID)
	if err != nil {
		return cliservice.CommandOutput{}, err
	}
	app, command, ok := r.command(workspaceID, commandID)
	if !ok {
		return cliservice.CommandOutput{}, cliservice.ErrCommandNotFound
	}
	if request.OutputMode == "" {
		request.OutputMode = serviceOutputMode(command.Capability.Output.DefaultMode)
	}
	input, warnings, err := appclicore.NormalizeInputWithWarnings(command.Manifest.InputSchema, request.Input)
	if err != nil {
		return cliservice.CommandOutput{}, serviceInvokeError(err)
	}
	baseURL, err := r.ensureRunning(ctx, workspaceID, app.AppID, app.BaseURL)
	if err != nil {
		return cliservice.CommandOutput{}, cliservice.ServiceUnavailableError("app_cli_runtime_unavailable", err)
	}
	output, err := appclicore.InvokeHTTP(ctx, appclicore.HTTPInvokeRequest{
		BaseURL:     baseURL,
		Command:     command,
		AppID:       app.AppID,
		Scope:       app.Scope,
		WorkspaceID: workspaceID,
		Input:       input,
		OutputMode:  coreOutputMode(request.OutputMode),
		Context: appclicore.InvokeContext{
			Source:          request.Context.Source,
			ParentCommandID: request.Context.ParentCommandID,
		},
		HTTPClient: r.HTTPClient,
	})
	if err != nil {
		return cliservice.CommandOutput{}, serviceInvokeError(err)
	}
	output, err = appclicore.ValidateCommandOutput(command.Capability.Output, output)
	if err != nil {
		return cliservice.CommandOutput{}, serviceInvokeError(err)
	}
	if err := appclicore.ValidateCommandContinuation(command.Capability.Execution, output); err != nil {
		return cliservice.CommandOutput{}, serviceInvokeError(err)
	}
	result := serviceCommandOutput(output)
	result.Warnings = serviceInputWarnings(warnings)
	return result, nil
}

func (r *Registry) command(workspaceID string, commandID string) (appclicore.RegisteredApp, appclicore.Command, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	scopeSet := r.scopeSet(workspaceID)
	if scopeSet == nil {
		return appclicore.RegisteredApp{}, appclicore.Command{}, false
	}
	return scopeSet.Command(commandID)
}

func (r *Registry) ensureRunning(ctx context.Context, workspaceID string, appID string, fallbackBaseURL string) (string, error) {
	if r.Runtime == nil {
		if strings.TrimSpace(fallbackBaseURL) == "" {
			return "", errors.New("app cli runtime controller is unavailable")
		}
		return strings.TrimRight(strings.TrimSpace(fallbackBaseURL), "/"), nil
	}
	baseURL, err := r.Runtime.EnsureAppRunningForCLI(ctx, workspaceID, appID)
	if err != nil {
		return "", err
	}
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if baseURL == "" {
		return "", errors.New("app runtime base url is unavailable")
	}
	r.mu.Lock()
	if scopeSet := r.scopeSet(workspaceID); scopeSet != nil {
		scopeSet.UpdateBaseURL(appID, baseURL)
	}
	r.mu.Unlock()
	return baseURL, nil
}

func (r *Registry) setError(workspaceID string, appID string, scope string, code string, message string) workspacebiz.AppCLIState {
	r.mu.Lock()
	defer r.mu.Unlock()
	scopeSet := r.scopeSetLocked(workspaceID)
	return serviceState(scopeSet.SetError(appID, scope, appclicore.Issue{Code: code, Message: message}))
}

func (r *Registry) resolveWorkspaceID(ctx context.Context, requested string) (string, error) {
	if r.Workspaces == nil {
		return strings.TrimSpace(requested), nil
	}
	return cliservice.ResolveWorkspaceID(ctx, r.Workspaces, requested)
}

func (r *Registry) scopeSet(workspaceID string) *appclicore.ScopeSet {
	if r.scopeSets == nil {
		return nil
	}
	return r.scopeSets[strings.TrimSpace(workspaceID)]
}

func (r *Registry) scopeSetLocked(workspaceID string) *appclicore.ScopeSet {
	if r.scopeSets == nil {
		r.scopeSets = map[string]*appclicore.ScopeSet{}
	}
	workspaceID = strings.TrimSpace(workspaceID)
	if r.scopeSets[workspaceID] == nil {
		r.scopeSets[workspaceID] = appclicore.NewScopeSet(appclicore.ScopeSetOptions{
			ReservedScopes: reservedScopes,
			IssueMessages: appclicore.ScopeIssueMessages{
				Reserved: func(scope string) appclicore.Issue {
					return appclicore.Issue{
						Code:    "app_cli_scope_reserved",
						Message: fmt.Sprintf("CLI scope %q is reserved by Tutti.", scope),
					}
				},
				Conflict: func(scope string, winnerAppID string) appclicore.Issue {
					return appclicore.Issue{
						Code:    "app_cli_scope_conflict",
						Message: fmt.Sprintf("CLI scope %q is already provided by app %q.", scope, winnerAppID),
					}
				},
			},
		})
	}
	return r.scopeSets[workspaceID]
}

type documentationError struct {
	code string
	err  error
}

func (e documentationError) Error() string {
	if e.err == nil {
		return ""
	}
	return e.err.Error()
}

func (e documentationError) Unwrap() error {
	return e.err
}

func errCode(err error) string {
	var docErr documentationError
	if errors.As(err, &docErr) {
		return docErr.code
	}
	return "app_cli_documentation_path_invalid"
}

func resolveDocumentation(packageDir string, manifest Manifest) (string, string, error) {
	if manifest.Documentation == nil {
		return "", "", nil
	}
	documentationFile := strings.TrimSpace(manifest.Documentation.File)
	resolvedDocumentationPath, err := CLIManifestPath(packageDir, documentationFile)
	if err != nil {
		return "", "", documentationError{code: "app_cli_documentation_path_invalid", err: err}
	}
	if info, err := os.Stat(resolvedDocumentationPath); err != nil || info.IsDir() {
		if err == nil {
			err = fmt.Errorf("documentation file %q is a directory", documentationFile)
		}
		return "", "", documentationError{code: "app_cli_documentation_missing", err: err}
	}
	absoluteDocumentationPath, err := filepath.Abs(resolvedDocumentationPath)
	if err != nil {
		return "", "", documentationError{code: "app_cli_documentation_path_invalid", err: err}
	}
	return documentationFile, absoluteDocumentationPath, nil
}

func serviceInvokeError(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, appclicore.ErrInvalidInput) {
		return fmt.Errorf("%w: %s", cliservice.ErrInvalidInput, err.Error())
	}
	if errors.Is(err, appclicore.ErrServiceUnavailable) {
		reason := appclicore.InvokeErrorReason(err)
		if reason == "" {
			reason = "app_cli_runtime_unavailable"
		}
		return cliservice.ServiceUnavailableError(reason, err)
	}
	if errors.Is(err, appclicore.ErrHandlerBadResponse) || errors.Is(err, appclicore.ErrHandlerFailed) {
		reason := appclicore.InvokeErrorReason(err)
		if reason == "" {
			reason = "app_cli_handler_bad_response"
		}
		return cliservice.WorkspaceOperationError(reason, err)
	}
	return err
}

func serviceCapabilities(capabilities []appclicore.Capability) []cliservice.Capability {
	if len(capabilities) == 0 {
		return []cliservice.Capability{}
	}
	result := make([]cliservice.Capability, 0, len(capabilities))
	for _, capability := range capabilities {
		result = append(result, serviceCapability(capability))
	}
	return result
}

func serviceCapability(capability appclicore.Capability) cliservice.Capability {
	return cliservice.Capability{
		ID:               capability.ID,
		Path:             append([]string(nil), capability.Path...),
		Summary:          capability.Summary,
		Description:      capability.Description,
		Visibility:       serviceCapabilityVisibility(capability.Visibility),
		InputSchema:      appclicore.CloneSchema(capability.InputSchema),
		Output:           serviceCapabilityOutput(capability.Output),
		Execution:        serviceCommandExecution(capability.Execution),
		HandlerTimeoutMs: capability.HandlerTimeoutMs,
		Source:           serviceCapabilitySource(capability.Source),
	}
}

func serviceCommandExecution(execution *appclicore.CommandExecution) *cliservice.CommandExecution {
	if execution == nil {
		return nil
	}
	return &cliservice.CommandExecution{Mode: cliservice.CommandExecutionMode(execution.Mode)}
}

func serviceCapabilityVisibility(visibility appclicore.CommandVisibility) cliservice.CapabilityVisibility {
	switch appclicore.NormalizeVisibility(visibility) {
	case appclicore.CommandVisibilityIntegration:
		return cliservice.CapabilityVisibilityIntegration
	default:
		return cliservice.CapabilityVisibilityPublic
	}
}

func serviceCapabilityOutput(output appclicore.CapabilityOutput) cliservice.CapabilityOutput {
	return cliservice.CapabilityOutput{
		DefaultMode: serviceOutputMode(output.DefaultMode),
		JSON:        output.JSON,
		Table:       serviceTableOutput(output.Table),
	}
}

func serviceCapabilitySource(source appclicore.CapabilitySource) cliservice.CapabilitySource {
	return cliservice.CapabilitySource{
		Kind:              cliservice.CapabilitySourceApp,
		AppID:             source.AppID,
		AppName:           source.AppName,
		IconURL:           source.IconURL,
		CLIDescription:    source.CLIDescription,
		AppDescription:    source.AppDescription,
		DocumentationFile: source.DocumentationFile,
		DocumentationPath: source.DocumentationPath,
	}
}

func serviceTableOutput(output *appclicore.TableOutput) *cliservice.TableOutput {
	if output == nil {
		return nil
	}
	return &cliservice.TableOutput{Columns: serviceTableColumns(output.Columns)}
}

func serviceCommandOutput(output appclicore.CommandOutput) cliservice.CommandOutput {
	result := cliservice.CommandOutput{
		Kind:    serviceOutputMode(output.Kind),
		Columns: serviceTableColumns(output.Columns),
		Rows:    output.Rows,
		Value:   output.Value,
		Text:    output.Text,
	}
	if output.Continuation != nil {
		result.Continuation = &cliservice.CommandContinuation{
			State: cliservice.CommandContinuationState(output.Continuation.State), RetryAfterMs: output.Continuation.RetryAfterMs,
		}
	}
	return result
}

func serviceInputWarnings(warnings []appclicore.InputWarning) []cliservice.CommandWarning {
	if len(warnings) == 0 {
		return nil
	}
	result := make([]cliservice.CommandWarning, 0, len(warnings))
	for _, warning := range warnings {
		result = append(result, cliservice.CommandWarning{
			Code:    warning.Code,
			Message: warning.Message,
		})
	}
	return result
}

func serviceTableColumns(columns []appclicore.TableColumn) []cliservice.TableColumn {
	if len(columns) == 0 {
		return nil
	}
	result := make([]cliservice.TableColumn, 0, len(columns))
	for _, column := range columns {
		result = append(result, cliservice.TableColumn{Key: column.Key, Label: column.Label})
	}
	return result
}

func serviceOutputMode(mode appclicore.OutputMode) cliservice.OutputMode {
	return cliservice.OutputMode(mode)
}

func coreOutputMode(mode cliservice.OutputMode) appclicore.OutputMode {
	return appclicore.OutputMode(mode)
}

func serviceState(state appclicore.State) workspacebiz.AppCLIState {
	if state.Status == "" {
		return workspacebiz.AppCLIState{}
	}
	return workspacebiz.AppCLIState{
		Status: workspacebiz.AppCLIStatus(state.Status),
		Scope:  state.Scope,
		Active: state.Active,
		Issues: serviceIssues(state.Issues),
	}
}

func serviceIssues(issues []appclicore.Issue) []workspacebiz.AppCLIIssue {
	if len(issues) == 0 {
		return nil
	}
	result := make([]workspacebiz.AppCLIIssue, 0, len(issues))
	for _, issue := range issues {
		result = append(result, workspacebiz.AppCLIIssue{Code: issue.Code, Message: issue.Message})
	}
	return result
}
