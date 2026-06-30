package eventstream

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	eventprotocol "github.com/tutti-os/tutti/services/tuttid/api/events/generated"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
)

type WorkspaceAppPublisher struct {
	Service *Service
}

func (p WorkspaceAppPublisher) PublishWorkspaceAppUpdated(ctx context.Context, workspaceID string, app workspacebiz.WorkspaceApp) error {
	if p.Service == nil {
		return nil
	}
	authors := generatedEventAppAuthors(app.Package.Manifest)
	packageLocalizations := app.Package.Localizations()
	localizations := make([]struct {
		Locale      string   `json:"locale"`
		DisplayName *string  `json:"displayName"`
		Description *string  `json:"description"`
		Tags        []string `json:"tags"`
	}, 0, len(packageLocalizations))
	for _, localization := range packageLocalizations {
		localizations = append(localizations, struct {
			Locale      string   `json:"locale"`
			DisplayName *string  `json:"displayName"`
			Description *string  `json:"description"`
			Tags        []string `json:"tags"`
		}{
			Locale:      localization.Locale,
			DisplayName: stringPointer(localization.Name),
			Description: stringPointer(localization.Description),
			Tags:        nonNilStrings(localization.Tags),
		})
	}
	payload, err := json.Marshal(eventprotocol.WorkspaceAppUpdatedPayload{
		App: eventprotocol.WorkspaceWorkspaceApp{
			AppId:            app.Package.AppID,
			DisplayName:      app.Package.DisplayName(),
			Version:          app.Package.Version,
			Description:      app.Package.Description(),
			Authors:          authors,
			Repository:       generatedEventAppRepository(app.Package.Manifest),
			IconUrl:          app.ResolvedIconURL(),
			Installed:        app.Installation != nil,
			Enabled:          app.Installation != nil && app.Installation.Enabled,
			Status:           string(app.Runtime.Status),
			StateRevision:    app.StateRevision,
			LaunchUrl:        app.Runtime.LaunchURL,
			Port:             app.Runtime.Port,
			FailureReason:    app.Runtime.FailureReason,
			LastError:        app.Runtime.LastError,
			StartedAtUnixMs:  app.Runtime.StartedAtUnixMs,
			UpdatedAtUnixMs:  app.Runtime.UpdatedAtUnixMs,
			Source:           string(app.Package.Source),
			Exportable:       app.Package.Source == workspacebiz.AppPackageSourceGenerated || app.Package.Source == workspacebiz.AppPackageSourceImported,
			Tags:             nonNilStrings(app.Package.Manifest.Tags),
			Localizations:    localizations,
			MinimizeBehavior: app.Package.MinimizeBehavior(),
			WindowMinWidth:   app.Package.WindowMinWidth(),
			WindowMinHeight:  app.Package.WindowMinHeight(),
			References: struct {
				ListSupported   bool `json:"listSupported"`
				SearchSupported bool `json:"searchSupported"`
			}{
				ListSupported:   app.Package.ReferenceListSupported(),
				SearchSupported: app.Package.ReferenceSearchSupported(),
			},
			InstallProgress: generatedEventInstallProgress(app.InstallProgress),
		},
	})
	if err != nil {
		return fmt.Errorf("marshal workspace app updated payload: %w", err)
	}
	return p.Service.PublishFromServerScoped(ctx, TopicWorkspaceAppUpdated, payload, EventScope{
		WorkspaceID: workspaceID,
	})
}

func generatedEventAppAuthors(manifest workspacebiz.AppManifest) []struct {
	Name      string  `json:"name"`
	Url       *string `json:"url,omitempty"`
	AvatarUrl *string `json:"avatarUrl,omitempty"`
} {
	manifestAuthors := manifest.Authors
	if len(manifestAuthors) == 0 && manifest.Author != nil {
		manifestAuthors = []workspacebiz.AppManifestAuthor{*manifest.Author}
	}
	authors := make([]struct {
		Name      string  `json:"name"`
		Url       *string `json:"url,omitempty"`
		AvatarUrl *string `json:"avatarUrl,omitempty"`
	}, 0, len(manifestAuthors))
	for _, author := range manifestAuthors {
		name := strings.TrimSpace(author.Name)
		if name == "" {
			continue
		}
		authors = append(authors, struct {
			Name      string  `json:"name"`
			Url       *string `json:"url,omitempty"`
			AvatarUrl *string `json:"avatarUrl,omitempty"`
		}{
			Name:      name,
			Url:       stringPointer(strings.TrimSpace(author.URL)),
			AvatarUrl: stringPointer(strings.TrimSpace(author.AvatarURL)),
		})
	}
	return authors
}

func generatedEventAppRepository(manifest workspacebiz.AppManifest) *struct {
	Type string `json:"type"`
	Url  string `json:"url"`
} {
	if manifest.Source == nil {
		return nil
	}
	repositoryType := strings.TrimSpace(manifest.Source.Type)
	repositoryURL := strings.TrimSpace(manifest.Source.URL)
	if repositoryType != "github" || repositoryURL == "" {
		return nil
	}
	return &struct {
		Type string `json:"type"`
		Url  string `json:"url"`
	}{
		Type: repositoryType,
		Url:  repositoryURL,
	}
}

func stringPointer(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

func nonNilStrings(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}

func generatedEventInstallProgress(progress *workspacebiz.AppInstallProgress) *struct {
	UserPhase       string  `json:"userPhase"`
	OverallPercent  float64 `json:"overallPercent"`
	DownloadedBytes *int64  `json:"downloadedBytes"`
	TotalBytes      *int64  `json:"totalBytes"`
	Indeterminate   bool    `json:"indeterminate"`
} {
	if progress == nil {
		return nil
	}
	return &struct {
		UserPhase       string  `json:"userPhase"`
		OverallPercent  float64 `json:"overallPercent"`
		DownloadedBytes *int64  `json:"downloadedBytes"`
		TotalBytes      *int64  `json:"totalBytes"`
		Indeterminate   bool    `json:"indeterminate"`
	}{
		UserPhase:       string(progress.UserPhase),
		OverallPercent:  progress.OverallPercent,
		DownloadedBytes: progress.DownloadedBytes,
		TotalBytes:      progress.TotalBytes,
		Indeterminate:   progress.Indeterminate,
	}
}
