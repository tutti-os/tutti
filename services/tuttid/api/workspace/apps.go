package workspace

import (
	"strings"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
)

func GeneratedAppFromBiz(app workspacebiz.WorkspaceApp) tuttigenerated.WorkspaceApp {
	return tuttigenerated.WorkspaceApp{
		AppId:            app.Package.AppID,
		DisplayName:      app.Package.DisplayName(),
		Version:          app.Package.Version,
		Description:      app.Package.Description(),
		Authors:          generatedAppAuthorsFromBiz(app.Package.Manifest),
		Repository:       generatedAppRepositoryFromBiz(app.Package.Manifest),
		CreatedAtUnixMs:  app.Package.CreatedAtUnixMs,
		IconUrl:          app.ResolvedIconURL(),
		AvailableVersion: app.AvailableVersion,
		AvailableIconUrl: app.AvailableIconURL,
		UpdateAvailable:  app.UpdateAvailable,
		Installed:        app.Installation != nil,
		Enabled:          app.Installation != nil && app.Installation.Enabled,
		Status:           generatedAppRuntimeStatus(app.Runtime.Status),
		StateRevision:    app.StateRevision,
		LaunchUrl:        app.Runtime.LaunchURL,
		Port:             app.Runtime.Port,
		FailureReason:    app.Runtime.FailureReason,
		LastError:        app.Runtime.LastError,
		StartedAtUnixMs:  app.Runtime.StartedAtUnixMs,
		UpdatedAtUnixMs:  app.Runtime.UpdatedAtUnixMs,
		Source:           generatedAppSource(app.Package.Source),
		Exportable:       app.Package.Source == workspacebiz.AppPackageSourceGenerated || app.Package.Source == workspacebiz.AppPackageSourceImported,
		LocalPackageDir:  generatedAppLocalPackageDir(app.Package),
		Tags:             nonNilStrings(app.Package.Manifest.Tags),
		Localizations:    GeneratedAppLocalizationsFromBiz(app.Package.Localizations()),
		MinimizeBehavior: tuttigenerated.WorkspaceAppMinimizeBehavior(app.Package.MinimizeBehavior()),
		WindowMinWidth:   app.Package.WindowMinWidth(),
		WindowMinHeight:  app.Package.WindowMinHeight(),
		Cli:              generatedAppCLIState(app.CLI),
		References:       generatedAppReferencesStateFromBiz(app),
		InstallProgress:  generatedAppInstallProgressFromBiz(app.InstallProgress),
	}
}

func generatedAppAuthorsFromBiz(manifest workspacebiz.AppManifest) []tuttigenerated.WorkspaceAppAuthor {
	authors := manifest.Authors
	if len(authors) == 0 && manifest.Author != nil {
		authors = []workspacebiz.AppManifestAuthor{*manifest.Author}
	}
	result := make([]tuttigenerated.WorkspaceAppAuthor, 0, len(authors))
	for _, author := range authors {
		name := trimString(author.Name)
		if name == "" {
			continue
		}
		result = append(result, tuttigenerated.WorkspaceAppAuthor{
			Name:      name,
			AvatarUrl: nullableString(trimString(author.AvatarURL)),
			Url:       nullableString(trimString(author.URL)),
		})
	}
	return result
}

func generatedAppRepositoryFromBiz(manifest workspacebiz.AppManifest) *tuttigenerated.WorkspaceAppRepository {
	if manifest.Source == nil {
		return nil
	}
	repositoryType := trimString(manifest.Source.Type)
	repositoryURL := trimString(manifest.Source.URL)
	if repositoryType != "github" || repositoryURL == "" {
		return nil
	}
	return &tuttigenerated.WorkspaceAppRepository{
		Type: tuttigenerated.Github,
		Url:  repositoryURL,
	}
}

