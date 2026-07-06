package workspace

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	agentsessionstore "github.com/tutti-os/tutti/packages/agentactivity/daemon/activity"
	workspacefiles "github.com/tutti-os/tutti/packages/workspace/files"
	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
)

const (
	defaultFactoryAppVersion        = "0.1.0"
	defaultFactoryValidationTimeout = 45 * time.Second
	defaultFactoryPrepareTimeout    = 5 * time.Minute
	interruptedFactoryJobReason     = "App Factory job was interrupted because Tutti stopped before it finished."
	tuttiRuntimeManagedBlockBegin   = "<!-- BEGIN TUTTI-RUNTIME (auto-managed; do not edit) -->"
	tuttiRuntimeManagedBlockEnd     = "<!-- END TUTTI-RUNTIME -->"
)

var ErrInvalidAppFactoryJobState = errors.New("invalid app factory job state")

type AppFactoryService struct {
	Store                 workspacedata.AppFactoryStore
	AppStore              workspacedata.AppStore
	WorkspaceStore        workspacedata.CatalogStore
	WorkspaceRootResolver WorkspaceRootResolver
	AppCenter             *AppCenterService
	AgentSessionService   FactoryAgentSessionService
	AgentTargetStore      workspacedata.AgentTargetStore
	AgentMessageReader    agentservice.MessageReader
	AgentSessionReader    agentservice.SessionReader
	AgentSessionState     FactoryAgentSessionStateReporter
	Runner                *AppRunner
	StateDir              string
	Publisher             WorkspaceAppFactoryEventPublisher

	publishLocks keyedOperationLocks

	// liveTurnAgentSessions tracks, per agent session, whether the most
	// recently observed TurnLifecycle snapshot (see ObserveAgentSessionState)
	// reports a live turn. See agentSessionHasLiveTurn in
	// app_factory_agent_state.go for why this exists.
	liveTurnAgentSessions sync.Map
}

type keyedOperationLocks struct {
	mu    sync.Mutex
	locks map[string]*keyedOperationLock
}

type keyedOperationLock struct {
	mu   sync.Mutex
	refs int
}

func (l *keyedOperationLocks) Lock(key string) func() {
	l.mu.Lock()
	if l.locks == nil {
		l.locks = make(map[string]*keyedOperationLock)
	}
	lock := l.locks[key]
	if lock == nil {
		lock = &keyedOperationLock{}
		l.locks[key] = lock
	}
	lock.refs += 1
	l.mu.Unlock()

	lock.mu.Lock()
	return func() {
		lock.mu.Unlock()

		l.mu.Lock()
		lock.refs -= 1
		if lock.refs == 0 {
			delete(l.locks, key)
		}
		l.mu.Unlock()
	}
}

type FactoryAgentSessionService interface {
	Create(context.Context, string, agentservice.CreateSessionInput) (agentservice.Session, error)
	GetComposerOptions(context.Context, agentservice.ComposerOptionsInput) (agentservice.ComposerOptions, error)
	SendInput(context.Context, string, string, agentservice.SendInput) (agentservice.SendInputResult, error)
	Cancel(context.Context, string, string) (agentservice.CancelSessionResult, error)
}

type FactoryAgentSessionStateReporter interface {
	ReportSessionState(
		context.Context,
		agentsessionstore.ReportSessionStateInput,
	) (agentsessionstore.ReportSessionStateReply, error)
}

type WorkspaceAppFactoryEventPublisher interface {
	PublishWorkspaceAppFactoryJobUpdated(context.Context, string, workspacebiz.AppFactoryJob) error
}

type CreateAppFactoryJobInput struct {
	Prompt           string
	DisplayName      string
	Description      string
	AgentTargetID    string
	Model            string
	PermissionModeID string
	ReasoningEffort  string
}

type FixAppFactoryJobInput struct {
	Prompt string
}

type AppFactoryAgentTargetComposerOptionsInput struct {
	AgentTargetID string
	Locale        string
	Settings      agentservice.ComposerSettings
}

type resolvedAppFactoryAgentTarget struct {
	ID       string
	Provider string
}

