package workspace

import (
	"context"

	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
)

func (s *AppCenterService) beginInstallJob(workspaceID string, appID string, options InstallOptions) bool {
	key := appRuntimeKey(workspaceID, appID)
	s.installMu.Lock()
	defer s.installMu.Unlock()
	s.ensureInstallJobsLocked()
	if job, ok := s.installJobs[key]; ok && job.Status == workspaceAppInstallJobInstalling {
		return false
	}
	s.installJobs[key] = workspaceAppInstallJob{
		WorkspaceID:    workspaceID,
		AppID:          appID,
		Status:         workspaceAppInstallJobInstalling,
		RestartRunning: options.RestartRunning,
	}
	return true
}

func (s *AppCenterService) finishInstallJob(workspaceID string, appID string) {
	key := appRuntimeKey(workspaceID, appID)
	s.installMu.Lock()
	defer s.installMu.Unlock()
	s.ensureInstallJobsLocked()
	delete(s.installJobs, key)
}

func (s *AppCenterService) failInstallJob(workspaceID string, appID string, err error) {
	key := appRuntimeKey(workspaceID, appID)
	s.installMu.Lock()
	defer s.installMu.Unlock()
	s.ensureInstallJobsLocked()
	s.installJobs[key] = workspaceAppInstallJob{
		WorkspaceID:   workspaceID,
		AppID:         appID,
		Status:        workspaceAppInstallJobFailed,
		FailureReason: err.Error(),
	}
}

func (s *AppCenterService) installJobOptions(workspaceID string, appID string) InstallOptions {
	job, ok := s.installJob(workspaceID, appID)
	if !ok {
		return InstallOptions{}
	}
	return InstallOptions{RestartRunning: job.RestartRunning}
}

func (s *AppCenterService) installJob(workspaceID string, appID string) (workspaceAppInstallJob, bool) {
	key := appRuntimeKey(workspaceID, appID)
	s.installMu.Lock()
	defer s.installMu.Unlock()
	s.ensureInstallJobsLocked()
	job, ok := s.installJobs[key]
	return job, ok
}

func (s *AppCenterService) ensureInstallJobsLocked() {
	if s.installJobs == nil {
		s.installJobs = make(map[string]workspaceAppInstallJob)
	}
}

func (s *AppCenterService) withInstallJobProjections(apps []workspacebiz.WorkspaceApp, workspaceID string) []workspacebiz.WorkspaceApp {
	result := make([]workspacebiz.WorkspaceApp, len(apps))
	copy(result, apps)
	for index, app := range result {
		job, ok := s.installJob(workspaceID, app.Package.AppID)
		if !ok || job.Status != workspaceAppInstallJobFailed {
			continue
		}
		failureReason := job.FailureReason
		app.Installation = nil
		app.Runtime = workspacebiz.AppRuntimeState{
			Status:        workspacebiz.AppRuntimeStatusFailed,
			FailureReason: &failureReason,
			LastError:     &failureReason,
		}
		result[index] = s.withCurrentRevision(app, workspaceID, app.Package.AppID)
	}
	return result
}

func (s *AppCenterService) failedInstallAppProjection(ctx context.Context, workspaceID string, appID string, installErr error) (workspacebiz.WorkspaceApp, error) {
	app, err := s.workspaceAppProjectionForInstall(ctx, workspaceID, appID)
	if err != nil {
		return workspacebiz.WorkspaceApp{}, err
	}
	failureReason := installErr.Error()
	app.Installation = nil
	app.Runtime = workspacebiz.AppRuntimeState{
		Status:        workspacebiz.AppRuntimeStatusFailed,
		FailureReason: &failureReason,
		LastError:     &failureReason,
	}
	return app, nil
}
