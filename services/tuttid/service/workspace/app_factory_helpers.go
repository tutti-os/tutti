package workspace

import (
	"errors"
	"strconv"
	"strings"

	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
)

func appFactoryActionKey(action string, workspaceID string, jobID string) string {
	return strings.TrimSpace(action) + "\x00" + strings.TrimSpace(workspaceID) + "\x00" + strings.TrimSpace(jobID)
}

func isAppFactoryRepublish(job workspacebiz.AppFactoryJob, existingPackage workspacebiz.AppPackage) bool {
	if strings.TrimSpace(job.PublishedVersion) == "" {
		return false
	}
	if strings.TrimSpace(existingPackage.FactoryJobID) != strings.TrimSpace(job.JobID) {
		return false
	}
	return strings.TrimSpace(existingPackage.AppID) == strings.TrimSpace(job.AppID)
}

func isPublishedAppFactoryJob(job workspacebiz.AppFactoryJob) bool {
	return job.Status == workspacebiz.AppFactoryJobStatusPublished
}

func isAppFactoryPackageForJob(appPackage workspacebiz.AppPackage, job workspacebiz.AppFactoryJob, workspaceID string) bool {
	if appPackage.Source != workspacebiz.AppPackageSourceGenerated {
		return false
	}
	if strings.TrimSpace(appPackage.FactoryJobID) != strings.TrimSpace(job.JobID) {
		return false
	}
	if jobAppID := strings.TrimSpace(job.AppID); jobAppID != "" && strings.TrimSpace(appPackage.AppID) != jobAppID {
		return false
	}
	createdInWorkspaceID := strings.TrimSpace(appPackage.CreatedInWorkspaceID)
	return createdInWorkspaceID == "" || createdInWorkspaceID == strings.TrimSpace(workspaceID)
}

func bumpPatchVersion(version string) string {
	trimmed := strings.TrimSpace(version)
	if trimmed == "" {
		return defaultFactoryAppVersion
	}
	core, suffix, hasSuffix := strings.Cut(trimmed, "-")
	parts := strings.Split(core, ".")
	if len(parts) != 3 {
		return trimmed + ".1"
	}
	major, majorErr := strconv.Atoi(parts[0])
	minor, minorErr := strconv.Atoi(parts[1])
	patch, patchErr := strconv.Atoi(parts[2])
	if majorErr != nil || minorErr != nil || patchErr != nil || major < 0 || minor < 0 || patch < 0 {
		return trimmed + ".1"
	}
	next := strconv.Itoa(major) + "." + strconv.Itoa(minor) + "." + strconv.Itoa(patch+1)
	if hasSuffix {
		return next + "-" + suffix
	}
	return next
}

func runtimeStateError(state workspacebiz.AppRuntimeState) error {
	if state.LastError != nil && strings.TrimSpace(*state.LastError) != "" {
		return errors.New(strings.TrimSpace(*state.LastError))
	}
	if state.FailureReason != nil && strings.TrimSpace(*state.FailureReason) != "" {
		return errors.New(strings.TrimSpace(*state.FailureReason))
	}
	return errors.New("app runtime failed")
}

func optionalStringPointer(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}
