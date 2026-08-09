package workspace

import (
	"context"

	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
)

func (s *AppCenterService) beginInstallJob(workspaceID string, appID string, options InstallOptions) bool {
	key := appRuntimeKey(workspaceID, appID)
	unlock := s.installPublishLocks.Lock(key)
	defer unlock()
	baselineRuntime := s.runner().State(workspaceID, appID)
	s.installMu.Lock()
	defer s.installMu.Unlock()
	s.ensureInstallJobsLocked()
	if job, ok := s.installJobs[key]; ok && job.Status == workspaceAppInstallJobInstalling {
		return false
	}
	s.installGeneration += 1
	s.installJobs[key] = workspaceAppInstallJob{
		Generation:                     s.installGeneration,
		WorkspaceID:                    workspaceID,
		AppID:                          appID,
		Status:                         workspaceAppInstallJobInstalling,
		CurrentPhase:                   workspacebiz.AppInstallUserPhaseDownloading,
		RestartRunning:                 options.RestartRunning,
		BaselineRuntimeStatus:          baselineRuntime.Status,
		BaselineRuntimeUpdatedAtUnixMs: cloneInt64Ptr(baselineRuntime.UpdatedAtUnixMs),
	}
	return true
}

func cloneInt64Ptr(value *int64) *int64 {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

func (s *AppCenterService) finishInstallJob(workspaceID string, appID string, generation uint64) bool {
	key := appRuntimeKey(workspaceID, appID)
	s.installMu.Lock()
	defer s.installMu.Unlock()
	s.ensureInstallJobsLocked()
	job, ok := s.installJobs[key]
	if !ok || job.Generation != generation {
		return false
	}
	delete(s.installJobs, key)
	return true
}

func (s *AppCenterService) failInstallJob(workspaceID string, appID string, generation uint64, err error) bool {
	key := appRuntimeKey(workspaceID, appID)
	s.installMu.Lock()
	defer s.installMu.Unlock()
	s.ensureInstallJobsLocked()
	job, ok := s.installJobs[key]
	if !ok || job.Generation != generation || job.Status != workspaceAppInstallJobInstalling {
		return false
	}
	failurePhase := workspacebiz.AppFailurePhase(job.CurrentPhase)
	if failurePhase == "" {
		failurePhase = workspacebiz.AppFailurePhaseDownloading
	}
	job.Status = workspaceAppInstallJobFailed
	job.FailureReason = err.Error()
	job.FailurePhase = failurePhase
	job.Progress = nil
	s.installJobs[key] = job
	return true
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

func (s *AppCenterService) setInstallJobProgress(workspaceID string, appID string, generation uint64, progress workspacebiz.AppInstallProgress) bool {
	key := appRuntimeKey(workspaceID, appID)
	s.installMu.Lock()
	defer s.installMu.Unlock()
	s.ensureInstallJobsLocked()
	job, ok := s.installJobs[key]
	if !ok || job.Generation != generation || job.Status != workspaceAppInstallJobInstalling {
		return false
	}
	progressCopy := progress
	job.CurrentPhase = progress.UserPhase
	job.Progress = &progressCopy
	s.installJobs[key] = job
	return true
}

func (s *AppCenterService) setInstallJobPhase(workspaceID string, appID string, generation uint64, phase workspacebiz.AppInstallUserPhase) bool {
	key := appRuntimeKey(workspaceID, appID)
	s.installMu.Lock()
	defer s.installMu.Unlock()
	s.ensureInstallJobsLocked()
	job, ok := s.installJobs[key]
	if !ok || job.Generation != generation || job.Status != workspaceAppInstallJobInstalling {
		return false
	}
	job.CurrentPhase = phase
	s.installJobs[key] = job
	return true
}

func (s *AppCenterService) clearInstallJobProgress(workspaceID string, appID string, generation uint64) bool {
	key := appRuntimeKey(workspaceID, appID)
	s.installMu.Lock()
	defer s.installMu.Unlock()
	s.ensureInstallJobsLocked()
	job, ok := s.installJobs[key]
	if !ok || job.Generation != generation {
		return false
	}
	job.Progress = nil
	s.installJobs[key] = job
	return true
}

func (s *AppCenterService) markInstallProgressSent(workspaceID string, appID string, generation uint64) {
	key := appRuntimeKey(workspaceID, appID)
	s.installMu.Lock()
	defer s.installMu.Unlock()
	if s.installProgressSent == nil {
		s.installProgressSent = make(map[string]uint64)
	}
	s.installProgressSent[key] = generation
}

func (s *AppCenterService) installProgressWasSent(workspaceID string, appID string, generation uint64) bool {
	key := appRuntimeKey(workspaceID, appID)
	s.installMu.Lock()
	defer s.installMu.Unlock()
	return s.installProgressSent[key] == generation
}

func (s *AppCenterService) clearInstallProgressSent(workspaceID string, appID string, generation uint64) {
	key := appRuntimeKey(workspaceID, appID)
	s.installMu.Lock()
	defer s.installMu.Unlock()
	if s.installProgressSent[key] == generation {
		delete(s.installProgressSent, key)
	}
}

func (s *AppCenterService) withInstallJobProjections(apps []workspacebiz.WorkspaceApp, workspaceID string) []workspacebiz.WorkspaceApp {
	result := make([]workspacebiz.WorkspaceApp, len(apps))
	copy(result, apps)
	for index, app := range result {
		job, ok := s.installJob(workspaceID, app.Package.AppID)
		if !ok {
			continue
		}
		if job.Status == workspaceAppInstallJobFailed {
			failureReason := job.FailureReason
			failurePhase := job.FailurePhase
			app.Installation = nil
			app.InstallProgress = nil
			app.Runtime = workspacebiz.AppRuntimeState{
				Status:        workspacebiz.AppRuntimeStatusFailed,
				FailurePhase:  &failurePhase,
				FailureReason: &failureReason,
				LastError:     &failureReason,
			}
			result[index] = s.withCurrentRevision(app, workspaceID, app.Package.AppID)
			continue
		}
		if job.Status == workspaceAppInstallJobInstalling && job.Progress != nil {
			progressCopy := *job.Progress
			app.InstallProgress = &progressCopy
			result[index] = s.withCurrentRevision(app, workspaceID, app.Package.AppID)
		}
	}
	return result
}

func (s *AppCenterService) failedInstallAppProjection(ctx context.Context, workspaceID string, appID string, installErr error) (workspacebiz.WorkspaceApp, error) {
	app, err := s.workspaceAppProjectionForInstall(ctx, workspaceID, appID)
	if err != nil {
		return workspacebiz.WorkspaceApp{}, err
	}
	failureReason := installErr.Error()
	failurePhase := workspacebiz.AppFailurePhaseDownloading
	if job, ok := s.installJob(workspaceID, appID); ok && job.FailurePhase != "" {
		failurePhase = job.FailurePhase
	}
	app.Installation = nil
	app.InstallProgress = nil
	app.Runtime = workspacebiz.AppRuntimeState{
		Status:        workspacebiz.AppRuntimeStatusFailed,
		FailurePhase:  &failurePhase,
		FailureReason: &failureReason,
		LastError:     &failureReason,
	}
	return app, nil
}