func (s *AppFactoryService) resolveAgentTargetProvider(ctx context.Context, agentTargetID string) (resolvedAppFactoryAgentTarget, error) {
	agentTargetID = strings.TrimSpace(agentTargetID)
	if agentTargetID == "" {
		return resolvedAppFactoryAgentTarget{}, fmt.Errorf("%w: agent target id is required", agentservice.ErrInvalidArgument)
	}
	if s.AgentTargetStore == nil {
		return resolvedAppFactoryAgentTarget{}, fmt.Errorf("%w: agent target store is unavailable", agentservice.ErrInvalidArgument)
	}
	target, err := s.AgentTargetStore.GetAgentTarget(ctx, agentTargetID)
	if err != nil {
		if errors.Is(err, workspacedata.ErrAgentTargetNotFound) {
			return resolvedAppFactoryAgentTarget{}, fmt.Errorf("%w: agent target not found", agentservice.ErrInvalidArgument)
		}
		return resolvedAppFactoryAgentTarget{}, fmt.Errorf("get agent target: %w", err)
	}
	normalized, err := agenttargetbiz.NormalizeTarget(target)
	if err != nil {
		return resolvedAppFactoryAgentTarget{}, fmt.Errorf("%w: invalid agent target: %v", agentservice.ErrInvalidArgument, err)
	}
	if !normalized.Enabled {
		return resolvedAppFactoryAgentTarget{}, fmt.Errorf("%w: agent target is disabled", agentservice.ErrInvalidArgument)
	}
	if _, err := agenttargetbiz.RuntimeProviderTargetRef(normalized); err != nil {
		return resolvedAppFactoryAgentTarget{}, fmt.Errorf("%w: invalid agent target launch ref: %v", agentservice.ErrInvalidArgument, err)
	}
	return resolvedAppFactoryAgentTarget{ID: normalized.ID, Provider: normalized.Provider}, nil
}

func (s *AppFactoryService) List(ctx context.Context, workspaceID string) ([]workspacebiz.AppFactoryJob, error) {
	if _, err := s.workspaceSummary(ctx, workspaceID); err != nil {
		return nil, err
	}
	jobs, err := s.store().ListAppFactoryJobs(ctx, workspaceID)
	if err != nil {
		return nil, err
	}
	for index, job := range jobs {
		if !isActiveAppFactoryJobStatus(job.Status) &&
			!isRecoverablePreValidationAgentFailure(job) {
			continue
		}
		handled, reconcileErr := s.reconcileFromPersistedAgentSession(ctx, workspaceID, job)
		if reconcileErr != nil {
			return nil, reconcileErr
		}
		if !handled {
			continue
		}
		updated, getErr := s.store().GetAppFactoryJob(ctx, workspaceID, job.JobID)
		if getErr != nil {
			return nil, getErr
		}
		jobs[index] = updated
	}
	return jobs, nil
}

func (s *AppFactoryService) GetAgentTargetComposerOptions(ctx context.Context, workspaceID string, input AppFactoryAgentTargetComposerOptionsInput) (agentservice.ComposerOptions, error) {
	if _, err := s.workspaceSummary(ctx, workspaceID); err != nil {
		return agentservice.ComposerOptions{}, err
	}
	if s.AgentSessionService == nil {
		return agentservice.ComposerOptions{}, errors.New("agent session service is unavailable")
	}
	resolvedTarget, err := s.resolveAgentTargetProvider(ctx, input.AgentTargetID)
	if err != nil {
		return agentservice.ComposerOptions{}, err
	}
	cwd := s.appFactoryComposerDraftDir(workspaceID)
	if err := os.MkdirAll(cwd, 0o755); err != nil {
		return agentservice.ComposerOptions{}, fmt.Errorf("create app factory composer draft dir: %w", err)
	}
	includeCapabilityCatalog := false
	return s.AgentSessionService.GetComposerOptions(ctx, agentservice.ComposerOptionsInput{
		AgentTargetID:            resolvedTarget.ID,
		Cwd:                      cwd,
		IncludeCapabilityCatalog: &includeCapabilityCatalog,
		Locale:                   strings.TrimSpace(input.Locale),
		Provider:                 resolvedTarget.Provider,
		Settings:                 input.Settings,
		WorkspaceID:              strings.TrimSpace(workspaceID),
	})
}

