package workspace

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

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
	generation := beginInstallJobForTest(t, service, "ws-1", "app-1")
	service.setInstallJobProgress("ws-1", "app-1", generation, progress)

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

func TestShouldSkipInstallProgressPublishOnlyForNewTerminalRuntimeStates(t *testing.T) {
	baselineUpdatedAt := int64(100)
	newerUpdatedAt := int64(101)
	job := workspaceAppInstallJob{
		BaselineRuntimeStatus:          workspacebiz.AppRuntimeStatusRunning,
		BaselineRuntimeUpdatedAtUnixMs: &baselineUpdatedAt,
	}
	tests := []struct {
		name    string
		runtime workspacebiz.AppRuntimeState
		want    bool
	}{
		{name: "baseline running update remains visible", runtime: workspacebiz.AppRuntimeState{Status: workspacebiz.AppRuntimeStatusRunning, UpdatedAtUnixMs: &baselineUpdatedAt}},
		{name: "baseline running projected as pending restart remains visible", runtime: workspacebiz.AppRuntimeState{Status: workspacebiz.AppRuntimeStatusInstalledPendingRestart, UpdatedAtUnixMs: &baselineUpdatedAt}},
		{name: "new running terminal is skipped", runtime: workspacebiz.AppRuntimeState{Status: workspacebiz.AppRuntimeStatusRunning, UpdatedAtUnixMs: &newerUpdatedAt}, want: true},
		{name: "new failure terminal is skipped", runtime: workspacebiz.AppRuntimeState{Status: workspacebiz.AppRuntimeStatusFailed, UpdatedAtUnixMs: &newerUpdatedAt}, want: true},
		{name: "stopping is always skipped", runtime: workspacebiz.AppRuntimeState{Status: workspacebiz.AppRuntimeStatusStopping}, want: true},
		{name: "starting remains visible", runtime: workspacebiz.AppRuntimeState{Status: workspacebiz.AppRuntimeStatusStarting}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := shouldSkipInstallProgressPublish(test.runtime, job); got != test.want {
				t.Fatalf("shouldSkipInstallProgressPublish(%#v) = %v, want %v", test.runtime, got, test.want)
			}
		})
	}

	failedJob := workspaceAppInstallJob{
		BaselineRuntimeStatus:          workspacebiz.AppRuntimeStatusFailed,
		BaselineRuntimeUpdatedAtUnixMs: &baselineUpdatedAt,
	}
	if shouldSkipInstallProgressPublish(workspacebiz.AppRuntimeState{
		Status: workspacebiz.AppRuntimeStatusFailed, UpdatedAtUnixMs: &baselineUpdatedAt,
	}, failedJob) {
		t.Fatal("baseline failed app update was skipped")
	}
}

func TestInstallProgressCannotOverwriteRuntimeFailureTerminal(t *testing.T) {
	ctx := context.Background()
	packageDir := createWorkspaceAppPackageForTest(t, t.TempDir(), workspacebiz.AppManifest{
		SchemaVersion: workspacebiz.AppManifestSchemaVersionV1,
		AppID:         "app-1",
		Version:       "0.1.0",
		Name:          "App One",
		Description:   "App One",
		Runtime: workspacebiz.AppManifestRuntime{
			Bootstrap:       "bootstrap.sh",
			HealthcheckPath: "/ready",
		},
	})
	appPackage := workspacebiz.AppPackage{
		AppID: "app-1", Version: "0.1.0", PackageDir: packageDir,
		Manifest: mustReadManifestForTest(t, packageDir), Source: workspacebiz.AppPackageSourceImported,
	}
	store := newAppStoreStub()
	if err := store.PutAppPackage(ctx, appPackage); err != nil {
		t.Fatal(err)
	}
	if err := store.PutWorkspaceAppInstallation(ctx, workspacebiz.AppInstallation{
		WorkspaceID: "ws-1", AppID: "app-1", Enabled: true,
	}); err != nil {
		t.Fatal(err)
	}
	runner := &AppRunner{}
	runner.ensure()
	key := appRuntimeKey("ws-1", "app-1")
	runner.mu.Lock()
	runner.states[key] = workspacebiz.AppRuntimeState{Status: workspacebiz.AppRuntimeStatusPreparing}
	runner.mu.Unlock()
	publisher := &workspaceAppPublisherStub{}
	service := &AppCenterService{Store: store, Runner: runner, Publisher: publisher}
	generation := beginInstallJobForTest(t, service, "ws-1", "app-1")
	progress := workspacebiz.AppInstallProgress{
		UserPhase: workspacebiz.AppInstallUserPhaseStarting, OverallPercent: 95,
	}
	service.publishInstallProgress(ctx, "ws-1", "app-1", generation, progress, true)
	if len(publisher.published) == 0 || publisher.published[len(publisher.published)-1].InstallProgress == nil {
		t.Fatal("transient install progress was not published")
	}

	failurePhase := workspacebiz.AppFailurePhaseStarting
	failureReason := "health check failed"
	runner.mu.Lock()
	runner.states[key] = workspacebiz.AppRuntimeState{
		Status: workspacebiz.AppRuntimeStatusFailed, FailurePhase: &failurePhase,
		FailureReason: &failureReason, LastError: &failureReason,
	}
	runner.mu.Unlock()
	progress.OverallPercent = 100
	service.publishInstallProgress(ctx, "ws-1", "app-1", generation, progress, true)

	last := publisher.published[len(publisher.published)-1]
	if last.Runtime.Status != workspacebiz.AppRuntimeStatusFailed || last.InstallProgress != nil {
		t.Fatalf("late install progress replaced failure terminal: %#v", last)
	}
	if service.installProgressWasSent("ws-1", "app-1", generation) {
		t.Fatal("published progress marker was not cleared")
	}
}

