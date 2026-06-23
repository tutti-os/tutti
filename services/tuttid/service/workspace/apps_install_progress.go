package workspace

import (
	"context"
	"errors"
	"log/slog"
	"math"
	"sync"
	"time"

	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
	managedruntime "github.com/tutti-os/tutti/services/tuttid/service/managedruntime"
)

const (
	installProgressWeightPackageDownload = 40.0
	installProgressWeightRuntimeDownload = 30.0
	installProgressWeightInstalling      = 20.0
	installProgressWeightStarting        = 10.0
	installProgressPublishInterval       = 300 * time.Millisecond
)

type appArtifactDownloadProgressKey struct{}

type AppArtifactDownloadProgress struct {
	DownloadedBytes int64
	TotalBytes      int64
}

type installProgressPlan struct {
	packageDownloadWeight float64
	runtimeDownloadWeight float64
	installingWeight      float64
	startingWeight        float64
}

type installProgressTracker struct {
	service     *AppCenterService
	workspaceID string
	appID       string
	plan        installProgressPlan

	mu              sync.Mutex
	userPhase       workspacebiz.AppInstallUserPhase
	packageDone     int64
	packageTotal    int64
	runtimeStreams  map[string]streamDownloadProgress
	installingDone  float64
	startingDone    float64
	overallPercent  float64
	indeterminate   bool
	lastPublished   float64
	lastPublishTime time.Time
}

type streamDownloadProgress struct {
	done  int64
	total int64
}

func (s *AppCenterService) newInstallProgressTracker(workspaceID string, appID string, plan installProgressPlan) *installProgressTracker {
	tracker := &installProgressTracker{
		service:     s,
		workspaceID: workspaceID,
		appID:       appID,
		plan:        plan,
		userPhase:   workspacebiz.AppInstallUserPhaseDownloading,
	}
	tracker.publish(true)
	return tracker
}

func (s *AppCenterService) buildInstallProgressPlan(ctx context.Context, appID string) installProgressPlan {
	plan := installProgressPlan{
		packageDownloadWeight: installProgressWeightPackageDownload,
		runtimeDownloadWeight: installProgressWeightRuntimeDownload,
		installingWeight:      installProgressWeightInstalling,
		startingWeight:        installProgressWeightStarting,
	}
	if !s.installNeedsPackageDownload(ctx, appID) {
		plan.packageDownloadWeight = 0
	}
	if !s.installNeedsRuntimeDownload() {
		plan.runtimeDownloadWeight = 0
	}
	if plan.packageDownloadWeight == 0 && plan.runtimeDownloadWeight == 0 {
		plan.installingWeight = 70
		plan.startingWeight = 30
	}
	return plan
}

func (s *AppCenterService) installNeedsPackageDownload(ctx context.Context, appID string) bool {
	appPackage, err := s.Store.GetAppPackage(ctx, appID)
	if err != nil {
		if errors.Is(err, workspacedata.ErrWorkspaceAppNotFound) {
			_, ok, remoteErr := s.remoteBuiltinForAppID(ctx, appID)
			return remoteErr == nil && ok
		}
		return false
	}
	remoteBuiltin, ok, remoteErr := s.remoteBuiltinForAppID(ctx, appID)
	if remoteErr != nil || !ok {
		return false
	}
	return shouldMaterializeRemoteBuiltin(appPackage, remoteBuiltin)
}

func (s *AppCenterService) installNeedsRuntimeDownload() bool {
	resolver := s.runner().runtimeResolver()
	managed, ok := resolver.(DefaultManagedAppRuntimeResolver)
	if !ok {
		return false
	}
	root := managed.DefaultRoot()
	return !managedruntime.RootReady(root)
}

func ContextWithAppArtifactDownloadProgress(ctx context.Context, report func(AppArtifactDownloadProgress)) context.Context {
	if report == nil {
		return ctx
	}
	return context.WithValue(ctx, appArtifactDownloadProgressKey{}, report)
}

func ContextWithAppArtifactRuntimeComponentProgress(ctx context.Context, report func(string, AppArtifactDownloadProgress)) context.Context {
	if report == nil {
		return ctx
	}
	return managedruntime.ContextWithComponentDownloadProgress(ctx, func(name string, progress managedruntime.DownloadProgress) {
		report(name, AppArtifactDownloadProgress{
			DownloadedBytes: progress.DownloadedBytes,
			TotalBytes:      progress.TotalBytes,
		})
	})
}