func (s *AppFactoryService) ReconcileInterruptedJobs(ctx context.Context) (int, error) {
	if s.WorkspaceStore == nil {
		return 0, errors.New("workspace catalog store is not configured")
	}
	workspaces, err := s.WorkspaceStore.List(ctx)
	if err != nil {
		return 0, err
	}

	reconciled := 0
	for _, workspace := range workspaces {
		workspaceID := strings.TrimSpace(workspace.ID)
		if workspaceID == "" {
			continue
		}
		jobs, err := s.store().ListAppFactoryJobs(ctx, workspaceID)
		if err != nil {
			return reconciled, err
		}
		for _, job := range jobs {
			if !isActiveAppFactoryJobStatus(job.Status) &&
				!isRecoverablePreValidationAgentFailure(job) {
				continue
			}
			if handled, err := s.reconcileFromPersistedAgentSession(ctx, workspaceID, job); err != nil {
				return reconciled, err
			} else if handled {
				reconciled += 1
				continue
			}
			if isRecoverablePreValidationAgentFailure(job) {
				continue
			}
			job.Status = workspacebiz.AppFactoryJobStatusFailed
			job.FailureReason = interruptedFactoryJobReason
			if err := s.putAndPublish(ctx, job); err != nil {
				return reconciled, err
			}
			if err := s.failInterruptedAgentSession(ctx, job); err != nil {
				return reconciled, err
			}
			reconciled += 1
		}
	}
	return reconciled, nil
}

func (s *AppFactoryService) Get(ctx context.Context, workspaceID string, jobID string) (workspacebiz.AppFactoryJob, error) {
	if _, err := s.workspaceSummary(ctx, workspaceID); err != nil {
		return workspacebiz.AppFactoryJob{}, err
	}
	return s.store().GetAppFactoryJob(ctx, workspaceID, strings.TrimSpace(jobID))
}

func (s *AppFactoryService) Delete(ctx context.Context, workspaceID string, jobID string) error {
	job, err := s.Get(ctx, workspaceID, jobID)
	if err != nil {
		return err
	}
	if isActiveAppFactoryJobStatus(job.Status) {
		return fmt.Errorf("%w: active app factory jobs must be canceled before deletion", ErrInvalidAppFactoryJobState)
	}
	if err := s.removeFactoryJobFiles(job); err != nil {
		return err
	}
	return s.store().DeleteAppFactoryJob(ctx, job.WorkspaceID, job.JobID)
}