func TestInstallFailureIsFinalAfterProgressCleanup(t *testing.T) {
	ctx := context.Background()
	packageDir := createWorkspaceAppPackageForTest(t, t.TempDir(), workspacebiz.AppManifest{
		SchemaVersion: workspacebiz.AppManifestSchemaVersionV1,
		AppID:         "app-1",
		Version:       "0.1.0",
		Name:          "App One",
		Description:   "App One",
		Runtime: workspacebiz.AppManifestRuntime{
			Bootstrap:       "bootstrap.sh",
			HealthcheckPath: "/ready",
		},
	})
	appPackage := workspacebiz.AppPackage{
		AppID: "app-1", Version: "0.1.0", PackageDir: packageDir,
		Manifest: mustReadManifestForTest(t, packageDir), Source: workspacebiz.AppPackageSourceImported,
	}
	store := newAppStoreStub()
	if err := store.PutAppPackage(ctx, appPackage); err != nil {
		t.Fatal(err)
	}
	publisher := &workspaceAppPublisherStub{}
	service := &AppCenterService{Store: store, Runner: &AppRunner{}, Publisher: publisher}
	generation := beginInstallJobForTest(t, service, "ws-1", "app-1")
	service.publishInstallProgress(ctx, "ws-1", "app-1", generation, workspacebiz.AppInstallProgress{
		UserPhase: workspacebiz.AppInstallUserPhaseDownloading, OverallPercent: 25,
	}, true)

	installErr := errors.New("download interrupted")
	service.handleInstallJobFailure(ctx, "ws-1", "app-1", generation, appPackage, installErr, time.Now())
	publishedAfterFailure := len(publisher.published)
	service.clearInstallProgress("ws-1", "app-1", generation) // Mirrors the deferred tracker cleanup.

	if len(publisher.published) != publishedAfterFailure {
		t.Fatalf("deferred cleanup published after failure: event count %d -> %d", publishedAfterFailure, len(publisher.published))
	}
	last := publisher.published[len(publisher.published)-1]
	if last.Runtime.Status != workspacebiz.AppRuntimeStatusFailed || last.InstallProgress != nil {
		t.Fatalf("last projection = %#v, want failed terminal without progress", last)
	}
	if last.Runtime.FailureReason == nil || *last.Runtime.FailureReason != installErr.Error() {
		t.Fatalf("FailureReason = %v, want %q", last.Runtime.FailureReason, installErr)
	}
}