func generatedAppInstallProgressFromBiz(progress *workspacebiz.AppInstallProgress) *tuttigenerated.WorkspaceAppInstallProgress {
	if progress == nil {
		return nil
	}
	return &tuttigenerated.WorkspaceAppInstallProgress{
		UserPhase:       generatedAppInstallUserPhase(progress.UserPhase),
		OverallPercent:  float32(progress.OverallPercent),
		DownloadedBytes: progress.DownloadedBytes,
		TotalBytes:      progress.TotalBytes,
		Indeterminate:   progress.Indeterminate,
	}
}

func generatedAppInstallUserPhase(phase workspacebiz.AppInstallUserPhase) tuttigenerated.WorkspaceAppInstallUserPhase {
	switch phase {
	case workspacebiz.AppInstallUserPhaseInstalling:
		return tuttigenerated.WorkspaceAppInstallUserPhaseInstalling
	case workspacebiz.AppInstallUserPhaseStarting:
		return tuttigenerated.WorkspaceAppInstallUserPhaseStarting
	default:
		return tuttigenerated.WorkspaceAppInstallUserPhaseDownloading
	}
}

func GeneratedAppsFromBiz(apps []workspacebiz.WorkspaceApp) []tuttigenerated.WorkspaceApp {
	result := make([]tuttigenerated.WorkspaceApp, 0, len(apps))
	for _, app := range apps {
		result = append(result, GeneratedAppFromBiz(app))
	}
	return result
}

func GeneratedAppReferenceListResultFromBiz(workspaceID string, appID string, result workspacebiz.AppReferenceListResult) tuttigenerated.AppReferenceListResponse {
	return tuttigenerated.AppReferenceListResponse{
		WorkspaceId: workspaceID,
		AppId:       appID,
		Items:       generatedAppReferenceListItemsFromBiz(result.Items),
		NextCursor:  result.NextCursor,
	}
}

func GeneratedAppReferenceSearchResultFromBiz(workspaceID string, appID string, result workspacebiz.AppReferenceListResult) tuttigenerated.AppReferenceSearchResponse {
	return tuttigenerated.AppReferenceSearchResponse{
		WorkspaceId: workspaceID,
		AppId:       appID,
		Items:       generatedAppReferenceSearchItemsFromBiz(result.Items),
		NextCursor:  result.NextCursor,
	}
}

func generatedAppReferenceSearchItemsFromBiz(items []workspacebiz.AppReferenceListItem) []tuttigenerated.AppReferenceListReferenceItem {
	result := make([]tuttigenerated.AppReferenceListReferenceItem, 0, len(items))
	for _, item := range items {
		referenceItem, ok := item.(workspacebiz.AppReferenceListReferenceItem)
		if !ok {
			continue
		}
		reference, ok := generatedAppReferenceFromBiz(referenceItem.Reference)
		if !ok {
			continue
		}
		result = append(result, tuttigenerated.AppReferenceListReferenceItem{
			Type:      tuttigenerated.AppReferenceListReferenceItemTypeReference,
			Reference: reference,
		})
	}
	return result
}

func GeneratedAppLocalizationsFromBiz(localizations []workspacebiz.AppManifestLocalization) []tuttigenerated.WorkspaceAppLocalization {
	result := make([]tuttigenerated.WorkspaceAppLocalization, 0, len(localizations))
	for _, localization := range localizations {
		result = append(result, tuttigenerated.WorkspaceAppLocalization{
			Locale:      localization.Locale,
			DisplayName: nullableString(localization.Name),
			Description: nullableString(localization.Description),
			Tags:        nonNilStrings(localization.Tags),
		})
	}
	return result
}

func GeneratedAppCatalogLoadStateFromBiz(state workspacebiz.AppCatalogLoadState) tuttigenerated.WorkspaceAppCatalogLoadState {
	return tuttigenerated.WorkspaceAppCatalogLoadState{
		Status:          generatedAppCatalogLoadStatus(state.Status),
		LastError:       state.LastError,
		UpdatedAtUnixMs: state.UpdatedAtUnixMs,
	}
}