func (s *AppFactoryService) Create(ctx context.Context, workspaceID string, input CreateAppFactoryJobInput) (workspacebiz.AppFactoryJob, error) {
	workspace, err := s.workspaceSummary(ctx, workspaceID)
	if err != nil {
		return workspacebiz.AppFactoryJob{}, err
	}
	prompt := strings.TrimSpace(input.Prompt)
	if prompt == "" {
		return workspacebiz.AppFactoryJob{}, errors.New("app factory prompt is required")
	}
	displayName := strings.TrimSpace(input.DisplayName)
	if displayName == "" {
		return workspacebiz.AppFactoryJob{}, errors.New("app factory display name is required")
	}
	resolvedTarget, err := s.resolveAgentTargetProvider(ctx, input.AgentTargetID)
	if err != nil {
		return workspacebiz.AppFactoryJob{}, err
	}

	jobID := uuid.NewString()
	appID := "app_" + uuid.NewString()
	jobRoot := filepath.Join(s.stateDir(), "apps", "factory", "jobs", safeAppPathSegment(jobID))
	job := workspacebiz.AppFactoryJob{
		JobID:           jobID,
		WorkspaceID:     workspaceID,
		Status:          workspacebiz.AppFactoryJobStatusQueued,
		Prompt:          prompt,
		AppID:           appID,
		DisplayName:     displayName,
		Description:     strings.TrimSpace(input.Description),
		AgentTargetID:   resolvedTarget.ID,
		Provider:        resolvedTarget.Provider,
		Model:           strings.TrimSpace(input.Model),
		ReasoningEffort: strings.TrimSpace(input.ReasoningEffort),
		DraftDir:        filepath.Join(jobRoot, "draft"),
		RuntimeDir:      filepath.Join(jobRoot, "runtime"),
		DataDir:         filepath.Join(jobRoot, "data"),
		LogDir:          filepath.Join(jobRoot, "logs"),
	}
	if err := os.MkdirAll(appFactoryDraftPackageDir(job), 0o755); err != nil {
		return workspacebiz.AppFactoryJob{}, fmt.Errorf("create app factory draft package dir: %w", err)
	}
	if err := os.MkdirAll(job.LogDir, 0o755); err != nil {
		return workspacebiz.AppFactoryJob{}, fmt.Errorf("create app factory log dir: %w", err)
	}
	if err := s.putAndPublish(ctx, job); err != nil {
		return workspacebiz.AppFactoryJob{}, err
	}

	if s.AgentSessionService == nil {
		job.Status = workspacebiz.AppFactoryJobStatusFailed
		job.FailureReason = "agent session service is unavailable"
		_ = s.putAndPublish(ctx, job)
		return job, nil
	}

	agentSessionID := uuid.NewString()
	title := "Create App: " + strings.TrimSpace(job.DisplayName)
	cwd := job.DraftDir
	initialPrompt, err := s.buildGenerationPrompt(ctx, workspace, job)
	if err != nil {
		job.Status = workspacebiz.AppFactoryJobStatusFailed
		job.FailureReason = err.Error()
		_ = s.putAndPublish(ctx, job)
		return job, nil
	}
	appFactorySkill, err := appFactoryReferenceSkillBundle()
	if err != nil {
		job.Status = workspacebiz.AppFactoryJobStatusFailed
		job.FailureReason = err.Error()
		_ = s.putAndPublish(ctx, job)
		return job, nil
	}
	agentWorkspaceAppSkill, err := agentWorkspaceAppReferenceSkillBundle()
	if err != nil {
		job.Status = workspacebiz.AppFactoryJobStatusFailed
		job.FailureReason = err.Error()
		_ = s.putAndPublish(ctx, job)
		return job, nil
	}
	session, err := s.AgentSessionService.Create(ctx, workspaceID, agentservice.CreateSessionInput{
		AgentSessionID: agentSessionID,
		AgentTargetID:  job.AgentTargetID,
		Provider:       job.Provider,
		InitialContent: agentservice.TextPromptContent(initialPrompt),
		Title:          &title,
		Cwd:            &cwd,
		Model:          optionalStringPointer(strings.TrimSpace(job.Model)),
		PermissionModeID: optionalStringPointer(
			strings.TrimSpace(input.PermissionModeID),
		),
		ReasoningEffort: optionalStringPointer(
			strings.TrimSpace(job.ReasoningEffort),
		),
		ExtraSkills: []agentservice.SessionSkillBundle{appFactorySkill, agentWorkspaceAppSkill},
	})
	if err != nil {
		job.Status = workspacebiz.AppFactoryJobStatusFailed
		job.FailureReason = err.Error()
		_ = s.putAndPublish(ctx, job)
		return job, nil
	}
	job.AgentSessionID = session.ID
	job.Status = workspacebiz.AppFactoryJobStatusGenerating
	return s.putAndPublishReturn(ctx, job)
}

func (s *AppFactoryService) Cancel(ctx context.Context, workspaceID string, jobID string) (workspacebiz.AppFactoryJob, error) {
	job, err := s.Get(ctx, workspaceID, jobID)
	if err != nil {
		return workspacebiz.AppFactoryJob{}, err
	}
	if job.AgentSessionID != "" && s.AgentSessionService != nil {
		if _, err := s.AgentSessionService.Cancel(ctx, workspaceID, job.AgentSessionID); err != nil {
			slog.Warn("cancel app factory agent session failed", "workspaceId", workspaceID, "jobId", jobID, "error", err)
		}
	}
	job.Status = workspacebiz.AppFactoryJobStatusCanceled
	job.FailureReason = ""
	return s.putAndPublishReturn(ctx, job)
}

func (s *AppFactoryService) Fix(ctx context.Context, workspaceID string, jobID string, input FixAppFactoryJobInput) (workspacebiz.AppFactoryJob, error) {
	job, err := s.Get(ctx, workspaceID, jobID)
	if err != nil {
		return workspacebiz.AppFactoryJob{}, err
	}
	if !isFailedValidationAppFactoryJob(job) {
		return workspacebiz.AppFactoryJob{}, fmt.Errorf("%w: app factory jobs can only be fixed after validation failure", ErrInvalidAppFactoryJobState)
	}
	prompt := strings.TrimSpace(input.Prompt)
	if prompt == "" {
		return workspacebiz.AppFactoryJob{}, errors.New("app factory fix prompt is required")
	}
	if job.AgentSessionID == "" || s.AgentSessionService == nil {
		return workspacebiz.AppFactoryJob{}, errors.New("app factory job does not have an agent session")
	}
	if _, err := s.AgentSessionService.SendInput(ctx, workspaceID, job.AgentSessionID, agentservice.SendInput{
		Content:       agentservice.TextPromptContent(buildFactoryFixPrompt(prompt, job.FailureReason)),
		DisplayPrompt: prompt,
	}); err != nil {
		return workspacebiz.AppFactoryJob{}, err
	}
	job.Status = workspacebiz.AppFactoryJobStatusGenerating
	job.FailureReason = ""
	return s.putAndPublishReturn(ctx, job)
}

