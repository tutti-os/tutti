package workspace

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"

	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
)

func (s *AppFactoryService) Publish(ctx context.Context, workspaceID string, jobID string) (workspacebiz.AppFactoryJob, workspacebiz.WorkspaceApp, error) {
	startedAt := time.Now()
	unlock := s.publishLocks.Lock(appFactoryActionKey("publish", workspaceID, jobID))
	defer unlock()

	job, err := s.Get(ctx, workspaceID, jobID)
	if err != nil {
		return workspacebiz.AppFactoryJob{}, workspacebiz.WorkspaceApp{}, err
	}
	if isPublishedAppFactoryJob(job) {
		return s.addPublishedFactoryApp(ctx, workspaceID, job)
	}
	if job.Status != workspacebiz.AppFactoryJobStatusReady {
		err := errors.New("app factory job is not ready to publish")
		logAppFactoryPublishFailed(workspaceID, job, workspacebiz.AppManifest{}, "state_check", false, startedAt, err)
		return workspacebiz.AppFactoryJob{}, workspacebiz.WorkspaceApp{}, err
	}
	if _, err := readCleanAppFactoryAgentsFile(job); err != nil {
		logAppFactoryPublishFailed(workspaceID, job, workspacebiz.AppManifest{}, "agents_check", false, startedAt, err)
		result := workspacebiz.AppFactoryValidationResult{
			CheckedAt: unixMsNow(),
			Errors:    []string{err.Error()},
		}
		if _, markErr := s.failValidation(ctx, job, result); markErr != nil {
			slog.Warn(
				"app factory publish validation failure state update failed",
				"workspaceId", workspaceID,
				"jobId", job.JobID,
				"error", markErr,
			)
			return workspacebiz.AppFactoryJob{}, workspacebiz.WorkspaceApp{}, errors.Join(err, markErr)
		}
		return workspacebiz.AppFactoryJob{}, workspacebiz.WorkspaceApp{}, err
	}

	draftPackageDir := appFactoryDraftPackageDir(job)
	manifest, manifestJSON, err := workspacebiz.ReadAppManifestFile(filepath.Join(draftPackageDir, "tutti.app.json"))
	if err != nil {
		logAppFactoryPublishFailed(workspaceID, job, workspacebiz.AppManifest{}, "manifest_read", false, startedAt, err)
		return workspacebiz.AppFactoryJob{}, workspacebiz.WorkspaceApp{}, err
	}
	wasPreviouslyPublished := strings.TrimSpace(job.PublishedVersion) != ""
	if wasPreviouslyPublished {
		manifest, manifestJSON, err = s.bumpRepublishedManifestVersion(ctx, job, manifest)
		if err != nil {
			logAppFactoryPublishFailed(workspaceID, job, manifest, "version_bump", wasPreviouslyPublished, startedAt, err)
			return workspacebiz.AppFactoryJob{}, workspacebiz.WorkspaceApp{}, err
		}
	}
	if existingPackage, err := s.appStore().GetAppPackageVersion(ctx, manifest.AppID, manifest.Version); err == nil {
		if isAppFactoryPackageForJob(existingPackage, job, workspaceID) {
			return s.completeFactoryPublish(ctx, workspaceID, job, existingPackage, false)
		}
		slog.Warn(
			"app factory publish package version conflict",
			"reason", "workspace_app_package_exists",
			"workspaceId", workspaceID,
			"jobId", job.JobID,
			"jobStatus", job.Status,
			"jobAppId", job.AppID,
			"jobPublishedVersion", job.PublishedVersion,
			"manifestAppId", manifest.AppID,
			"manifestVersion", manifest.Version,
			"existingSource", existingPackage.Source,
			"existingFactoryJobId", existingPackage.FactoryJobID,
			"existingCreatedInWorkspaceId", existingPackage.CreatedInWorkspaceID,
			"existingPackageDir", existingPackage.PackageDir,
		)
		err := fmt.Errorf("%w: app %q version %q", ErrAppPackageAlreadyExists, manifest.AppID, manifest.Version)
		logAppFactoryPublishFailed(workspaceID, job, manifest, "package_conflict", wasPreviouslyPublished, startedAt, err)
		return workspacebiz.AppFactoryJob{}, workspacebiz.WorkspaceApp{}, err
	} else if !errors.Is(err, workspacedata.ErrWorkspaceAppNotFound) {
		logAppFactoryPublishFailed(workspaceID, job, manifest, "package_lookup", wasPreviouslyPublished, startedAt, err)
		return workspacebiz.AppFactoryJob{}, workspacebiz.WorkspaceApp{}, err
	}
	packageDir := filepath.Join(s.stateDir(), "apps", "packages", safeAppPathSegment(manifest.AppID), safeAppPathSegment(manifest.Version))
	if err := os.RemoveAll(packageDir); err != nil {
		err := fmt.Errorf("replace app package dir: %w", err)
		logAppFactoryPublishFailed(workspaceID, job, manifest, "package_replace", wasPreviouslyPublished, startedAt, err)
		return workspacebiz.AppFactoryJob{}, workspacebiz.WorkspaceApp{}, err
	}
	if err := copyDirectory(draftPackageDir, packageDir); err != nil {
		err := fmt.Errorf("copy app factory package: %w", err)
		logAppFactoryPublishFailed(workspaceID, job, manifest, "package_copied", wasPreviouslyPublished, startedAt, err)
		return workspacebiz.AppFactoryJob{}, workspacebiz.WorkspaceApp{}, err
	}
	appPackage := workspacebiz.AppPackage{
		AppID:                manifest.AppID,
		Version:              manifest.Version,
		PackageDir:           packageDir,
		Manifest:             manifest,
		ManifestJSON:         manifestJSON,
		Source:               workspacebiz.AppPackageSourceGenerated,
		FactoryJobID:         job.JobID,
		CreatedInWorkspaceID: workspaceID,
	}
	if err := s.appStore().PutAppPackage(ctx, appPackage); err != nil {
		logAppFactoryPublishFailed(workspaceID, job, manifest, "package_store", wasPreviouslyPublished, startedAt, err)
		return workspacebiz.AppFactoryJob{}, workspacebiz.WorkspaceApp{}, err
	}

	return s.completeFactoryPublish(ctx, workspaceID, job, appPackage, wasPreviouslyPublished)
}

