package appcli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
)

const invokeSchemaVersion = "tutti.app.cli.invoke.v1"

var reservedScopes = map[string]struct{}{
	"agent":  {},
	"help":   {},
	"issue":  {},
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
	entries   map[string]map[string]*entry
	statuses  map[string]map[string]workspacebiz.AppCLIState
	commandID map[string]commandRef
}

type Activation struct {
	WorkspaceID string
	AppPackage  workspacebiz.AppPackage
	BaseURL     string
}

type commandRef struct {
	workspaceID string
	appID       string
	commandID   string
}

type entry struct {
	workspaceID string
	appID       string
	appName     string
	scope       string
	baseURL     string
	commands    []appCommand
	active      bool
	issues      []workspacebiz.AppCLIIssue
}

type appCommand struct {
	capability cliservice.Capability
	manifest   ManifestCommand
	timeout    time.Duration
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
	documentationFile := ""
	documentationPath := ""
	if manifest.Documentation != nil {
		documentationFile = strings.TrimSpace(manifest.Documentation.File)
		resolvedDocumentationPath, err := CLIManifestPath(appPackage.PackageDir, documentationFile)
		if err != nil {
			return r.setError(workspaceID, appPackage.AppID, manifest.Scope, "app_cli_documentation_path_invalid", err.Error())
		}
		if info, err := os.Stat(resolvedDocumentationPath); err != nil || info.IsDir() {
			if err == nil {
				err = fmt.Errorf("documentation file %q is a directory", documentationFile)
			}
			return r.setError(workspaceID, appPackage.AppID, manifest.Scope, "app_cli_documentation_missing", err.Error())
		}
		absoluteDocumentationPath, err := filepath.Abs(resolvedDocumentationPath)
		if err != nil {
			return r.setError(workspaceID, appPackage.AppID, manifest.Scope, "app_cli_documentation_path_invalid", err.Error())
		}
		documentationPath = absoluteDocumentationPath
	}
	iconURL := ""
	if appIconURL := appPackage.IconDataURL(); appIconURL != nil {
		iconURL = strings.TrimSpace(*appIconURL)
	}
	commands := make([]appCommand, 0, len(manifest.Commands))
	for _, command := range manifest.Commands {
		commandID := commandID(appPackage.AppID, manifest.Scope, command.Path)
		commands = append(commands, appCommand{
			capability: cliservice.Capability{
				ID:          commandID,
				Path:        append([]string{manifest.Scope}, command.Path...),
				Summary:     strings.TrimSpace(command.Summary),
				Description: strings.TrimSpace(command.Description),
				InputSchema: cloneSchema(command.InputSchema),
				Output: cliservice.CapabilityOutput{
					DefaultMode: command.Output.DefaultMode,
					JSON:        command.Output.JSON,
					Table:       tableOutput(command.Output.Table),
				},
				Source: cliservice.CapabilitySource{
					Kind:              cliservice.CapabilitySourceApp,
					AppID:             appPackage.AppID,
					AppName:           appPackage.DisplayName(),
					IconURL:           iconURL,
					CLIDescription:    strings.TrimSpace(manifest.Description),
					AppDescription:    strings.TrimSpace(appPackage.Description()),
					DocumentationFile: documentationFile,
					DocumentationPath: documentationPath,
				},
			},
			manifest: command,
			timeout:  time.Duration(normalizedTimeoutMs(command.Handler.TimeoutMs)) * time.Millisecond,
		})
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	r.ensureLocked()
	if r.entries[workspaceID] == nil {
		r.entries[workspaceID] = map[string]*entry{}
	}
	r.entries[workspaceID][appPackage.AppID] = &entry{
		workspaceID: workspaceID,
		appID:       appPackage.AppID,
		appName:     appPackage.DisplayName(),
		scope:       manifest.Scope,
		baseURL:     strings.TrimRight(strings.TrimSpace(activation.BaseURL), "/"),
		commands:    commands,
	}
	r.recomputeWorkspaceLocked(workspaceID)
	return r.statusLocked(workspaceID, appPackage.AppID, appPackage.Manifest.CLI != nil)
}

func (r *Registry) Deactivate(workspaceID string, appID string) {
	workspaceID = strings.TrimSpace(workspaceID)
	appID = strings.TrimSpace(appID)
	if workspaceID == "" || appID == "" {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.ensureLocked()
	if r.entries[workspaceID] != nil {
		delete(r.entries[workspaceID], appID)
	}
	if r.statuses[workspaceID] != nil {
		delete(r.statuses[workspaceID], appID)
	}
	r.recomputeWorkspaceLocked(workspaceID)
}

func (r *Registry) DeactivateApp(appID string) {
	appID = strings.TrimSpace(appID)
	if appID == "" {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.ensureLocked()
	for workspaceID, entries := range r.entries {
		delete(entries, appID)
		if r.statuses[workspaceID] != nil {
			delete(r.statuses[workspaceID], appID)
		}
		r.recomputeWorkspaceLocked(workspaceID)
	}
}

func (r *Registry) Status(workspaceID string, app workspacebiz.WorkspaceApp) workspacebiz.AppCLIState {
	if app.Installation == nil || app.Package.Manifest.CLI == nil {
		return workspacebiz.AppCLIState{Status: workspacebiz.AppCLIStatusNone}
	}
	workspaceID = strings.TrimSpace(workspaceID)
	r.mu.RLock()
	defer r.mu.RUnlock()
	if r.statuses != nil && r.statuses[workspaceID] != nil {
		if state, ok := r.statuses[workspaceID][app.Package.AppID]; ok {
			return cloneState(state)
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
	defer r.mu.RUnlock()
	workspaceEntries := r.entries[workspaceID]
	if len(workspaceEntries) == 0 {
		return []cliservice.Capability{}
	}
	appIDs := make([]string, 0, len(workspaceEntries))
	for appID := range workspaceEntries {
		appIDs = append(appIDs, appID)
	}
	sort.Strings(appIDs)
	result := make([]cliservice.Capability, 0)
	for _, appID := range appIDs {
		entry := workspaceEntries[appID]
		if entry == nil || !entry.active {
			continue
		}
		for _, command := range entry.commands {
			result = append(result, command.capability)
		}
	}
	return result
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
	entry, command, ok := r.command(workspaceID, commandID)
	if !ok {
		return cliservice.CommandOutput{}, cliservice.ErrCommandNotFound
	}
	if request.OutputMode == "" {
		request.OutputMode = command.capability.Output.DefaultMode
	}
	input, err := normalizeInput(command.manifest.InputSchema, request.Input)
	if err != nil {
		return cliservice.CommandOutput{}, err
	}
	baseURL, err := r.ensureRunning(ctx, workspaceID, entry.appID, entry.baseURL)
	if err != nil {
		return cliservice.CommandOutput{}, cliservice.ServiceUnavailableError("app_cli_runtime_unavailable", err)
	}
	output, err := r.invokeHTTP(ctx, baseURL, entry, command, workspaceID, input, request.OutputMode, request.Context)
	if err != nil {
		return cliservice.CommandOutput{}, err
	}
	return validateCommandOutput(command.capability.Output, output)
}

func (r *Registry) command(workspaceID string, commandID string) (*entry, appCommand, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	ref, ok := r.commandID[workspaceID+"\x00"+commandID]
	if !ok {
		return nil, appCommand{}, false
	}
	entry := r.entries[ref.workspaceID][ref.appID]
	if entry == nil || !entry.active {
		return nil, appCommand{}, false
	}
	for _, command := range entry.commands {
		if command.capability.ID == ref.commandID {
			return entry, command, true
		}
	}
	return nil, appCommand{}, false
}

func (r *Registry) ensureRunning(ctx context.Context, workspaceID string, appID string, fallbackBaseURL string) (string, error) {
	if r.Runtime == nil {
		if strings.TrimSpace(fallbackBaseURL) == "" {
			return "", errors.New("app cli runtime controller is unavailable")
		}
		return fallbackBaseURL, nil
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
	if r.entries[workspaceID] != nil && r.entries[workspaceID][appID] != nil {
		r.entries[workspaceID][appID].baseURL = baseURL
	}
	r.mu.Unlock()
	return baseURL, nil
}

func (r *Registry) invokeHTTP(
	ctx context.Context,
	baseURL string,
	entry *entry,
	command appCommand,
	workspaceID string,
	input map[string]any,
	outputMode cliservice.OutputMode,
	invokeContext cliservice.InvokeContext,
) (cliservice.CommandOutput, error) {
	endpoint, err := url.JoinPath(baseURL, command.manifest.Handler.Path)
	if err != nil {
		return cliservice.CommandOutput{}, cliservice.WorkspaceOperationError("app_cli_handler_bad_response", err)
	}
	envelope := invokeEnvelope{
		SchemaVersion: invokeSchemaVersion,
		CommandID:     command.capability.ID,
		AppID:         entry.appID,
		Scope:         entry.scope,
		Path:          command.manifest.Path,
		WorkspaceID:   workspaceID,
		Input:         input,
		OutputMode:    outputMode,
		Context: invokeEnvelopeContext{
			Source:          firstNonEmpty(invokeContext.Source, "cli"),
			ParentCommandID: nullableString(invokeContext.ParentCommandID),
		},
	}
	body, err := json.Marshal(envelope)
	if err != nil {
		return cliservice.CommandOutput{}, cliservice.WorkspaceOperationError("app_cli_handler_bad_response", err)
	}
	requestCtx, cancel := context.WithTimeout(ctx, command.timeout)
	defer cancel()
	httpRequest, err := http.NewRequestWithContext(requestCtx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return cliservice.CommandOutput{}, cliservice.WorkspaceOperationError("app_cli_handler_bad_response", err)
	}
	httpRequest.Header.Set("Accept", "application/json")
	httpRequest.Header.Set("Content-Type", "application/json")

	response, err := r.httpClient().Do(httpRequest)
	if err != nil {
		if errors.Is(requestCtx.Err(), context.DeadlineExceeded) {
			return cliservice.CommandOutput{}, cliservice.ServiceUnavailableError("app_cli_handler_timeout", err)
		}
		if isConnectionUnavailable(err) {
			return cliservice.CommandOutput{}, cliservice.ServiceUnavailableError("app_cli_runtime_unavailable", err)
		}
		return cliservice.CommandOutput{}, cliservice.WorkspaceOperationError("app_cli_handler_bad_response", err)
	}
	defer response.Body.Close()
	content, err := io.ReadAll(io.LimitReader(response.Body, 1024*1024))
	if err != nil {
		return cliservice.CommandOutput{}, cliservice.WorkspaceOperationError("app_cli_handler_bad_response", err)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		if validAppErrorBody(content) {
			return cliservice.CommandOutput{}, cliservice.WorkspaceOperationError("app_cli_handler_failed", errors.New(appErrorMessage(content)))
		}
		return cliservice.CommandOutput{}, cliservice.WorkspaceOperationError("app_cli_handler_bad_response", fmt.Errorf("app cli handler returned %s", response.Status))
	}
	output, err := decodeCommandOutput(content)
	if err != nil {
		return cliservice.CommandOutput{}, cliservice.WorkspaceOperationError("app_cli_handler_bad_response", err)
	}
	return output, nil
}

func (r *Registry) setError(workspaceID string, appID string, scope string, code string, message string) workspacebiz.AppCLIState {
	state := workspacebiz.AppCLIState{
		Status: workspacebiz.AppCLIStatusError,
		Scope:  strings.TrimSpace(scope),
		Active: false,
		Issues: []workspacebiz.AppCLIIssue{{Code: code, Message: message}},
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.ensureLocked()
	if r.statuses[workspaceID] == nil {
		r.statuses[workspaceID] = map[string]workspacebiz.AppCLIState{}
	}
	r.statuses[workspaceID][appID] = state
	if r.entries[workspaceID] != nil {
		delete(r.entries[workspaceID], appID)
	}
	r.recomputeWorkspaceLocked(workspaceID)
	return cloneState(state)
}

func (r *Registry) recomputeWorkspaceLocked(workspaceID string) {
	r.ensureLocked()
	commandPrefix := workspaceID + "\x00"
	for key := range r.commandID {
		if strings.HasPrefix(key, commandPrefix) {
			delete(r.commandID, key)
		}
	}
	entries := r.entries[workspaceID]
	if len(entries) == 0 {
		return
	}
	byScope := map[string][]*entry{}
	for _, entry := range entries {
		if entry == nil {
			continue
		}
		entry.active = false
		entry.issues = nil
		byScope[entry.scope] = append(byScope[entry.scope], entry)
	}
	if r.statuses[workspaceID] == nil {
		r.statuses[workspaceID] = map[string]workspacebiz.AppCLIState{}
	}
	for scope, scopedEntries := range byScope {
		sort.Slice(scopedEntries, func(left, right int) bool {
			return scopedEntries[left].appID < scopedEntries[right].appID
		})
		if _, reserved := reservedScopes[scope]; reserved {
			for _, entry := range scopedEntries {
				entry.issues = []workspacebiz.AppCLIIssue{{
					Code:    "app_cli_scope_reserved",
					Message: fmt.Sprintf("CLI scope %q is reserved by Tutti.", scope),
				}}
				r.statuses[workspaceID][entry.appID] = stateFromEntry(entry, workspacebiz.AppCLIStatusWarning)
			}
			continue
		}
		winner := scopedEntries[0]
		winner.active = true
		r.statuses[workspaceID][winner.appID] = stateFromEntry(winner, workspacebiz.AppCLIStatusActive)
		for _, command := range winner.commands {
			r.commandID[workspaceID+"\x00"+command.capability.ID] = commandRef{
				workspaceID: workspaceID,
				appID:       winner.appID,
				commandID:   command.capability.ID,
			}
		}
		for _, loser := range scopedEntries[1:] {
			loser.issues = []workspacebiz.AppCLIIssue{{
				Code:    "app_cli_scope_conflict",
				Message: fmt.Sprintf("CLI scope %q is already provided by app %q.", scope, winner.appID),
			}}
			r.statuses[workspaceID][loser.appID] = stateFromEntry(loser, workspacebiz.AppCLIStatusWarning)
		}
	}
}

func (r *Registry) statusLocked(workspaceID string, appID string, declared bool) workspacebiz.AppCLIState {
	if !declared {
		return workspacebiz.AppCLIState{Status: workspacebiz.AppCLIStatusNone}
	}
	if r.statuses[workspaceID] != nil {
		if state, ok := r.statuses[workspaceID][appID]; ok {
			return cloneState(state)
		}
	}
	return workspacebiz.AppCLIState{Status: workspacebiz.AppCLIStatusPending}
}

func (r *Registry) resolveWorkspaceID(ctx context.Context, requested string) (string, error) {
	if r.Workspaces == nil {
		return strings.TrimSpace(requested), nil
	}
	return cliservice.ResolveWorkspaceID(ctx, r.Workspaces, requested)
}

func (r *Registry) httpClient() *http.Client {
	if r.HTTPClient != nil {
		return r.HTTPClient
	}
	// Cover the largest command budget the manifest allows (maxTimeoutMs) plus a
	// small buffer; the per-command context.WithTimeout(command.timeout) still
	// enforces the real deadline. A shorter client timeout would cut long
	// synchronous commands (e.g. vibe-design session-start at 300s) short and
	// surface them as app_cli_runtime_unavailable.
	return &http.Client{Timeout: maxTimeoutMs*time.Millisecond + 30*time.Second}
}

func (r *Registry) ensureLocked() {
	if r.entries == nil {
		r.entries = map[string]map[string]*entry{}
	}
	if r.statuses == nil {
		r.statuses = map[string]map[string]workspacebiz.AppCLIState{}
	}
	if r.commandID == nil {
		r.commandID = map[string]commandRef{}
	}
}

func stateFromEntry(entry *entry, status workspacebiz.AppCLIStatus) workspacebiz.AppCLIState {
	return workspacebiz.AppCLIState{
		Status: status,
		Scope:  entry.scope,
		Active: status == workspacebiz.AppCLIStatusActive,
		Issues: append([]workspacebiz.AppCLIIssue(nil), entry.issues...),
	}
}

func cloneState(state workspacebiz.AppCLIState) workspacebiz.AppCLIState {
	state.Issues = append([]workspacebiz.AppCLIIssue(nil), state.Issues...)
	return state
}

func commandID(appID string, scope string, path []string) string {
	parts := []string{"app", strings.TrimSpace(appID), strings.TrimSpace(scope)}
	parts = append(parts, path...)
	return strings.Join(parts, ".")
}

func tableOutput(output *ManifestTableOutput) *cliservice.TableOutput {
	if output == nil {
		return nil
	}
	return &cliservice.TableOutput{Columns: append([]cliservice.TableColumn(nil), output.Columns...)}
}

func cloneSchema(schema map[string]any) map[string]any {
	if len(schema) == 0 {
		return nil
	}
	cloned := make(map[string]any, len(schema))
	for key, value := range schema {
		cloned[key] = value
	}
	return cloned
}

type invokeEnvelope struct {
	SchemaVersion string                `json:"schemaVersion"`
	CommandID     string                `json:"commandId"`
	AppID         string                `json:"appId"`
	Scope         string                `json:"scope"`
	Path          []string              `json:"path"`
	WorkspaceID   string                `json:"workspaceId"`
	Input         map[string]any        `json:"input"`
	OutputMode    cliservice.OutputMode `json:"outputMode"`
	Context       invokeEnvelopeContext `json:"context"`
}

type invokeEnvelopeContext struct {
	Source          string  `json:"source"`
	ParentCommandID *string `json:"parentCommandId"`
}

func nullableString(value string) *string {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return &value
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func isConnectionUnavailable(err error) bool {
	var netErr net.Error
	if errors.As(err, &netErr) {
		return true
	}
	return strings.Contains(strings.ToLower(err.Error()), "connection refused")
}

func validAppErrorBody(content []byte) bool {
	var body struct {
		Error *struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(content, &body); err != nil {
		return false
	}
	return body.Error != nil && strings.TrimSpace(body.Error.Code) != "" && strings.TrimSpace(body.Error.Message) != ""
}

func appErrorMessage(content []byte) string {
	var body struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(content, &body); err == nil && strings.TrimSpace(body.Error.Message) != "" {
		return strings.TrimSpace(body.Error.Message)
	}
	return "app cli handler failed"
}

func normalizeInput(schema map[string]any, input map[string]any) (map[string]any, error) {
	if len(schema) == 0 {
		return map[string]any{}, nil
	}
	properties, _ := schema["properties"].(map[string]any)
	required := map[string]bool{}
	for _, name := range requiredNames(schema) {
		required[name] = true
	}
	result := make(map[string]any, len(input))
	for key, value := range input {
		property, ok := properties[key]
		if !ok {
			continue
		}
		propertyMap, _ := property.(map[string]any)
		normalized, err := normalizeValue(schemaType(propertyMap), value)
		if err != nil {
			return nil, fmt.Errorf("%w: invalid input %q", cliservice.ErrInvalidInput, key)
		}
		result[key] = normalized
	}
	for name := range required {
		if _, ok := result[name]; !ok {
			return nil, fmt.Errorf("%w: required input %q is missing", cliservice.ErrInvalidInput, name)
		}
	}
	return result, nil
}

func normalizeValue(typeName string, value any) (any, error) {
	switch typeName {
	case "string":
		text, ok := value.(string)
		if !ok {
			return nil, errors.New("not a string")
		}
		return text, nil
	case "boolean":
		switch typed := value.(type) {
		case bool:
			return typed, nil
		case string:
			parsed, err := strconv.ParseBool(strings.TrimSpace(typed))
			if err != nil {
				return nil, err
			}
			return parsed, nil
		default:
			return nil, errors.New("not a boolean")
		}
	case "integer":
		switch typed := value.(type) {
		case int:
			return typed, nil
		case int64:
			return typed, nil
		case float64:
			if typed != float64(int64(typed)) {
				return nil, errors.New("not an integer")
			}
			return int64(typed), nil
		case json.Number:
			parsed, err := typed.Int64()
			if err != nil {
				return nil, err
			}
			return parsed, nil
		case string:
			parsed, err := strconv.ParseInt(strings.TrimSpace(typed), 10, 64)
			if err != nil {
				return nil, err
			}
			return parsed, nil
		default:
			return nil, errors.New("not an integer")
		}
	default:
		return nil, errors.New("unsupported type")
	}
}

func decodeCommandOutput(content []byte) (cliservice.CommandOutput, error) {
	var raw struct {
		Kind    cliservice.OutputMode    `json:"kind"`
		Columns []cliservice.TableColumn `json:"columns"`
		Rows    []map[string]any         `json:"rows"`
		Value   map[string]any           `json:"value"`
		Text    string                   `json:"text"`
	}
	decoder := json.NewDecoder(bytes.NewReader(content))
	decoder.UseNumber()
	if err := decoder.Decode(&raw); err != nil {
		return cliservice.CommandOutput{}, err
	}
	if raw.Kind == "" {
		return cliservice.CommandOutput{}, errors.New("cli command output kind is required")
	}
	return cliservice.CommandOutput{
		Kind:    raw.Kind,
		Columns: raw.Columns,
		Rows:    raw.Rows,
		Value:   raw.Value,
		Text:    raw.Text,
	}, nil
}

func validateCommandOutput(contract cliservice.CapabilityOutput, output cliservice.CommandOutput) (cliservice.CommandOutput, error) {
	switch output.Kind {
	case cliservice.OutputModeJSON:
		if !contract.JSON {
			return cliservice.CommandOutput{}, cliservice.WorkspaceOperationError("app_cli_handler_bad_response", errors.New("json output is not declared"))
		}
	case cliservice.OutputModeTable:
		if contract.Table == nil {
			return cliservice.CommandOutput{}, cliservice.WorkspaceOperationError("app_cli_handler_bad_response", errors.New("table output is not declared"))
		}
		columns, err := normalizeOutputColumns(contract.Table.Columns, output.Columns)
		if err != nil {
			return cliservice.CommandOutput{}, cliservice.WorkspaceOperationError("app_cli_handler_bad_response", err)
		}
		output.Columns = columns
	default:
		return cliservice.CommandOutput{}, cliservice.WorkspaceOperationError("app_cli_handler_bad_response", fmt.Errorf("unsupported output kind %q", output.Kind))
	}
	return output, nil
}

func normalizeOutputColumns(contract []cliservice.TableColumn, actual []cliservice.TableColumn) ([]cliservice.TableColumn, error) {
	if len(actual) == 0 {
		return append([]cliservice.TableColumn(nil), contract...), nil
	}
	contractByKey := map[string]cliservice.TableColumn{}
	for _, column := range contract {
		contractByKey[column.Key] = column
	}
	result := make([]cliservice.TableColumn, 0, len(actual))
	for _, column := range actual {
		expected, ok := contractByKey[column.Key]
		if !ok || expected.Label != column.Label {
			return nil, fmt.Errorf("table output column %q is not declared", column.Key)
		}
		result = append(result, column)
	}
	return result, nil
}