func appArtifactDownloadProgressFromContext(ctx context.Context) func(AppArtifactDownloadProgress) {
	if ctx == nil {
		return nil
	}
	report, _ := ctx.Value(appArtifactDownloadProgressKey{}).(func(AppArtifactDownloadProgress))
	return report
}

func (t *installProgressTracker) packageProgressContext(ctx context.Context) context.Context {
	if t.plan.packageDownloadWeight <= 0 {
		return ctx
	}
	return ContextWithAppArtifactDownloadProgress(ctx, func(progress AppArtifactDownloadProgress) {
		t.updatePackageDownload(progress.DownloadedBytes, progress.TotalBytes)
	})
}

func (t *installProgressTracker) runtimeProgressContext(ctx context.Context) context.Context {
	if t.plan.runtimeDownloadWeight <= 0 {
		return ctx
	}
	return ContextWithAppArtifactRuntimeComponentProgress(ctx, func(component string, progress AppArtifactDownloadProgress) {
		t.updateRuntimeStreamDownload(component, progress.DownloadedBytes, progress.TotalBytes)
	})
}

func (t *installProgressTracker) updatePackageDownload(downloaded int64, total int64) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if downloaded > t.packageDone {
		t.packageDone = downloaded
	}
	if total > t.packageTotal {
		t.packageTotal = total
	}
	t.userPhase = workspacebiz.AppInstallUserPhaseDownloading
	t.recalculateLocked()
	t.publishLocked(false)
}

func (t *installProgressTracker) updateRuntimeStreamDownload(stream string, downloaded int64, total int64) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.runtimeStreams == nil {
		t.runtimeStreams = make(map[string]streamDownloadProgress)
	}
	current := t.runtimeStreams[stream]
	if downloaded > current.done {
		current.done = downloaded
	}
	if total > current.total {
		current.total = total
	}
	t.runtimeStreams[stream] = current
	t.userPhase = workspacebiz.AppInstallUserPhaseDownloading
	t.recalculateLocked()
	t.publishLocked(false)
}

func (t *installProgressTracker) runtimeDownloadTotalsLocked() (int64, int64) {
	downloaded := int64(0)
	total := int64(0)
	for _, stream := range t.runtimeStreams {
		downloaded += stream.done
		if stream.total > 0 {
			total += stream.total
		}
	}
	return downloaded, total
}

func (t *installProgressTracker) beginInstalling() {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.userPhase = workspacebiz.AppInstallUserPhaseInstalling
	if t.plan.packageDownloadWeight > 0 {
		t.packageDone = maxInt64(t.packageDone, t.packageTotal)
	}
	if t.plan.runtimeDownloadWeight > 0 {
		for stream, progress := range t.runtimeStreams {
			if progress.total > 0 {
				progress.done = progress.total
				t.runtimeStreams[stream] = progress
			}
		}
	}
	t.installingDone = 0
	t.recalculateLocked()
	t.publishLocked(true)
}

func (t *installProgressTracker) advanceInstalling(fraction float64) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if fraction > t.installingDone {
		t.installingDone = fraction
	}
	t.userPhase = workspacebiz.AppInstallUserPhaseInstalling
	t.recalculateLocked()
	t.publishLocked(false)
}

func (t *installProgressTracker) finishInstalling() {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.installingDone = 1
	t.userPhase = workspacebiz.AppInstallUserPhaseStarting
	t.recalculateLocked()
	t.publishLocked(true)
}

func (t *installProgressTracker) advanceStarting(fraction float64) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if fraction > t.startingDone {
		t.startingDone = fraction
	}
	t.userPhase = workspacebiz.AppInstallUserPhaseStarting
	t.recalculateLocked()
	t.publishLocked(false)
}

func (t *installProgressTracker) finishStarting() {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.startingDone = 1
	t.recalculateLocked()
	t.publishLocked(true)
}

func (t *installProgressTracker) clear() {
	t.service.clearInstallProgress(t.workspaceID, t.appID)
}

