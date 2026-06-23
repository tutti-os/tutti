package workspace

import (
	"testing"

	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
)

func TestInstallProgressTrackerAggregatesParallelRuntimeDownloads(t *testing.T) {
	tracker := &installProgressTracker{
		plan: installProgressPlan{
			packageDownloadWeight: 0,
			runtimeDownloadWeight: 30,
			installingWeight:      20,
			startingWeight:        10,
		},
		userPhase:      workspacebiz.AppInstallUserPhaseDownloading,
		runtimeStreams: make(map[string]streamDownloadProgress),
	}

	tracker.mu.Lock()
	tracker.runtimeStreams["python"] = streamDownloadProgress{done: 50, total: 100}
	tracker.runtimeStreams["node"] = streamDownloadProgress{done: 25, total: 50}
	tracker.recalculateLocked()
	tracker.mu.Unlock()

	if tracker.overallPercent <= 0 {
		t.Fatalf("overallPercent = %v, want > 0", tracker.overallPercent)
	}

	progress := tracker.snapshotLocked()
	if progress.DownloadedBytes == nil || *progress.DownloadedBytes != 75 {
		t.Fatalf("DownloadedBytes = %v, want 75", progress.DownloadedBytes)
	}
	if progress.TotalBytes == nil || *progress.TotalBytes != 150 {
		t.Fatalf("TotalBytes = %v, want 150", progress.TotalBytes)
	}
}

func TestInstallProgressTrackerIsMonotonic(t *testing.T) {
	tracker := &installProgressTracker{
		plan: installProgressPlan{
			packageDownloadWeight: 40,
			runtimeDownloadWeight: 0,
			installingWeight:      20,
			startingWeight:        10,
		},
		userPhase: workspacebiz.AppInstallUserPhaseDownloading,
	}

	tracker.mu.Lock()
	tracker.packageDone = 10
	tracker.packageTotal = 100
	tracker.recalculateLocked()
	first := tracker.overallPercent
	tracker.packageDone = 5
	tracker.recalculateLocked()
	if tracker.overallPercent < first {
		t.Fatalf("overallPercent regressed from %v to %v", first, tracker.overallPercent)
	}
	tracker.mu.Unlock()
}

func TestInstallProgressTrackerEstimatesUnknownDownloadFraction(t *testing.T) {
	tracker := &installProgressTracker{
		plan: installProgressPlan{
			packageDownloadWeight: 40,
			runtimeDownloadWeight: 0,
			installingWeight:      20,
			startingWeight:        10,
		},
		userPhase: workspacebiz.AppInstallUserPhaseDownloading,
	}

	tracker.mu.Lock()
	tracker.packageDone = 1024 * 1024
	tracker.recalculateLocked()
	if tracker.indeterminate {
		t.Fatal("indeterminate = true, want false when bytes are known")
	}
	if tracker.overallPercent <= 0 {
		t.Fatalf("overallPercent = %v, want > 0", tracker.overallPercent)
	}
	progress := tracker.snapshotLocked()
	if progress.DownloadedBytes == nil {
		t.Fatalf("DownloadedBytes = nil, want non-nil during downloading")
	}
	if progress.TotalBytes != nil {
		t.Fatalf("TotalBytes = %v, want nil without known total", progress.TotalBytes)
	}
	tracker.mu.Unlock()
}

func TestWithActiveInstallJobProgressOnlyAttachesToInstallRuntimeStates(t *testing.T) {
	service := &AppCenterService{}
	progress := workspacebiz.AppInstallProgress{
		UserPhase:      workspacebiz.AppInstallUserPhaseStarting,
		OverallPercent: 95,
	}
	service.beginInstallJob("ws-1", "app-1", InstallOptions{})
	service.setInstallJobProgress("ws-1", "app-1", progress)

	for _, status := range []workspacebiz.AppRuntimeStatus{
		workspacebiz.AppRuntimeStatusPreparing,
		workspacebiz.AppRuntimeStatusStarting,
	} {
		app := service.withActiveInstallJobProgress(workspacebiz.WorkspaceApp{
			Runtime: workspacebiz.AppRuntimeState{Status: status},
		}, "ws-1", "app-1")
		if app.InstallProgress == nil {
			t.Fatalf("InstallProgress = nil for status %q, want active progress", status)
		}
		if app.InstallProgress.OverallPercent != progress.OverallPercent {
			t.Fatalf("InstallProgress.OverallPercent = %v, want %v", app.InstallProgress.OverallPercent, progress.OverallPercent)
		}
	}

	for _, status := range []workspacebiz.AppRuntimeStatus{
		workspacebiz.AppRuntimeStatusIdle,
		workspacebiz.AppRuntimeStatusRunning,
		workspacebiz.AppRuntimeStatusFailed,
		workspacebiz.AppRuntimeStatusStopping,
	} {
		app := service.withActiveInstallJobProgress(workspacebiz.WorkspaceApp{
			Runtime: workspacebiz.AppRuntimeState{Status: status},
		}, "ws-1", "app-1")
		if app.InstallProgress != nil {
			t.Fatalf("InstallProgress = %#v for status %q, want nil", app.InstallProgress, status)
		}
	}
}

func TestShouldSkipInstallProgressPublishForRunningStartingProgress(t *testing.T) {
	progress := workspacebiz.AppInstallProgress{
		UserPhase:      workspacebiz.AppInstallUserPhaseStarting,
		OverallPercent: 100,
	}
	if !shouldSkipInstallProgressPublish(workspacebiz.AppRuntimeStatusRunning, progress) {
		t.Fatal("shouldSkipInstallProgressPublish(running, starting) = false, want true")
	}
	if shouldSkipInstallProgressPublish(workspacebiz.AppRuntimeStatusRunning, workspacebiz.AppInstallProgress{
		UserPhase:      workspacebiz.AppInstallUserPhaseDownloading,
		OverallPercent: 40,
	}) {
		t.Fatal("shouldSkipInstallProgressPublish(running, downloading) = true, want false")
	}
	if shouldSkipInstallProgressPublish(workspacebiz.AppRuntimeStatusStarting, progress) {
		t.Fatal("shouldSkipInstallProgressPublish(starting, starting) = true, want false")
	}
}