func TestInstallFailureSerializesWithInFlightProgressPublish(t *testing.T) {
	ctx := context.Background()
	packageDir := createWorkspaceAppPackageForTest(t, t.TempDir(), workspacebiz.AppManifest{
		SchemaVersion: workspacebiz.AppManifestSchemaVersionV1,
		AppID:         "app-1",
		Version:       "0.1.0",
		Name:          "App One",
		Description:   "App One",
		Runtime: workspacebiz.AppManifestRuntime{
			Bootstrap:       "bootstrap.sh",
			HealthcheckPath: "/ready",
		},
	})
	appPackage := workspacebiz.AppPackage{
		AppID: "app-1", Version: "0.1.0", PackageDir: packageDir,
		Manifest: mustReadManifestForTest(t, packageDir), Source: workspacebiz.AppPackageSourceImported,
	}
	store := newAppStoreStub()
	if err := store.PutAppPackage(ctx, appPackage); err != nil {
		t.Fatal(err)
	}
	publisher := newBlockingInstallProgressPublisher()
	service := &AppCenterService{Store: store, Runner: &AppRunner{}, Publisher: publisher}
	generation := beginInstallJobForTest(t, service, "ws-1", "app-1")

	progressDone := make(chan struct{})
	go func() {
		defer close(progressDone)
		service.publishInstallProgress(ctx, "ws-1", "app-1", generation, workspacebiz.AppInstallProgress{
			UserPhase: workspacebiz.AppInstallUserPhaseDownloading, OverallPercent: 25,
		}, true)
	}()
	select {
	case <-publisher.progressEntered:
	case <-time.After(time.Second):
		t.Fatal("progress publish did not reach publisher")
	}

	failureDone := make(chan struct{})
	go func() {
		defer close(failureDone)
		service.handleInstallJobFailure(ctx, "ws-1", "app-1", generation, appPackage, errors.New("download interrupted"), time.Now())
	}()
	close(publisher.releaseProgress)
	for name, done := range map[string]<-chan struct{}{"progress": progressDone, "failure": failureDone} {
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Fatalf("%s publication did not finish", name)
		}
	}

	published := publisher.snapshot()
	last := published[len(published)-1]
	if last.Runtime.Status != workspacebiz.AppRuntimeStatusFailed || last.InstallProgress != nil {
		t.Fatalf("last projection = %#v, want failed terminal without progress", last)
	}
}

func TestOldInstallGenerationCannotPublishOrClearNewInstallProgress(t *testing.T) {
	service := &AppCenterService{}
	oldGeneration := beginInstallJobForTest(t, service, "ws-1", "app-1")
	if !service.failInstallJob("ws-1", "app-1", oldGeneration, errors.New("first install failed")) {
		t.Fatal("failInstallJob() = false, want true")
	}
	newGeneration := beginInstallJobForTest(t, service, "ws-1", "app-1")
	if newGeneration == oldGeneration {
		t.Fatal("new install reused the previous generation")
	}

	service.publishInstallProgress(context.Background(), "ws-1", "app-1", oldGeneration, workspacebiz.AppInstallProgress{
		UserPhase: workspacebiz.AppInstallUserPhaseDownloading, OverallPercent: 90,
	}, true)
	service.clearInstallProgress("ws-1", "app-1", oldGeneration)

	job, ok := service.installJob("ws-1", "app-1")
	if !ok || job.Generation != newGeneration || job.Status != workspaceAppInstallJobInstalling {
		t.Fatalf("current install job was changed by stale generation: %#v", job)
	}
}

func TestCompleteInstallJobClearsProgressBeforeRemovingGeneration(t *testing.T) {
	ctx := context.Background()
	packageDir := createWorkspaceAppPackageForTest(t, t.TempDir(), workspacebiz.AppManifest{
		SchemaVersion: workspacebiz.AppManifestSchemaVersionV1,
		AppID:         "app-1",
		Version:       "0.1.0",
		Name:          "App One",
		Description:   "App One",
		Runtime: workspacebiz.AppManifestRuntime{
			Bootstrap:       "bootstrap.sh",
			HealthcheckPath: "/ready",
		},
	})
	store := newAppStoreStub()
	if err := store.PutAppPackage(ctx, workspacebiz.AppPackage{
		AppID: "app-1", Version: "0.1.0", PackageDir: packageDir,
		Manifest: mustReadManifestForTest(t, packageDir), Source: workspacebiz.AppPackageSourceImported,
	}); err != nil {
		t.Fatal(err)
	}
	publisher := &workspaceAppPublisherStub{}
	service := &AppCenterService{Store: store, Runner: &AppRunner{}, Publisher: publisher}
	generation := beginInstallJobForTest(t, service, "ws-1", "app-1")
	service.publishInstallProgress(ctx, "ws-1", "app-1", generation, workspacebiz.AppInstallProgress{
		UserPhase: workspacebiz.AppInstallUserPhaseInstalling, OverallPercent: 75,
	}, true)

	if !service.completeInstallJob("ws-1", "app-1", generation) {
		t.Fatal("completeInstallJob() = false, want true")
	}
	if _, ok := service.installJob("ws-1", "app-1"); ok {
		t.Fatal("completed install job was not removed")
	}
	last := publisher.published[len(publisher.published)-1]
	if last.InstallProgress != nil {
		t.Fatalf("last projection retained install progress: %#v", last.InstallProgress)
	}
}

