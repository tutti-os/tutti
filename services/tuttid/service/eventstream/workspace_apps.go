package eventstream

import (
	"context"
	"encoding/json"
	"fmt"

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
				ListSupported bool `json:"listSupported"`
			}{
				ListSupported: app.Package.ReferenceListSupported(),
			},
		},
	})
	if err != nil {
		return fmt.Errorf("marshal workspace app updated payload: %w", err)
	}
	return p.Service.PublishFromServerScoped(ctx, TopicWorkspaceAppUpdated, payload, EventScope{
		WorkspaceID: workspaceID,
	})
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