func (s *AppFactoryService) RetryValidation(ctx context.Context, workspaceID string, jobID string) (workspacebiz.AppFactoryJob, error) {
	job, err := s.Get(ctx, workspaceID, jobID)
	if err != nil {
		return workspacebiz.AppFactoryJob{}, err
	}
	if job.Status != workspacebiz.AppFactoryJobStatusFailed {
		return workspacebiz.AppFactoryJob{}, fmt.Errorf("%w: validation can only be retried after a failed job", ErrInvalidAppFactoryJobState)
	}
	if !isFailedValidationAppFactoryJob(job) {
		return workspacebiz.AppFactoryJob{}, fmt.Errorf("%w: validation can only be retried after validation failure", ErrInvalidAppFactoryJobState)
	}
	return s.runValidation(ctx, workspaceID, job)
}

func (s *AppFactoryService) PrepareModification(ctx context.Context, workspaceID string, jobID string) (workspacebiz.AppFactoryJob, error) {
	job, err := s.Get(ctx, workspaceID, jobID)
	if err != nil {
		return workspacebiz.AppFactoryJob{}, err
	}
	if !isPublishedAppFactoryJob(job) {
		return workspacebiz.AppFactoryJob{}, fmt.Errorf("%w: app factory modification requires a published job", ErrInvalidAppFactoryJobState)
	}

	appID := strings.TrimSpace(job.AppID)
	if appID == "" {
		return workspacebiz.AppFactoryJob{}, errors.New("published app factory job is missing app id")
	}
	appPackage, err := s.appStore().GetAppPackage(ctx, appID)
	if err != nil {
		return workspacebiz.AppFactoryJob{}, err
	}
	if strings.TrimSpace(appPackage.PackageDir) == "" {
		return workspacebiz.AppFactoryJob{}, errors.New("workspace app package directory is missing")
	}
	if err := resetFactoryJobWorkspaceFromPackage(job, appPackage.PackageDir); err != nil {
		return workspacebiz.AppFactoryJob{}, err
	}
	job.PackageDir = appPackage.PackageDir
	job.PublishedVersion = appPackage.Version
	job.Status = workspacebiz.AppFactoryJobStatusPublished
	job.FailureReason = ""
	job.ValidationResultJSON = ""
	return s.putAndPublishReturn(ctx, job)
}