func generatedAppReferencesStateFromBiz(app workspacebiz.WorkspaceApp) tuttigenerated.WorkspaceAppReferencesState {
	return tuttigenerated.WorkspaceAppReferencesState{
		ListSupported:   app.Package.ReferenceListSupported(),
		SearchSupported: app.Package.ReferenceSearchSupported(),
	}
}

func generatedAppReferenceListItemsFromBiz(items []workspacebiz.AppReferenceListItem) []tuttigenerated.AppReferenceListItem {
	result := make([]tuttigenerated.AppReferenceListItem, 0, len(items))
	for _, item := range items {
		generated, ok := generatedAppReferenceListItemFromBiz(item)
		if ok {
			result = append(result, generated)
		}
	}
	return result
}

func generatedAppReferenceListItemFromBiz(item workspacebiz.AppReferenceListItem) (tuttigenerated.AppReferenceListItem, bool) {
	switch typed := item.(type) {
	case workspacebiz.AppReferenceGroup:
		var generated tuttigenerated.AppReferenceListItem
		if err := generated.FromAppReferenceGroup(tuttigenerated.AppReferenceGroup{
			Type:           tuttigenerated.AppReferenceGroupTypeGroup,
			Id:             typed.ID,
			DisplayName:    typed.DisplayName,
			Description:    nullableString(typed.Description),
			ReferenceCount: typed.ReferenceCount,
		}); err != nil {
			return tuttigenerated.AppReferenceListItem{}, false
		}
		return generated, true
	case workspacebiz.AppReferenceListReferenceItem:
		reference, ok := generatedAppReferenceFromBiz(typed.Reference)
		if !ok {
			return tuttigenerated.AppReferenceListItem{}, false
		}
		var generated tuttigenerated.AppReferenceListItem
		if err := generated.FromAppReferenceListReferenceItem(tuttigenerated.AppReferenceListReferenceItem{
			Type:      tuttigenerated.AppReferenceListReferenceItemTypeReference,
			Reference: reference,
		}); err != nil {
			return tuttigenerated.AppReferenceListItem{}, false
		}
		return generated, true
	default:
		return tuttigenerated.AppReferenceListItem{}, false
	}
}

func generatedAppReferenceFromBiz(reference workspacebiz.AppReference) (tuttigenerated.AppReference, bool) {
	switch typed := reference.(type) {
	case workspacebiz.AppFileReference:
		var generated tuttigenerated.AppReference
		if err := generated.FromAppFileReference(generatedAppFileReferenceFromBiz(typed)); err != nil {
			return tuttigenerated.AppReference{}, false
		}
		return generated, true
	default:
		return tuttigenerated.AppReference{}, false
	}
}

func generatedAppFileReferenceFromBiz(reference workspacebiz.AppFileReference) tuttigenerated.AppFileReference {
	return tuttigenerated.AppFileReference{
		Kind:             tuttigenerated.AppFileReferenceKindFile,
		DisplayName:      nullableString(reference.DisplayName),
		Description:      nullableString(reference.Description),
		Path:             reference.Path,
		SizeBytes:        reference.SizeBytes,
		MtimeMs:          reference.MtimeMs,
		MimeType:         nullableString(reference.MimeType),
		Score:            nullableFloat32(reference.Score),
		ParentGroupLabel: nullableString(reference.ParentGroupLabel),
	}
}