func (t *installProgressTracker) recalculateLocked() {
	downloadWeight := t.plan.packageDownloadWeight + t.plan.runtimeDownloadWeight
	downloadFraction := 0.0
	downloaded := int64(0)
	total := int64(0)
	if t.plan.packageDownloadWeight > 0 {
		downloaded += t.packageDone
		if t.packageTotal > 0 {
			total += t.packageTotal
		}
	}
	if t.plan.runtimeDownloadWeight > 0 {
		runtimeDownloaded, runtimeTotal := t.runtimeDownloadTotalsLocked()
		downloaded += runtimeDownloaded
		if runtimeTotal > 0 {
			total += runtimeTotal
		}
	}
	if total > 0 {
		downloadFraction = float64(downloaded) / float64(total)
		if downloadFraction > 1 {
			downloadFraction = 1
		}
	} else if downloadWeight > 0 && t.userPhase == workspacebiz.AppInstallUserPhaseDownloading && downloaded > 0 {
		downloadFraction = estimateUnknownDownloadFraction(downloaded)
	}

	if t.overallPercent > 0 || downloadFraction > 0 || t.userPhase != workspacebiz.AppInstallUserPhaseDownloading {
		t.indeterminate = false
	} else if downloadWeight > 0 && t.userPhase == workspacebiz.AppInstallUserPhaseDownloading {
		t.indeterminate = true
	} else {
		t.indeterminate = false
	}

	overall := downloadFraction * downloadWeight
	if t.plan.installingWeight > 0 {
		overall += t.installingDone * t.plan.installingWeight
	}
	if t.plan.startingWeight > 0 {
		overall += t.startingDone * t.plan.startingWeight
	}
	if overall > 100 {
		overall = 100
	}
	if overall < t.overallPercent {
		overall = t.overallPercent
	}
	t.overallPercent = overall
}

func estimateUnknownDownloadFraction(downloaded int64) float64 {
	if downloaded <= 0 {
		return 0
	}
	const referenceBytes = 50 * 1024 * 1024
	fraction := 0.05 + 0.8*(float64(downloaded)/float64(referenceBytes))
	if fraction > 0.85 {
		return 0.85
	}
	return fraction
}

func (t *installProgressTracker) snapshotLocked() workspacebiz.AppInstallProgress {
	var downloadedBytes *int64
	var totalBytes *int64
	if t.userPhase == workspacebiz.AppInstallUserPhaseDownloading &&
		(t.plan.packageDownloadWeight > 0 || t.plan.runtimeDownloadWeight > 0) {
		downloaded := int64(0)
		total := int64(0)
		if t.plan.packageDownloadWeight > 0 {
			downloaded += t.packageDone
			if t.packageTotal > 0 {
				total += t.packageTotal
			}
		}
		if t.plan.runtimeDownloadWeight > 0 {
			runtimeDownloaded, runtimeTotal := t.runtimeDownloadTotalsLocked()
			downloaded += runtimeDownloaded
			if runtimeTotal > 0 {
				total += runtimeTotal
			}
		}
		if downloaded > 0 || total > 0 {
			downloadedCopy := downloaded
			downloadedBytes = &downloadedCopy
			if total > 0 {
				totalCopy := total
				totalBytes = &totalCopy
			}
		}
	}
	return workspacebiz.AppInstallProgress{
		UserPhase:       t.userPhase,
		OverallPercent:  roundInstallProgressPercent(t.overallPercent),
		DownloadedBytes: downloadedBytes,
		TotalBytes:      totalBytes,
		Indeterminate:   t.indeterminate,
		UpdatedAtUnixMs: time.Now().UnixMilli(),
	}
}

func (t *installProgressTracker) publish(force bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.publishLocked(force)
}

func (t *installProgressTracker) publishLocked(force bool) {
	if !force {
		if time.Since(t.lastPublishTime) < installProgressPublishInterval &&
			math.Abs(t.overallPercent-t.lastPublished) < 0.5 &&
			t.overallPercent < 100 {
			return
		}
	}
	t.lastPublishTime = time.Now()
	t.lastPublished = t.overallPercent
	progress := t.snapshotLocked()
	t.service.publishInstallProgress(context.Background(), t.workspaceID, t.appID, progress, force)
}

func roundInstallProgressPercent(value float64) float64 {
	if value <= 0 {
		return 0
	}
	if value >= 100 {
		return 100
	}
	return math.Round(value*10) / 10
}

func maxInt64(left int64, right int64) int64 {
	if left > right {
		return left
	}
	return right
}