func prepareAppFactoryJob(ctx context.Context, job workspacebiz.AppFactoryJob) error {
	draftPackageDir := appFactoryDraftPackageDir(job)
	if draftPackageDir == "" {
		return errors.New("app factory draft package directory is missing")
	}
	preparePath := filepath.Join(draftPackageDir, "prepare.sh")
	info, err := os.Stat(preparePath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("stat prepare.sh: %w", err)
	}
	if info.IsDir() {
		return errors.New("prepare.sh must be a file")
	}
	if info.Mode()&0o111 == 0 {
		return errors.New("prepare.sh must be executable")
	}

	runCtx, cancel := context.WithTimeout(ctx, defaultFactoryPrepareTimeout)
	defer cancel()
	logFile, err := os.OpenFile(filepath.Join(job.LogDir, "factory.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return fmt.Errorf("open factory log: %w", err)
	}
	defer logFile.Close()
	appRuntime, err := DefaultManagedAppRuntimeResolver{}.Resolve(runCtx)
	if err != nil {
		return fmt.Errorf("resolve managed app runtime: %w", err)
	}
	command := exec.CommandContext(runCtx, preparePath)
	command.Dir = draftPackageDir
	command.Stdout = logFile
	command.Stderr = logFile
	envOverrides := []string{
		"TUTTI_APP_ID=" + job.AppID,
		"TUTTI_APP_PACKAGE_DIR=" + draftPackageDir,
		"TUTTI_APP_RUNTIME_DIR=" + job.RuntimeDir,
		"TUTTI_APP_DATA_DIR=" + job.DataDir,
		"TUTTI_APP_LOG_DIR=" + job.LogDir,
		"TUTTI_APP_TOOLCHAIN_ROOT=" + tuttiAppToolchainRoot(),
	}
	envOverrides = append(envOverrides, appRuntime.EnvOverrides...)
	command.Env = workspaceAppProcessEnv(envOverrides...)
	if err := command.Run(); err != nil {
		return fmt.Errorf("run prepare.sh: %w", err)
	}
	return nil
}

func (s *AppFactoryService) validatePackage(ctx context.Context, workspaceID string, job workspacebiz.AppFactoryJob) error {
	draftPackageDir := appFactoryDraftPackageDir(job)
	if draftPackageDir == "" {
		return errors.New("app factory draft package directory is missing")
	}
	manifestPath := filepath.Join(draftPackageDir, "tutti.app.json")
	manifest, _, err := workspacebiz.ReadAppManifestFile(manifestPath)
	if err != nil {
		return err
	}
	if err := validateAppFactoryManifestMetadata(job, manifest); err != nil {
		return err
	}
	if existingPackage, err := s.appStore().GetAppPackage(ctx, manifest.AppID); err == nil {
		if !isAppFactoryRepublish(job, existingPackage) {
			return fmt.Errorf("workspace app id %q already exists", manifest.AppID)
		}
	} else if !errors.Is(err, workspacedata.ErrWorkspaceAppNotFound) {
		return err
	}

	bootstrapPath := filepath.Join(draftPackageDir, filepath.Clean(manifest.Runtime.Bootstrap))
	info, err := os.Stat(bootstrapPath)
	if err != nil {
		return fmt.Errorf("stat runtime bootstrap: %w", err)
	}
	if info.IsDir() {
		return errors.New("runtime bootstrap must be a file")
	}
	if info.Mode()&0o111 == 0 {
		return errors.New("runtime bootstrap must be executable")
	}

	agentsData, err := readCleanAppFactoryAgentsFile(job)
	if err != nil {
		return err
	}
	if strings.TrimSpace(agentsData) == "" {
		return errors.New("AGENTS.md must be non-empty")
	}

	workspace, err := s.workspaceSummary(ctx, workspaceID)
	if err != nil {
		return err
	}
	workspaceRoot, _ := s.workspaceRoot(ctx, workspaceID)
	factoryWorkspaceID := "factory:" + job.JobID
	state, err := s.runner().Start(ctx, AppStartInput{
		WorkspaceID:     factoryWorkspaceID,
		WorkspaceName:   workspace.Name,
		WorkspaceRoot:   workspaceRoot.PhysicalRoot,
		AppID:           manifest.AppID,
		PackageDir:      draftPackageDir,
		Bootstrap:       manifest.Runtime.Bootstrap,
		HealthcheckPath: manifest.Runtime.HealthcheckPath,
		RuntimeProfile:  strings.TrimSpace(manifest.Runtime.Profile),
		RuntimeDir:      job.RuntimeDir,
		DataDir:         job.DataDir,
		LogDir:          job.LogDir,
	})
	if err != nil {
		return err
	}
	if state.Status == workspacebiz.AppRuntimeStatusFailed {
		return runtimeStateError(state)
	}
	defer func() {
		_, _ = s.runner().Stop(context.Background(), factoryWorkspaceID, manifest.AppID)
	}()

	deadline := time.Now().Add(defaultFactoryValidationTimeout)
	for {
		current := s.runner().State(factoryWorkspaceID, manifest.AppID)
		switch current.Status {
		case workspacebiz.AppRuntimeStatusRunning:
			return nil
		case workspacebiz.AppRuntimeStatusFailed:
			return runtimeStateError(current)
		}
		if time.Now().After(deadline) {
			return errors.New("app factory validation timed out waiting for healthcheck")
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
}

func (s *AppFactoryService) failInterruptedAgentSession(ctx context.Context, job workspacebiz.AppFactoryJob) error {
	if s == nil || s.AgentSessionState == nil {
		return nil
	}
	agentSessionID := strings.TrimSpace(job.AgentSessionID)
	if agentSessionID == "" {
		return nil
	}
	now := unixMsNow()
	_, err := s.AgentSessionState.ReportSessionState(ctx, agentsessionstore.ReportSessionStateInput{
		WorkspaceID:    strings.TrimSpace(job.WorkspaceID),
		AgentSessionID: agentSessionID,
		SessionOrigin:  agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		State: agentsessionstore.WorkspaceAgentSessionStateUpdate{
			AgentTargetID:    strings.TrimSpace(job.AgentTargetID),
			Provider:         strings.TrimSpace(job.Provider),
			Title:            "Create App: " + strings.TrimSpace(job.DisplayName),
			LifecycleStatus:  "failed",
			CurrentPhase:     "idle",
			LastError:        interruptedFactoryJobReason,
			OccurredAtUnixMS: now,
			EndedAtUnixMS:    now,
		},
	})
	return err
}

func (s *AppFactoryService) removeFactoryJobFiles(job workspacebiz.AppFactoryJob) error {
	jobRoot := appFactoryJobRoot(s.stateDir(), job)
	if jobRoot == "" {
		return nil
	}
	if err := os.RemoveAll(jobRoot); err != nil {
		return fmt.Errorf("remove app factory job files: %w", err)
	}
	return nil
}

func appFactoryJobRoot(stateDir string, job workspacebiz.AppFactoryJob) string {
	draftDir := filepath.Clean(strings.TrimSpace(job.DraftDir))
	if draftDir == "." || filepath.Base(draftDir) != "draft" {
		return ""
	}
	jobRoot := filepath.Dir(draftDir)
	expectedRoot := filepath.Clean(filepath.Join(
		stateDir,
		"apps",
		"factory",
		"jobs",
		safeAppPathSegment(job.JobID),
	))
	if jobRoot != expectedRoot {
		return ""
	}
	return jobRoot
}

func resetFactoryJobWorkspaceFromPackage(job workspacebiz.AppFactoryJob, packageDir string) error {
	draftDir := strings.TrimSpace(job.DraftDir)
	if draftDir == "" {
		return errors.New("app factory draft directory is missing")
	}
	packageDir = strings.TrimSpace(packageDir)
	if packageDir == "" {
		return errors.New("workspace app package directory is missing")
	}
	info, err := os.Stat(packageDir)
	if err != nil {
		return fmt.Errorf("stat workspace app package directory: %w", err)
	}
	if !info.IsDir() {
		return errors.New("workspace app package directory must be a directory")
	}

	for _, dir := range []string{job.DraftDir, job.RuntimeDir, job.DataDir} {
		dir = strings.TrimSpace(dir)
		if dir == "" {
			continue
		}
		if err := os.RemoveAll(dir); err != nil {
			return fmt.Errorf("reset app factory working dir: %w", err)
		}
	}
	if err := os.MkdirAll(filepath.Dir(draftDir), 0o755); err != nil {
		return fmt.Errorf("create app factory job dir: %w", err)
	}
	draftPackageDir := appFactoryDraftPackageDir(job)
	if err := os.MkdirAll(filepath.Dir(draftPackageDir), 0o755); err != nil {
		return fmt.Errorf("create app factory draft dir: %w", err)
	}
	if err := copyDirectory(packageDir, draftPackageDir); err != nil {
		return fmt.Errorf("copy published app package to factory draft: %w", err)
	}
	if strings.TrimSpace(job.LogDir) != "" {
		if err := os.MkdirAll(job.LogDir, 0o755); err != nil {
			return fmt.Errorf("create app factory log dir: %w", err)
		}
	}
	return nil
}

func readCleanAppFactoryAgentsFile(job workspacebiz.AppFactoryJob) (string, error) {
	draftPackageDir := appFactoryDraftPackageDir(job)
	if draftPackageDir == "" {
		return "", errors.New("app factory draft package directory is missing")
	}
	path := filepath.Join(draftPackageDir, "AGENTS.md")
	data, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read AGENTS.md: %w", err)
	}
	cleaned := stripTuttiRuntimeManagedBlock(string(data))
	if cleaned != string(data) {
		if err := os.WriteFile(path, []byte(cleaned), 0o644); err != nil {
			return "", fmt.Errorf("clean AGENTS.md runtime instructions: %w", err)
		}
	}
	return cleaned, nil
}

func stripTuttiRuntimeManagedBlock(value string) string {
	for {
		begin := strings.Index(value, tuttiRuntimeManagedBlockBegin)
		if begin < 0 {
			return strings.TrimSpace(value)
		}
		endSearchStart := begin + len(tuttiRuntimeManagedBlockBegin)
		end := strings.Index(value[endSearchStart:], tuttiRuntimeManagedBlockEnd)
		if end < 0 {
			return strings.TrimSpace(value)
		}
		end += endSearchStart + len(tuttiRuntimeManagedBlockEnd)
		value = value[:begin] + value[end:]
	}
}

func (s *AppFactoryService) putAndPublishReturn(ctx context.Context, job workspacebiz.AppFactoryJob) (workspacebiz.AppFactoryJob, error) {
	if err := s.putAndPublish(ctx, job); err != nil {
		return workspacebiz.AppFactoryJob{}, err
	}
	return s.store().GetAppFactoryJob(ctx, job.WorkspaceID, job.JobID)
}

func (s *AppFactoryService) putAndPublish(ctx context.Context, job workspacebiz.AppFactoryJob) error {
	job.UpdatedAtUnixMs = unixMsNow()
	if job.CreatedAtUnixMs == 0 {
		job.CreatedAtUnixMs = job.UpdatedAtUnixMs
	}
	if err := s.store().PutAppFactoryJob(ctx, job); err != nil {
		return err
	}
	logAppFactoryJobStatePersisted(job)
	if s.Publisher != nil {
		if err := s.Publisher.PublishWorkspaceAppFactoryJobUpdated(ctx, job.WorkspaceID, job); err != nil {
			slog.Warn("workspace app factory job event publish failed", "workspaceId", job.WorkspaceID, "jobId", job.JobID, "error", err)
		}
	}
	return nil
}

func logAppFactoryJobStatePersisted(job workspacebiz.AppFactoryJob) {
	slog.Info(
		"workspace_app_factory_job_state_persisted",
		"workspaceId", job.WorkspaceID,
		"jobId", job.JobID,
		"appId", job.AppID,
		"displayName", job.DisplayName,
		"agentTargetId", job.AgentTargetID,
		"provider", job.Provider,
		"model", job.Model,
		"status", job.Status,
		"publishedVersion", job.PublishedVersion,
		"failureReason", job.FailureReason,
		"validationHasResult", strings.TrimSpace(job.ValidationResultJSON) != "",
		"promptLength", len(job.Prompt),
	)
}

func (s *AppFactoryService) workspaceSummary(ctx context.Context, workspaceID string) (workspacebiz.Summary, error) {
	if s.WorkspaceStore == nil {
		return workspacebiz.Summary{}, errors.New("workspace catalog store is not configured")
	}
	workspaceID = strings.TrimSpace(workspaceID)
	if workspaceID == "" {
		return workspacebiz.Summary{}, errors.New("workspace id is required")
	}
	return s.WorkspaceStore.Get(ctx, workspaceID)
}

func (s *AppFactoryService) workspaceRoot(ctx context.Context, workspaceID string) (workspacefiles.WorkspaceRoot, error) {
	if s.WorkspaceRootResolver == nil {
		return workspacefiles.WorkspaceRoot{}, nil
	}
	return s.WorkspaceRootResolver.ResolveWorkspaceRoot(ctx, workspaceID)
}

func (s *AppFactoryService) store() workspacedata.AppFactoryStore {
	return s.Store
}

func (s *AppFactoryService) appStore() workspacedata.AppStore {
	return s.AppStore
}

func (s *AppFactoryService) appCenter() *AppCenterService {
	return s.AppCenter
}

func (s *AppFactoryService) runner() *AppRunner {
	if s.Runner == nil {
		s.Runner = &AppRunner{}
	}
	return s.Runner
}

func (s *AppFactoryService) stateDir() string {
	if strings.TrimSpace(s.StateDir) != "" {
		return s.StateDir
	}
	if value := strings.TrimSpace(os.Getenv("TUTTI_STATE_DIR")); value != "" {
		return value
	}
	return tuttitypes.DefaultStateDir()
}

func (s *AppFactoryService) appFactoryComposerDraftDir(workspaceID string) string {
	return filepath.Join(
		s.stateDir(),
		"apps",
		"factory",
		"composer",
		safeAppPathSegment(workspaceID),
		"draft",
	)
}
