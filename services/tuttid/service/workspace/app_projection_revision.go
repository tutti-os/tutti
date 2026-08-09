package workspace

import workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"

func (s *AppCenterService) ensureRevisionStateLocked() {
	if s.stateRevisions == nil {
		s.stateRevisions = make(map[string]int64)
	}
	if s.appProjectionKeys == nil {
		s.appProjectionKeys = make(map[string]workspaceAppProjectionKey)
	}
}

type workspaceAppProjectionKey struct {
	appID                string
	description          string
	displayName          string
	enabled              bool
	failureReason        string
	failurePhase         string
	hasFailurePhase      bool
	hasFailureReason     bool
	hasIconURL           bool
	hasLastError         bool
	hasLaunchURL         bool
	hasPort              bool
	iconURL              string
	hasStartedAt         bool
	hasUpdatedAt         bool
	installed            bool
	lastError            string
	launchURL            string
	manifestJSON         string
	port                 int
	startedAtUnixMs      int64
	status               workspacebiz.AppRuntimeStatus
	updateAvailable      bool
	availableIconURL     string
	availableVersion     string
	cliActive            bool
	cliIssueCount        int
	cliIssueCode         string
	cliIssueMessage      string
	cliIssuePath         string
	cliScope             string
	cliStatus            workspacebiz.AppCLIStatus
	updatedAtUnixMs      int64
	version              string
	installPhase         string
	installPercent       float64
	hasInstallProgress   bool
	installIndeterminate bool
	installDownloaded    int64
	installTotal         int64
	hasInstallDownloaded bool
	hasInstallTotal      bool
}

func projectionKeyFromWorkspaceApp(app workspacebiz.WorkspaceApp) workspaceAppProjectionKey {
	key := workspaceAppProjectionKey{
		appID:            app.Package.AppID,
		description:      app.Package.Description(),
		displayName:      app.Package.DisplayName(),
		installed:        app.Installation != nil,
		enabled:          app.Installation != nil && app.Installation.Enabled,
		manifestJSON:     app.Package.ManifestJSON,
		status:           app.Runtime.Status,
		updateAvailable:  app.UpdateAvailable,
		availableIconURL: stringPtrValue(app.AvailableIconURL),
		availableVersion: stringPtrValue(app.AvailableVersion),
		cliActive:        app.CLI.Active,
		cliIssueCount:    len(app.CLI.Issues),
		cliScope:         app.CLI.Scope,
		cliStatus:        app.CLI.Status,
		version:          app.Package.Version,
	}
	if len(app.CLI.Issues) > 0 {
		key.cliIssueCode = app.CLI.Issues[0].Code
		key.cliIssueMessage = app.CLI.Issues[0].Message
		key.cliIssuePath = app.CLI.Issues[0].Path
	}
	if iconURL := app.ResolvedIconURL(); iconURL != nil {
		key.hasIconURL = true
		key.iconURL = *iconURL
	}
	if app.Runtime.LaunchURL != nil {
		key.hasLaunchURL = true
		key.launchURL = *app.Runtime.LaunchURL
	}
	if app.Runtime.Port != nil {
		key.hasPort = true
		key.port = *app.Runtime.Port
	}
	if app.Runtime.FailureReason != nil {
		key.hasFailureReason = true
		key.failureReason = *app.Runtime.FailureReason
	}
	if app.Runtime.FailurePhase != nil {
		key.hasFailurePhase = true
		key.failurePhase = string(*app.Runtime.FailurePhase)
	}
	if app.Runtime.LastError != nil {
		key.hasLastError = true
		key.lastError = *app.Runtime.LastError
	}
	if app.Runtime.StartedAtUnixMs != nil {
		key.hasStartedAt = true
		key.startedAtUnixMs = *app.Runtime.StartedAtUnixMs
	}
	if app.Runtime.UpdatedAtUnixMs != nil {
		key.hasUpdatedAt = true
		key.updatedAtUnixMs = *app.Runtime.UpdatedAtUnixMs
	}
	if app.InstallProgress != nil {
		key.hasInstallProgress = true
		key.installPhase = string(app.InstallProgress.UserPhase)
		key.installPercent = app.InstallProgress.OverallPercent
		key.installIndeterminate = app.InstallProgress.Indeterminate
		if app.InstallProgress.DownloadedBytes != nil {
			key.hasInstallDownloaded = true
			key.installDownloaded = *app.InstallProgress.DownloadedBytes
		}
		if app.InstallProgress.TotalBytes != nil {
			key.hasInstallTotal = true
			key.installTotal = *app.InstallProgress.TotalBytes
		}
	}
	return key
}

func stringPtrValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}
