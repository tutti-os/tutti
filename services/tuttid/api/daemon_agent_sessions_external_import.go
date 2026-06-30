package api

import (
	"context"
	"strings"
	"time"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	"github.com/tutti-os/tutti/services/tuttid/apierrors"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
	userprojectservice "github.com/tutti-os/tutti/services/tuttid/service/userproject"
)

func (api DaemonAPI) ScanWorkspaceExternalAgentSessionImports(ctx context.Context, request tuttigenerated.ScanWorkspaceExternalAgentSessionImportsRequestObject) (tuttigenerated.ScanWorkspaceExternalAgentSessionImportsResponseObject, error) {
	if api.AgentSessionService == nil {
		return tuttigenerated.ScanWorkspaceExternalAgentSessionImports503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentSessionServiceUnavailableError(),
		}, nil
	}
	input := agentservice.ExternalImportScanInput{}
	if request.Body != nil {
		input.Providers = externalImportProvidersFromGenerated(request.Body.Providers)
		if request.Body.Days != nil {
			input.Days = *request.Body.Days
		}
	}
	result, err := api.AgentSessionService.ScanExternalImports(ctx, input)
	if err != nil {
		return writeScanWorkspaceExternalAgentSessionImportsError(err), nil
	}
	return tuttigenerated.ScanWorkspaceExternalAgentSessionImports200JSONResponse(
		generatedExternalImportScanResult(result),
	), nil
}

func (api DaemonAPI) ImportWorkspaceExternalAgentSessions(ctx context.Context, request tuttigenerated.ImportWorkspaceExternalAgentSessionsRequestObject) (tuttigenerated.ImportWorkspaceExternalAgentSessionsResponseObject, error) {
	if api.AgentSessionService == nil {
		return tuttigenerated.ImportWorkspaceExternalAgentSessions503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentSessionServiceUnavailableError(),
		}, nil
	}
	if request.Body == nil || len(request.Body.Projects) == 0 {
		return tuttigenerated.ImportWorkspaceExternalAgentSessions400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(apierrors.EmptyBody(apierrors.WithDeveloperMessage("empty project selection"))),
		}, nil
	}
	projects := externalImportProjectSelectionsFromGenerated(request.Body.Projects)
	register := request.Body.RegisterUserProjects == nil || *request.Body.RegisterUserProjects
	importSessions := request.Body.ImportSessions == nil || *request.Body.ImportSessions

	// Import sessions first, then register only the projects that actually
	// matched at least one valid session so empty projects never get surfaced.
	// validPaths are canonical project paths (see the agent service), so register
	// them directly instead of mapping back to the raw request selections.
	var result agentservice.ExternalImportResult
	var validPaths []string
	if importSessions {
		var err error
		result, err = api.AgentSessionService.ImportExternalSessions(ctx, string(request.WorkspaceID), agentservice.ExternalImportInput{
			Projects: projects,
		})
		if err != nil {
			return writeImportWorkspaceExternalAgentSessionsError(err), nil
		}
		validPaths = result.ProjectPaths
	} else {
		var err error
		validPaths, err = api.AgentSessionService.ExternalImportValidProjectPaths(ctx, agentservice.ExternalImportInput{
			Projects: projects,
		})
		if err != nil {
			return writeImportWorkspaceExternalAgentSessionsError(err), nil
		}
	}

	registeredSelections, registrationErrors := api.registerExternalImportUserProjects(ctx, externalImportSelectionsFromPaths(validPaths), register)
	result.ImportedProjects = len(registeredSelections)
	result.Errors = append(registrationErrors, result.Errors...)
	return tuttigenerated.ImportWorkspaceExternalAgentSessions200JSONResponse(
		generatedExternalImportResult(result),
	), nil
}

func externalImportSelectionsFromPaths(paths []string) []agentservice.ExternalImportProjectSelection {
	selections := make([]agentservice.ExternalImportProjectSelection, 0, len(paths))
	for _, path := range paths {
		if trimmed := strings.TrimSpace(path); trimmed != "" {
			selections = append(selections, agentservice.ExternalImportProjectSelection{Path: trimmed})
		}
	}
	return selections
}

func externalImportProvidersFromGenerated(input *[]tuttigenerated.WorkspaceAgentProvider) []string {
	if input == nil {
		return nil
	}
	result := make([]string, 0, len(*input))
	for _, provider := range *input {
		result = append(result, string(provider))
	}
	return result
}

func externalImportProjectSelectionsFromGenerated(input []tuttigenerated.ExternalAgentImportProjectSelection) []agentservice.ExternalImportProjectSelection {
	result := make([]agentservice.ExternalImportProjectSelection, 0, len(input))
	for _, project := range input {
		result = append(result, agentservice.ExternalImportProjectSelection{
			Path:       project.Path,
			Providers:  externalImportProvidersFromGenerated(project.Providers),
			SessionIDs: optionalStringSlice(project.SessionIds),
		})
	}
	return result
}

func optionalStringSlice(input *[]string) []string {
	if input == nil {
		return nil
	}
	return append([]string(nil), (*input)...)
}