func TestInstallProgressIsVisibleWhileUpdatingBaselineTerminalApp(t *testing.T) {
	ctx := context.Background()
	packageDir := createWorkspaceAppPackageForTest(t, t.TempDir(), workspacebiz.AppManifest{
		SchemaVersion: workspacebiz.AppManifestSchemaVersionV1,
		AppID:         "app-1",
		Version:       "0.1.0",
		Name:          "App One",
		Description:   "App One",
		Runtime: workspacebiz.AppManifestRuntime{
			Bootstrap:       "bootstrap.sh",
			HealthcheckPath: "/ready",
		},
	})
	appPackage := workspacebiz.AppPackage{
		AppID: "app-1", Version: "0.1.0", PackageDir: packageDir,
		Manifest: mustReadManifestForTest(t, packageDir), Source: workspacebiz.AppPackageSourceImported,
	}

	for _, status := range []workspacebiz.AppRuntimeStatus{
		workspacebiz.AppRuntimeStatusRunning,
		workspacebiz.AppRuntimeStatusFailed,
	} {
		t.Run(string(status), func(t *testing.T) {
			store := newAppStoreStub()
			if err := store.PutAppPackage(ctx, appPackage); err != nil {
				t.Fatal(err)
			}
			if err := store.PutWorkspaceAppInstallation(ctx, workspacebiz.AppInstallation{
				WorkspaceID: "ws-1", AppID: "app-1", Enabled: true,
			}); err != nil {
				t.Fatal(err)
			}
			updatedAt := int64(100)
			runner := &AppRunner{}
			runner.ensure()
			runner.states[appRuntimeKey("ws-1", "app-1")] = workspacebiz.AppRuntimeState{
				Status: status, UpdatedAtUnixMs: &updatedAt,
			}
			publisher := &workspaceAppPublisherStub{}
			service := &AppCenterService{Store: store, Runner: runner, Publisher: publisher}
			generation := beginInstallJobForTest(t, service, "ws-1", "app-1")
			service.publishInstallProgress(ctx, "ws-1", "app-1", generation, workspacebiz.AppInstallProgress{
				UserPhase: workspacebiz.AppInstallUserPhaseDownloading, OverallPercent: 25,
			}, true)

			last := publisher.published[len(publisher.published)-1]
			if last.InstallProgress == nil {
				t.Fatalf("install progress missing while updating baseline %q app", status)
			}
		})
	}
}

func TestInstallJobRetainsCurrentPhaseWhenPublishedProgressIsCleared(t *testing.T) {
	service := &AppCenterService{}
	generation := beginInstallJobForTest(t, service, "ws-1", "app-1")
	service.setInstallJobPhase("ws-1", "app-1", generation, workspacebiz.AppInstallUserPhaseStarting)
	service.clearInstallJobProgress("ws-1", "app-1", generation)
	service.failInstallJob("ws-1", "app-1", generation, errors.New("activation failed"))

	job, ok := service.installJob("ws-1", "app-1")
	if !ok || job.FailurePhase != workspacebiz.AppFailurePhaseStarting {
		t.Fatalf("failed install job = %#v, want starting failure phase", job)
	}
}

func beginInstallJobForTest(t *testing.T, service *AppCenterService, workspaceID string, appID string) uint64 {
	t.Helper()
	if !service.beginInstallJob(workspaceID, appID, InstallOptions{}) {
		t.Fatal("beginInstallJob() = false, want true")
	}
	job, ok := service.installJob(workspaceID, appID)
	if !ok || job.Generation == 0 {
		t.Fatalf("install job = %#v, want non-zero generation", job)
	}
	return job.Generation
}

type blockingInstallProgressPublisher struct {
	progressEntered chan struct{}
	releaseProgress chan struct{}
	progressOnce    sync.Once
	mu              sync.Mutex
	published       []workspacebiz.WorkspaceApp
}

func newBlockingInstallProgressPublisher() *blockingInstallProgressPublisher {
	return &blockingInstallProgressPublisher{
		progressEntered: make(chan struct{}),
		releaseProgress: make(chan struct{}),
	}
}

func (p *blockingInstallProgressPublisher) PublishWorkspaceAppUpdated(_ context.Context, _ string, app workspacebiz.WorkspaceApp) error {
	if app.InstallProgress != nil {
		p.progressOnce.Do(func() { close(p.progressEntered) })
		<-p.releaseProgress
	}
	p.mu.Lock()
	p.published = append(p.published, app)
	p.mu.Unlock()
	return nil
}

func (p *blockingInstallProgressPublisher) snapshot() []workspacebiz.WorkspaceApp {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]workspacebiz.WorkspaceApp(nil), p.published...)
}