func (s *AppCenterService) publishInstallProgress(ctx context.Context, workspaceID string, appID string, progress workspacebiz.AppInstallProgress, checkpoint bool) {
	app, err := s.workspaceAppProjectionForInstall(ctx, workspaceID, appID)
	if err != nil {
		return
	}
	if shouldSkipInstallProgressPublish(app.Runtime.Status, progress) {
		s.clearInstallJobProgress(workspaceID, appID)
		slog.Info(
			"workspace_app_install_progress_publish_skipped",
			"workspaceId", workspaceID,
			"appId", appID,
			"runtimeStatus", app.Runtime.Status,
			"userPhase", progress.UserPhase,
			"overallPercent", progress.OverallPercent,
			"reason", "runtime_already_running",
		)
		return
	}
	s.setInstallJobProgress(workspaceID, appID, progress)
	progressCopy := progress
	app.InstallProgress = &progressCopy
	publishedApp := s.publishAppIfChanged(ctx, workspaceID, appID, app)
	if checkpoint {
		slog.Info(
			"workspace_app_install_progress_checkpoint",
			"workspaceId", workspaceID,
			"appId", appID,
			"runtimeStatus", publishedApp.Runtime.Status,
			"stateRevision", publishedApp.StateRevision,
			"userPhase", progress.UserPhase,
			"overallPercent", progress.OverallPercent,
			"indeterminate", progress.Indeterminate,
			"downloadedBytes", progress.DownloadedBytes,
			"totalBytes", progress.TotalBytes,
		)
	}
}

func (s *AppCenterService) clearInstallProgress(workspaceID string, appID string) {
	s.clearInstallJobProgress(workspaceID, appID)
	ctx := context.Background()
	app, err := s.workspaceAppProjectionForInstall(ctx, workspaceID, appID)
	if err != nil {
		return
	}
	if app.InstallProgress == nil {
		slog.Info(
			"workspace_app_install_progress_clear_skipped",
			"workspaceId", workspaceID,
			"appId", appID,
			"runtimeStatus", app.Runtime.Status,
			"reason", "projection_already_clean",
		)
		return
	}
	app.InstallProgress = nil
	publishedApp := s.publishAppIfChanged(ctx, workspaceID, appID, app)
	slog.Info(
		"workspace_app_install_progress_cleared",
		"workspaceId", workspaceID,
		"appId", appID,
		"runtimeStatus", publishedApp.Runtime.Status,
		"stateRevision", publishedApp.StateRevision,
	)
}

func shouldSkipInstallProgressPublish(status workspacebiz.AppRuntimeStatus, progress workspacebiz.AppInstallProgress) bool {
	return status == workspacebiz.AppRuntimeStatusRunning &&
		progress.UserPhase == workspacebiz.AppInstallUserPhaseStarting
}

func (s *AppCenterService) registerActiveInstallTracker(workspaceID string, appID string, tracker *installProgressTracker) {
	key := appRuntimeKey(workspaceID, appID)
	s.installMu.Lock()
	defer s.installMu.Unlock()
	if s.activeInstallTrackers == nil {
		s.activeInstallTrackers = make(map[string]*installProgressTracker)
	}
	s.activeInstallTrackers[key] = tracker
}

func (s *AppCenterService) unregisterActiveInstallTracker(workspaceID string, appID string) {
	key := appRuntimeKey(workspaceID, appID)
	s.installMu.Lock()
	defer s.installMu.Unlock()
	delete(s.activeInstallTrackers, key)
}

func (s *AppCenterService) activeInstallTracker(workspaceID string, appID string) *installProgressTracker {
	key := appRuntimeKey(workspaceID, appID)
	s.installMu.Lock()
	defer s.installMu.Unlock()
	return s.activeInstallTrackers[key]
}

func (s *AppCenterService) syncInstallProgressFromRuntimeStatus(workspaceID string, appID string, status workspacebiz.AppRuntimeStatus) {
	tracker := s.activeInstallTracker(workspaceID, appID)
	if tracker == nil {
		return
	}
	switch status {
	case workspacebiz.AppRuntimeStatusPreparing:
		tracker.advanceInstalling(0.45)
	case workspacebiz.AppRuntimeStatusStarting:
		tracker.finishInstalling()
		tracker.advanceStarting(0.6)
		tracker.publish(true)
	case workspacebiz.AppRuntimeStatusRunning:
		tracker.finishInstalling()
		tracker.finishStarting()
	default:
		return
	}
}

func (s *AppCenterService) withActiveInstallJobProgress(app workspacebiz.WorkspaceApp, workspaceID string, appID string) workspacebiz.WorkspaceApp {
	job, ok := s.installJob(workspaceID, appID)
	if !ok ||
		job.Status != workspaceAppInstallJobInstalling ||
		job.Progress == nil ||
		!shouldAttachActiveInstallProgress(app.Runtime.Status) {
		return app
	}
	progressCopy := *job.Progress
	app.InstallProgress = &progressCopy
	return app
}

func shouldAttachActiveInstallProgress(status workspacebiz.AppRuntimeStatus) bool {
	return status == workspacebiz.AppRuntimeStatusPreparing ||
		status == workspacebiz.AppRuntimeStatusStarting
}