func (api DaemonAPI) registerExternalImportUserProjects(
	ctx context.Context,
	projects []agentservice.ExternalImportProjectSelection,
	register bool,
) ([]agentservice.ExternalImportProjectSelection, []agentservice.ExternalImportError) {
	if !register || api.UserProjectService == nil {
		return projects, nil
	}
	result := make([]agentservice.ExternalImportProjectSelection, 0, len(projects))
	failures := make([]agentservice.ExternalImportError, 0)
	lastUsedAtUnixMS := time.Now().UTC().UnixMilli() + int64(len(projects))
	for index, project := range projects {
		path := strings.TrimSpace(project.Path)
		if path == "" {
			failures = append(failures, agentservice.ExternalImportError{Message: "project path is empty"})
			continue
		}
		if _, err := api.UserProjectService.Use(ctx, userprojectservice.UseInput{
			Path:             path,
			LastUsedAtUnixMS: lastUsedAtUnixMS - int64(index),
		}); err != nil {
			failures = append(failures, agentservice.ExternalImportError{
				SourcePath: path,
				Message:    err.Error(),
			})
			continue
		}
		result = append(result, project)
	}
	return result, failures
}

func generatedExternalImportScanResult(result agentservice.ExternalImportScanResult) tuttigenerated.ExternalAgentImportScanResponse {
	return tuttigenerated.ExternalAgentImportScanResponse{
		Errors:          generatedExternalImportErrors(result.Errors),
		Projects:        generatedExternalImportProjects(result.Projects),
		Providers:       generatedExternalImportProviders(result.Providers),
		Sessions:        generatedExternalImportSessions(result.Sessions),
		ScannedMessages: result.ScannedMessages,
		ScannedSessions: result.ScannedSessions,
		SkippedSessions: result.SkippedSessions,
	}
}

func generatedExternalImportResult(result agentservice.ExternalImportResult) tuttigenerated.ExternalAgentImportResultResponse {
	return tuttigenerated.ExternalAgentImportResultResponse{
		Errors:           generatedExternalImportErrors(result.Errors),
		ImportedMessages: result.ImportedMessages,
		ImportedProjects: result.ImportedProjects,
		ImportedSessions: result.ImportedSessions,
		SkippedSessions:  result.SkippedSessions,
	}
}

func generatedExternalImportProviders(providers []agentservice.ExternalImportProvider) []tuttigenerated.ExternalAgentImportProvider {
	result := make([]tuttigenerated.ExternalAgentImportProvider, 0, len(providers))
	for _, provider := range providers {
		generated := tuttigenerated.ExternalAgentImportProvider{
			Available:    provider.Available,
			MessageCount: provider.MessageCount,
			Provider:     tuttigenerated.WorkspaceAgentProvider(provider.Provider),
			Root:         provider.Root,
			SessionCount: provider.SessionCount,
		}
		if errMessage := strings.TrimSpace(provider.Error); errMessage != "" {
			generated.Error = optionalStringPointer(errMessage)
		}
		result = append(result, generated)
	}
	return result
}

func generatedExternalImportProjects(projects []agentservice.ExternalImportProject) []tuttigenerated.ExternalAgentImportProject {
	result := make([]tuttigenerated.ExternalAgentImportProject, 0, len(projects))
	for _, project := range projects {
		generated := tuttigenerated.ExternalAgentImportProject{
			Label:        strings.TrimSpace(project.Label),
			MessageCount: project.MessageCount,
			Path:         strings.TrimSpace(project.Path),
			Providers:    generatedExternalImportProviderNames(project.Providers),
			SessionCount: project.SessionCount,
		}
		if project.LastUpdatedAtUnixMS > 0 {
			generated.LastUpdatedAtUnixMs = &project.LastUpdatedAtUnixMS
		}
		result = append(result, generated)
	}
	return result
}

func generatedExternalImportSessions(sessions []agentservice.ExternalImportSession) []tuttigenerated.ExternalAgentImportSession {
	result := make([]tuttigenerated.ExternalAgentImportSession, 0, len(sessions))
	for _, session := range sessions {
		generated := tuttigenerated.ExternalAgentImportSession{
			Id:           strings.TrimSpace(session.ID),
			MessageCount: session.MessageCount,
			ProjectPath:  strings.TrimSpace(session.ProjectPath),
			Provider:     tuttigenerated.WorkspaceAgentProvider(session.Provider),
			SourcePath:   strings.TrimSpace(session.SourcePath),
			Title:        strings.TrimSpace(session.Title),
		}
		if session.LastUpdatedAtUnixMS > 0 {
			generated.LastUpdatedAtUnixMs = &session.LastUpdatedAtUnixMS
		}
		result = append(result, generated)
	}
	return result
}

func generatedExternalImportProviderNames(providers []string) []tuttigenerated.WorkspaceAgentProvider {
	result := make([]tuttigenerated.WorkspaceAgentProvider, 0, len(providers))
	for _, provider := range providers {
		if strings.TrimSpace(provider) != "" {
			result = append(result, tuttigenerated.WorkspaceAgentProvider(provider))
		}
	}
	return result
}

func generatedExternalImportErrors(errors []agentservice.ExternalImportError) []tuttigenerated.ExternalAgentImportError {
	result := make([]tuttigenerated.ExternalAgentImportError, 0, len(errors))
	for _, item := range errors {
		generated := tuttigenerated.ExternalAgentImportError{
			Message: strings.TrimSpace(item.Message),
		}
		if generated.Message == "" {
			generated.Message = "external import failed"
		}
		if provider := strings.TrimSpace(item.Provider); provider != "" {
			value := tuttigenerated.WorkspaceAgentProvider(provider)
			generated.Provider = &value
		}
		if sourcePath := strings.TrimSpace(item.SourcePath); sourcePath != "" {
			generated.SourcePath = &sourcePath
		}
		result = append(result, generated)
	}
	return result
}