func (s *AppFactoryService) completeFactoryPublish(ctx context.Context, workspaceID string, job workspacebiz.AppFactoryJob, appPackage workspacebiz.AppPackage, wasPreviouslyPublished bool) (workspacebiz.AppFactoryJob, workspacebiz.WorkspaceApp, error) {
	job.AppID = appPackage.AppID
	job.Status = workspacebiz.AppFactoryJobStatusPublished
	job.PackageDir = appPackage.PackageDir
	job.PublishedVersion = appPackage.Version
	job.FailureReason = ""
	if err := s.putAndPublish(ctx, job); err != nil {
		logAppFactoryPublishFailed(workspaceID, job, appPackage.Manifest, "job_marked_published", wasPreviouslyPublished, time.Time{}, err)
		return workspacebiz.AppFactoryJob{}, workspacebiz.WorkspaceApp{}, err
	}

	if wasPreviouslyPublished {
		_, _ = s.appCenter().runner().Stop(ctx, workspaceID, appPackage.AppID)
	}
	app, err := s.appCenter().Add(ctx, workspaceID, appPackage.AppID)
	if err != nil {
		logAppFactoryPublishFailed(workspaceID, job, appPackage.Manifest, "workspace_add_failed", wasPreviouslyPublished, time.Time{}, err)
		return job, workspacebiz.WorkspaceApp{}, err
	}
	return job, app, nil
}

func (s *AppFactoryService) addPublishedFactoryApp(ctx context.Context, workspaceID string, job workspacebiz.AppFactoryJob) (workspacebiz.AppFactoryJob, workspacebiz.WorkspaceApp, error) {
	appID := strings.TrimSpace(job.AppID)
	if appID == "" {
		err := errors.New("published app factory job is missing app id")
		logAppFactoryPublishFailed(workspaceID, job, workspacebiz.AppManifest{}, "workspace_add_failed", true, time.Time{}, err)
		return workspacebiz.AppFactoryJob{}, workspacebiz.WorkspaceApp{}, err
	}
	app, err := s.appCenter().Add(ctx, workspaceID, appID)
	if err != nil {
		logAppFactoryPublishFailed(workspaceID, job, workspacebiz.AppManifest{AppID: appID}, "workspace_add_failed", true, time.Time{}, err)
		return job, workspacebiz.WorkspaceApp{}, err
	}
	return job, app, nil
}