func nullableString(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

func trimString(value string) string {
	return strings.TrimSpace(value)
}

func nullableFloat32(value *float64) *float32 {
	if value == nil {
		return nil
	}
	converted := float32(*value)
	return &converted
}

func nonNilStrings(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}

func generatedAppSource(source workspacebiz.AppPackageSource) tuttigenerated.WorkspaceAppSource {
	switch source {
	case workspacebiz.AppPackageSourceGenerated:
		return tuttigenerated.WorkspaceAppSourceGenerated
	case workspacebiz.AppPackageSourceImported:
		return tuttigenerated.WorkspaceAppSourceImported
	case workspacebiz.AppPackageSourceLocalDev:
		return tuttigenerated.WorkspaceAppSourceLocalDev
	default:
		return tuttigenerated.WorkspaceAppSourceBuiltin
	}
}

func generatedAppLocalPackageDir(appPackage workspacebiz.AppPackage) *string {
	if appPackage.Source != workspacebiz.AppPackageSourceLocalDev {
		return nil
	}
	return nullableString(appPackage.PackageDir)
}

func generatedAppCatalogLoadStatus(status workspacebiz.AppCatalogLoadStatus) tuttigenerated.WorkspaceAppCatalogLoadStatus {
	switch status {
	case workspacebiz.AppCatalogLoadStatusLoading:
		return tuttigenerated.WorkspaceAppCatalogLoadStatusLoading
	case workspacebiz.AppCatalogLoadStatusReady:
		return tuttigenerated.WorkspaceAppCatalogLoadStatusReady
	case workspacebiz.AppCatalogLoadStatusFailed:
		return tuttigenerated.WorkspaceAppCatalogLoadStatusFailed
	default:
		return tuttigenerated.WorkspaceAppCatalogLoadStatusDisabled
	}
}

func generatedAppRuntimeStatus(status workspacebiz.AppRuntimeStatus) tuttigenerated.WorkspaceAppRuntimeStatus {
	switch status {
	case workspacebiz.AppRuntimeStatusRunning:
		return tuttigenerated.WorkspaceAppRuntimeStatusRunning
	case workspacebiz.AppRuntimeStatusInstalledPendingRestart:
		return tuttigenerated.WorkspaceAppRuntimeStatusInstalledPendingRestart
	case workspacebiz.AppRuntimeStatusPreparing:
		return tuttigenerated.WorkspaceAppRuntimeStatusPreparing
	case workspacebiz.AppRuntimeStatusStarting:
		return tuttigenerated.WorkspaceAppRuntimeStatusStarting
	case workspacebiz.AppRuntimeStatusFailed:
		return tuttigenerated.WorkspaceAppRuntimeStatusFailed
	case workspacebiz.AppRuntimeStatusStopping:
		return tuttigenerated.WorkspaceAppRuntimeStatusStopping
	default:
		return tuttigenerated.WorkspaceAppRuntimeStatusIdle
	}
}

func generatedAppCLIState(state workspacebiz.AppCLIState) tuttigenerated.WorkspaceAppCliState {
	return tuttigenerated.WorkspaceAppCliState{
		Status: generatedAppCLIStatus(state.Status),
		Scope:  nullableString(state.Scope),
		Active: state.Active,
		Issues: generatedAppCLIIssues(state.Issues),
	}
}

func generatedAppCLIIssues(issues []workspacebiz.AppCLIIssue) []tuttigenerated.WorkspaceAppCliIssue {
	result := make([]tuttigenerated.WorkspaceAppCliIssue, 0, len(issues))
	for _, issue := range issues {
		result = append(result, tuttigenerated.WorkspaceAppCliIssue{
			Code:    issue.Code,
			Message: issue.Message,
			Path:    nullableString(issue.Path),
		})
	}
	return result
}

func generatedAppCLIStatus(status workspacebiz.AppCLIStatus) tuttigenerated.WorkspaceAppCliStatus {
	switch status {
	case workspacebiz.AppCLIStatusPending:
		return tuttigenerated.WorkspaceAppCliStatusPending
	case workspacebiz.AppCLIStatusActive:
		return tuttigenerated.WorkspaceAppCliStatusActive
	case workspacebiz.AppCLIStatusWarning:
		return tuttigenerated.WorkspaceAppCliStatusWarning
	case workspacebiz.AppCLIStatusError:
		return tuttigenerated.WorkspaceAppCliStatusError
	default:
		return tuttigenerated.WorkspaceAppCliStatusNone
	}
}