func logAppFactoryPublishFailed(workspaceID string, job workspacebiz.AppFactoryJob, manifest workspacebiz.AppManifest, phase string, wasPreviouslyPublished bool, startedAt time.Time, err error) {
	fields := appFactoryPublishLogFields(workspaceID, job, manifest, workspacebiz.AppPackage{}, phase, wasPreviouslyPublished, startedAt)
	fields = append(fields, "error", err)
	slog.Warn("app factory publish failed", fields...)
}

func appFactoryPublishLogFields(workspaceID string, job workspacebiz.AppFactoryJob, manifest workspacebiz.AppManifest, appPackage workspacebiz.AppPackage, phase string, wasPreviouslyPublished bool, startedAt time.Time) []any {
	fields := []any{
		"workspaceId", workspaceID,
		"jobId", job.JobID,
		"jobStatus", job.Status,
		"jobAppId", job.AppID,
		"jobPublishedVersion", job.PublishedVersion,
		"phase", phase,
		"wasPreviouslyPublished", wasPreviouslyPublished,
	}
	if strings.TrimSpace(job.DisplayName) != "" {
		fields = append(fields, "displayName", job.DisplayName)
	}
	if strings.TrimSpace(manifest.AppID) != "" {
		fields = append(fields, "manifestAppId", manifest.AppID)
	}
	if strings.TrimSpace(manifest.Version) != "" {
		fields = append(fields, "version", manifest.Version)
	}
	if strings.TrimSpace(appPackage.AppID) != "" {
		fields = append(fields, "packageAppId", appPackage.AppID)
	}
	if strings.TrimSpace(appPackage.Version) != "" {
		fields = append(fields, "version", appPackage.Version)
	}
	if strings.TrimSpace(string(appPackage.Source)) != "" {
		fields = append(fields, "packageSource", appPackage.Source)
	}
	if strings.TrimSpace(appPackage.PackageDir) != "" {
		fields = append(fields, "packageDir", appPackage.PackageDir)
	}
	if !startedAt.IsZero() {
		fields = append(fields, "durationMs", time.Since(startedAt).Milliseconds())
	}
	return fields
}

func (s *AppFactoryService) bumpRepublishedManifestVersion(ctx context.Context, job workspacebiz.AppFactoryJob, manifest workspacebiz.AppManifest) (workspacebiz.AppManifest, string, error) {
	nextVersion, err := s.nextRepublishVersion(ctx, manifest.AppID, job.PublishedVersion)
	if err != nil {
		return workspacebiz.AppManifest{}, "", err
	}
	manifest.Version = nextVersion
	data, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return workspacebiz.AppManifest{}, "", fmt.Errorf("serialize bumped app manifest: %w", err)
	}
	data = append(data, '\n')
	manifestPath := filepath.Join(appFactoryDraftPackageDir(job), "tutti.app.json")
	if err := os.WriteFile(manifestPath, data, 0o644); err != nil {
		return workspacebiz.AppManifest{}, "", fmt.Errorf("write bumped app manifest: %w", err)
	}
	return workspacebiz.ParseAppManifestJSON(data)
}

func (s *AppFactoryService) nextRepublishVersion(ctx context.Context, appID string, publishedVersion string) (string, error) {
	version := bumpPatchVersion(publishedVersion)
	for attempts := 0; attempts < 100; attempts += 1 {
		if _, err := s.appStore().GetAppPackageVersion(ctx, appID, version); errors.Is(err, workspacedata.ErrWorkspaceAppNotFound) {
			return version, nil
		} else if err != nil {
			return "", err
		}
		version = bumpPatchVersion(version)
	}
	return "", fmt.Errorf("could not find available app package version after %q", publishedVersion)
}
