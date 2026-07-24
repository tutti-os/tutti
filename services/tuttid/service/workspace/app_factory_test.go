package workspace

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
	workspacefiles "github.com/tutti-os/tutti/packages/workspace/files"
	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
	builtinapps "github.com/tutti-os/tutti/services/tuttid/builtin-apps"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
)

type appFactoryStoreStub struct {
	jobs map[string]workspacebiz.AppFactoryJob
}

type workspaceAppFactoryPublisherStub struct {
	published  []workspacebiz.AppFactoryJob
	workspaces []string
}

type appFactoryAgentTargetStoreStub struct {
	targets map[string]agenttargetbiz.Target
}

type factoryAgentSessionServiceStub struct {
	createdWorkspaceID string
	createInput        agentservice.CreateSessionInput
	composerInput      agentservice.ComposerOptionsInput
	sendInput          agentservice.SendInput
	canceledSessionID  string
}

type factoryAgentSessionStateReporterStub struct {
	reports []canonical.ReportSessionStateInput
}

type factoryAgentSessionReaderStub struct {
	sessions    map[string]agentservice.PersistedSession
	latestTurns map[string]agentactivitybiz.Turn
}

func (s factoryAgentSessionReaderStub) ListLatestTurns(_ context.Context, workspaceID string, agentSessionIDs []string) (map[string]agentactivitybiz.Turn, error) {
	result := make(map[string]agentactivitybiz.Turn)
	for _, sessionID := range agentSessionIDs {
		if turn, ok := s.latestTurns[appFactoryJobStoreKey(workspaceID, sessionID)]; ok {
			result[sessionID] = turn
		}
	}
	return result, nil
}

type factoryAgentMessageReaderStub struct {
	pages map[string]agentservice.SessionMessagesPage
}

type workspaceRootResolverStub struct {
	root workspacefiles.WorkspaceRoot
}

func (s *factoryAgentSessionStateReporterStub) ReportSessionState(_ context.Context, input canonical.ReportSessionStateInput) (canonical.ReportSessionStateReply, error) {
	s.reports = append(s.reports, input)
	return canonical.ReportSessionStateReply{Accepted: true, StateApplied: true}, nil
}

func (s factoryAgentSessionReaderStub) GetSession(workspaceID string, agentSessionID string) (agentservice.PersistedSession, bool) {
	session, ok := s.sessions[appFactoryJobStoreKey(workspaceID, agentSessionID)]
	return session, ok
}

func (s factoryAgentSessionReaderStub) ListSessions(workspaceID string) ([]agentservice.PersistedSession, bool) {
	var result []agentservice.PersistedSession
	for _, session := range s.sessions {
		if session.WorkspaceID == workspaceID {
			result = append(result, session)
		}
	}
	return result, true
}

func (factoryAgentSessionReaderStub) SessionDeleted(context.Context, string, string) (bool, error) {
	return false, nil
}

func (s factoryAgentMessageReaderStub) ListSessionMessages(input agentactivitybiz.ListSessionMessagesInput) (agentservice.SessionMessagesPage, bool) {
	page, ok := s.pages[appFactoryJobStoreKey(input.WorkspaceID, input.AgentSessionID)]
	return page, ok
}

func newAppFactoryAgentTargetStoreStub() appFactoryAgentTargetStoreStub {
	targets := make(map[string]agenttargetbiz.Target)
	for _, target := range agenttargetbiz.DefaultSystemTargets(1) {
		targets[target.ID] = target
	}
	return appFactoryAgentTargetStoreStub{targets: targets}
}

func (s appFactoryAgentTargetStoreStub) GetAgentTarget(_ context.Context, id string) (agenttargetbiz.Target, error) {
	target, ok := s.targets[strings.TrimSpace(id)]
	if !ok {
		return agenttargetbiz.Target{}, workspacedata.ErrAgentTargetNotFound
	}
	return target, nil
}

func (s appFactoryAgentTargetStoreStub) ListAgentTargets(context.Context) ([]agenttargetbiz.Target, error) {
	targets := make([]agenttargetbiz.Target, 0, len(s.targets))
	for _, target := range s.targets {
		targets = append(targets, target)
	}
	return targets, nil
}

func (appFactoryAgentTargetStoreStub) PutAgentTarget(_ context.Context, target agenttargetbiz.Target) (agenttargetbiz.Target, error) {
	return target, nil
}

func (appFactoryAgentTargetStoreStub) DeleteAgentTarget(context.Context, string) error {
	return nil
}

func newAppFactoryStoreStub() *appFactoryStoreStub {
	return &appFactoryStoreStub{
		jobs: make(map[string]workspacebiz.AppFactoryJob),
	}
}

func (s *appFactoryStoreStub) DeleteAppFactoryJob(_ context.Context, workspaceID string, jobID string) error {
	key := appFactoryJobStoreKey(workspaceID, jobID)
	if _, ok := s.jobs[key]; !ok {
		return workspacedata.ErrWorkspaceAppFactoryJobNotFound
	}
	delete(s.jobs, key)
	return nil
}

func (s *appFactoryStoreStub) GetAppFactoryJob(_ context.Context, workspaceID string, jobID string) (workspacebiz.AppFactoryJob, error) {
	job, ok := s.jobs[appFactoryJobStoreKey(workspaceID, jobID)]
	if !ok {
		return workspacebiz.AppFactoryJob{}, workspacedata.ErrWorkspaceAppFactoryJobNotFound
	}
	return job, nil
}

func (s *appFactoryStoreStub) ListAppFactoryJobs(_ context.Context, workspaceID string) ([]workspacebiz.AppFactoryJob, error) {
	var result []workspacebiz.AppFactoryJob
	for _, job := range s.jobs {
		if job.WorkspaceID == workspaceID {
			result = append(result, job)
		}
	}
	return result, nil
}

func (s *appFactoryStoreStub) PutAppFactoryJob(_ context.Context, job workspacebiz.AppFactoryJob) error {
	if strings.TrimSpace(job.WorkspaceID) == "" || strings.TrimSpace(job.JobID) == "" {
		return errors.New("workspace id and job id are required")
	}
	s.jobs[appFactoryJobStoreKey(job.WorkspaceID, job.JobID)] = job
	return nil
}

func (s *workspaceAppFactoryPublisherStub) PublishWorkspaceAppFactoryJobUpdated(_ context.Context, workspaceID string, job workspacebiz.AppFactoryJob) error {
	s.workspaces = append(s.workspaces, workspaceID)
	s.published = append(s.published, job)
	return nil
}

func (s *factoryAgentSessionServiceStub) Create(_ context.Context, workspaceID string, input agentservice.CreateSessionInput) (agentservice.Session, error) {
	s.createdWorkspaceID = workspaceID
	s.createInput = input
	return agentservice.Session{ID: input.AgentSessionID, Provider: input.Provider}, nil
}

func (s *factoryAgentSessionServiceStub) GetComposerOptions(_ context.Context, input agentservice.ComposerOptionsInput) (agentservice.ComposerOptions, error) {
	s.composerInput = input
	return agentservice.ComposerOptions{
		Provider: input.Provider,
		EffectiveSettings: agentservice.ComposerSettings{
			Model:            input.Settings.Model,
			PermissionModeID: input.Settings.PermissionModeID,
			ReasoningEffort:  input.Settings.ReasoningEffort,
		},
	}, nil
}

func (s *factoryAgentSessionServiceStub) SendInput(_ context.Context, _ string, _ string, input agentservice.SendInput) (agentservice.SendInputResult, error) {
	s.sendInput = input
	return agentservice.SendInputResult{}, nil
}

func (s *factoryAgentSessionServiceStub) CancelTurn(_ context.Context, _ string, sessionID string, _ string) (agentservice.CancelTurnResult, error) {
	s.canceledSessionID = sessionID
	return agentservice.CancelTurnResult{Canceled: true, Reason: agentservice.CancelTurnReasonTurnCanceled}, nil
}

func (s workspaceRootResolverStub) ResolveWorkspaceRoot(context.Context, string) (workspacefiles.WorkspaceRoot, error) {
	return s.root, nil
}

func TestAppFactoryServiceGetAgentTargetComposerOptionsUsesFactoryDraftContext(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	stateDir := t.TempDir()
	sessions := &factoryAgentSessionServiceStub{}
	service := AppFactoryService{
		AgentSessionService: sessions,
		AgentTargetStore:    newAppFactoryAgentTargetStoreStub(),
		StateDir:            stateDir,
		WorkspaceStore: &catalogStoreStub{
			getWorkspace: workspacebiz.Summary{ID: "ws-1", Name: "Workspace"},
		},
	}

	options, err := service.GetAgentTargetComposerOptions(ctx, "ws-1", AppFactoryAgentTargetComposerOptionsInput{
		AgentTargetID: agenttargetbiz.IDLocalClaudeCode,
		Locale:        "zh-CN",
		Settings: agentservice.ComposerSettings{
			Model:            "sonnet",
			PermissionModeID: "default",
			ReasoningEffort:  "high",
		},
	})
	if err != nil {
		t.Fatalf("GetAgentTargetComposerOptions() error = %v", err)
	}

	expectedCwd := filepath.Join(stateDir, "apps", "factory", "composer", "ws-1", "draft")
	if sessions.composerInput.Cwd != expectedCwd {
		t.Fatalf("composer cwd = %q, want %q", sessions.composerInput.Cwd, expectedCwd)
	}
	if _, err := os.Stat(expectedCwd); err != nil {
		t.Fatalf("composer cwd missing: %v", err)
	}
	if sessions.composerInput.WorkspaceID != "ws-1" {
		t.Fatalf("composer workspace = %q, want ws-1", sessions.composerInput.WorkspaceID)
	}
	if sessions.composerInput.Provider != "claude-code" {
		t.Fatalf("composer provider = %q, want claude-code", sessions.composerInput.Provider)
	}
	if sessions.composerInput.AgentTargetID != agenttargetbiz.IDLocalClaudeCode {
		t.Fatalf("composer agentTargetId = %q, want %q", sessions.composerInput.AgentTargetID, agenttargetbiz.IDLocalClaudeCode)
	}
	if sessions.composerInput.Locale != "zh-CN" {
		t.Fatalf("composer locale = %q, want zh-CN", sessions.composerInput.Locale)
	}
	if sessions.composerInput.IncludeCapabilityCatalog == nil || *sessions.composerInput.IncludeCapabilityCatalog {
		t.Fatalf("composer includeCapabilityCatalog = %v, want false", sessions.composerInput.IncludeCapabilityCatalog)
	}
	if options.EffectiveSettings.Model != "sonnet" {
		t.Fatalf("composer options model = %q, want sonnet", options.EffectiveSettings.Model)
	}
}

func TestAppFactoryServiceCreateUsesDraftDirAndReferenceContext(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	stateDir := t.TempDir()
	store := newAppFactoryStoreStub()
	sessions := &factoryAgentSessionServiceStub{}
	service := AppFactoryService{
		Store:               store,
		AgentSessionService: sessions,
		AgentTargetStore:    newAppFactoryAgentTargetStoreStub(),
		StateDir:            stateDir,
		WorkspaceRootResolver: workspaceRootResolverStub{root: workspacefiles.WorkspaceRoot{
			LogicalRoot:  "/workspace",
			PhysicalRoot: "/Users/example",
		}},
		WorkspaceStore: &catalogStoreStub{
			getWorkspace: workspacebiz.Summary{ID: "ws-1", Name: "Workspace"},
		},
	}

	job, err := service.Create(ctx, "ws-1", CreateAppFactoryJobInput{
		AgentTargetID:    agenttargetbiz.IDLocalCodex,
		DisplayName:      "Weather Watch",
		Model:            "gpt-5",
		PermissionModeID: "auto",
		Prompt:           "Create a weather app.",
		ReasoningEffort:  "high",
	})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if job.Status != workspacebiz.AppFactoryJobStatusGenerating {
		t.Fatalf("status = %q, want generating", job.Status)
	}
	if sessions.createInput.Cwd == nil || *sessions.createInput.Cwd != job.DraftDir {
		t.Fatalf("CreateSession cwd = %v, want %q", sessions.createInput.Cwd, job.DraftDir)
	}
	if sessions.createInput.AgentTargetID != agenttargetbiz.IDLocalCodex {
		t.Fatalf("CreateSession agentTargetId = %q, want %q", sessions.createInput.AgentTargetID, agenttargetbiz.IDLocalCodex)
	}
	if job.ReasoningEffort != "high" {
		t.Fatalf("job reasoningEffort = %q, want high", job.ReasoningEffort)
	}
	if sessions.createInput.Model == nil || *sessions.createInput.Model != "gpt-5" {
		t.Fatalf("CreateSession model = %v, want gpt-5", sessions.createInput.Model)
	}
	if sessions.createInput.PermissionModeID == nil || *sessions.createInput.PermissionModeID != "auto" {
		t.Fatalf("CreateSession permissionModeId = %v, want auto", sessions.createInput.PermissionModeID)
	}
	if sessions.createInput.ReasoningEffort == nil || *sessions.createInput.ReasoningEffort != "high" {
		t.Fatalf("CreateSession reasoning = %v, want high", sessions.createInput.ReasoningEffort)
	}
	if len(sessions.createInput.ExtraSkills) != 2 {
		t.Fatalf("CreateSession extra skills = %#v, want app factory and agent workspace app skills", sessions.createInput.ExtraSkills)
	}
	appFactorySkill := sessions.createInput.ExtraSkills[0]
	if appFactorySkill.Name != "app-factory" {
		t.Fatalf("CreateSession extra skill name = %q, want app-factory", appFactorySkill.Name)
	}
	if !strings.Contains(appFactorySkill.Files["SKILL.md"], "mention://workspace-app-factory/create") {
		t.Fatalf("app factory skill missing mention contract: %q", appFactorySkill.Files["SKILL.md"])
	}
	if !strings.Contains(appFactorySkill.Files["SKILL.md"], "simple-node-static-app") {
		t.Fatalf("app factory skill should point complete package examples at the Node demo:\n%s", appFactorySkill.Files["SKILL.md"])
	}
	if strings.Contains(appFactorySkill.Files["SKILL.md"], "simple-python-static-app") {
		t.Fatalf("app factory skill should not point new package examples at the Python demo:\n%s", appFactorySkill.Files["SKILL.md"])
	}
	if _, ok := appFactorySkill.Files["references/manifest-contract.md"]; !ok {
		t.Fatalf("app factory skill missing manifest reference: %#v", appFactorySkill.Files)
	}
	runtimeEnvReference := appFactorySkill.Files["references/runtime-env.md"]
	if !strings.Contains(runtimeEnvReference, "@tutti-os/agent-acp-kit/tutti") {
		t.Fatalf("runtime env reference should route Agent provider choices through the kit facade:\n%s", runtimeEnvReference)
	}
	for _, want := range []string{
		"TUTTI_API_BASE_URL",
		"TUTTI_APP_SERVER_TOKEN",
		"TUTTI_WORKSPACE_ID",
		"Never send it to browser code",
	} {
		if !strings.Contains(runtimeEnvReference, want) {
			t.Fatalf("runtime env reference missing %q:\n%s", want, runtimeEnvReference)
		}
	}
	tuttiCLIReference := appFactorySkill.Files["references/tutti-cli-commands.md"]
	if !strings.Contains(tuttiCLIReference, "@tutti-os/agent-acp-kit") {
		t.Fatalf("tutti CLI reference should point agent execution to agent-acp-kit:\n%s", tuttiCLIReference)
	}
	if strings.Contains(tuttiCLIReference, "node:child_process") {
		t.Fatalf("tutti CLI reference should not lead with child_process examples:\n%s", tuttiCLIReference)
	}
	agentWorkspaceAppSkill := sessions.createInput.ExtraSkills[1]
	if agentWorkspaceAppSkill.Name != "tutti-agent-workspace-app" {
		t.Fatalf("CreateSession second extra skill name = %q, want tutti-agent-workspace-app", agentWorkspaceAppSkill.Name)
	}
	if !strings.Contains(agentWorkspaceAppSkill.Files["SKILL.md"], "@tutti-os/agent-acp-kit") {
		t.Fatalf("agent workspace app skill missing agent-acp-kit guidance: %q", agentWorkspaceAppSkill.Files["SKILL.md"])
	}
	agentACPReference, ok := agentWorkspaceAppSkill.Files["references/agent-acp-kit.md"]
	if !ok {
		t.Fatalf("agent workspace app skill missing agent-acp-kit reference: %#v", agentWorkspaceAppSkill.Files)
	}
	dynamicProviderReference, ok := agentWorkspaceAppSkill.Files["references/dynamic-agent-providers.md"]
	if !ok {
		t.Fatalf("agent workspace app skill missing dynamic-agent-providers reference: %#v", agentWorkspaceAppSkill.Files)
	}
	for _, want := range []string{
		"kit owns provider plugins",
		"agents[].id",
		"dynamic-agent-providers.md",
		"loadTuttiAgentCatalog",
		"loadTuttiAgentComposerOptions",
		"loadTuttiAgentSkillContext",
		"Do not pass a mode",
		"await createManagedAgentRunContextFromHeaders",
		"browserUse",
		"computerUse",
		"do **not** install a tool",
		"Omit the fields when the capability is unavailable",
	} {
		if !strings.Contains(agentACPReference, want) {
			t.Fatalf("agent-acp-kit reference missing %q:\n%s", want, agentACPReference)
		}
	}
	for _, forbidden := range []string{
		"toKitAgentProviderId",
		"toDaemonAgentProviderId",
		"getManagedAgentInvocationCredentialFromHeaders",
		"isManagedAgentInvocationProviderId",
		"managedCredential &&",
		"agent-providers/status",
		"TUTTI_APP_SERVER_TOKEN",
		"appPolicyAllowsBrowser",
		"appPolicyAllowsComputer",
	} {
		if strings.Contains(agentACPReference, forbidden) {
			t.Fatalf("agent-acp-kit reference contains obsolete guidance %q:\n%s", forbidden, agentACPReference)
		}
	}
	for _, want := range []string{
		"loadTuttiAgentCatalog",
		"loadTuttiAgentComposerOptions",
		"source: \"standalone\"",
		"TuttiIntegrationError",
		"availability.reasonCode",
		"kit_runtime_unavailable",
		"@tutti-os/agent-acp-kit/tutti/contracts",
		"tutti --json agent list",
		"agentTargetId",
		"may be shared by several agents",
		"do not reconstruct it from a provider name",
	} {
		if !strings.Contains(dynamicProviderReference, want) {
			t.Fatalf("dynamic provider reference missing %q:\n%s", want, dynamicProviderReference)
		}
	}
	for _, forbidden := range []string{
		"TuttiAppAgentCatalogClient",
		"toKitAgentProviderId",
		"toDaemonAgentProviderId",
		"agent-providers/status",
		"TUTTI_APP_SERVER_TOKEN",
		"nexight: \"tutti-agent\"",
		"`nexight` and `tutti-agent` remain distinct",
	} {
		if strings.Contains(dynamicProviderReference, forbidden) {
			t.Fatalf("dynamic provider reference contains obsolete guidance %q:\n%s", forbidden, dynamicProviderReference)
		}
	}
	releaseReference := agentWorkspaceAppSkill.Files["references/github-actions-release.md"]
	for _, want := range []string{
		"agent catalog schema version 1",
		"agent-id composer and skill context",
		"without publishing a new release",
		"When `min_tutti_version` is greater than `0.0.0`",
	} {
		if !strings.Contains(releaseReference, want) {
			t.Fatalf("release reference missing %q:\n%s", want, releaseReference)
		}
	}
	if strings.Contains(releaseReference, "existing latest release") {
		t.Fatalf("release reference should not describe catalog-only as publishing latest:\n%s", releaseReference)
	}
	if strings.Contains(agentACPReference, `command: "pnpm"`) {
		t.Fatalf("agent-acp-kit reference should not use bare pnpm in packaged MCP examples:\n%s", agentACPReference)
	}
	packageBuilderReference := agentWorkspaceAppSkill.Files["references/package-builder.md"]
	if strings.Contains(packageBuilderReference, `TUTTI_APP_PORT:-`) {
		t.Fatalf("package builder bootstrap example should not provide a fallback app port:\n%s", packageBuilderReference)
	}
	if strings.Contains(packageBuilderReference, `TUTTI_APP_NODE:-node`) {
		t.Fatalf("package builder bootstrap example should not fall back to bare node:\n%s", packageBuilderReference)
	}
	if !strings.HasPrefix(job.DraftDir, filepath.Join(stateDir, "apps", "factory", "jobs")) {
		t.Fatalf("draft dir = %q, want under factory job state", job.DraftDir)
	}
	if _, err := os.Stat(appFactoryDraftPackageDir(job)); err != nil {
		t.Fatalf("draft package dir missing: %v", err)
	}
	if len(sessions.createInput.InitialContent) != 1 {
		t.Fatalf("initial content = %#v, want one text block", sessions.createInput.InitialContent)
	}
	prompt := sessions.createInput.InitialContent[0].Text
	if !strings.HasPrefix(prompt, "[@Create App](mention://workspace-app-factory/create)") {
		t.Fatalf("initial prompt should begin with factory mention:\n%s", prompt)
	}
	if !strings.Contains(prompt, ") Create a weather app.") {
		t.Fatalf("initial prompt should append the user request after the mention on the same line:\n%s", prompt)
	}
	if strings.Contains(prompt, "\n") {
		t.Fatalf("initial prompt should stay on one line:\n%s", prompt)
	}
	if strings.Contains(prompt, "<tutti_app_factory_context>") {
		t.Fatalf("initial prompt should not inline factory context:\n%s", prompt)
	}
	for _, forbidden := range []string{
		"Create this Tutti workspace app from the user request below.",
		"User request:",
		"Factory context:",
		"App Factory Context",
	} {
		if strings.Contains(prompt, forbidden) {
			t.Fatalf("initial prompt should not include wrapper text %q:\n%s", forbidden, prompt)
		}
	}
	if !strings.Contains(prompt, "[@Create App](mention://workspace-app-factory/create)") {
		t.Fatalf("initial prompt missing factory mention:\n%s", prompt)
	}
	for _, forbidden := range []string{
		"action=create",
		"contextPath=",
		"jobId=",
		"workspaceId=",
		"mention://workspace-app-factory?",
	} {
		if strings.Contains(prompt, forbidden) {
			t.Fatalf("initial prompt should not include factory mention query %q:\n%s", forbidden, prompt)
		}
	}

	contextData, err := os.ReadFile(filepath.Join(job.DraftDir, filepath.FromSlash(appFactoryMentionContextRelativePath)))
	if err != nil {
		t.Fatalf("read app factory mention context: %v", err)
	}
	var mentionContext appFactoryMentionContext
	if err := json.Unmarshal(contextData, &mentionContext); err != nil {
		t.Fatalf("unmarshal app factory mention context: %v\n%s", err, string(contextData))
	}
	if mentionContext.Action != "create" {
		t.Fatalf("context action = %q, want create", mentionContext.Action)
	}
	if mentionContext.Task != "Create a Tutti workspace app package under the output packageRoot directory." {
		t.Fatalf("context task = %q", mentionContext.Task)
	}
	if mentionContext.Output.PackageRoot != appFactoryPackageRootRelativePath {
		t.Fatalf("context output packageRoot = %q", mentionContext.Output.PackageRoot)
	}
	if mentionContext.UserRequest != "Create a weather app." {
		t.Fatalf("context userRequest = %q", mentionContext.UserRequest)
	}
	var rawMentionContext map[string]any
	if err := json.Unmarshal(contextData, &rawMentionContext); err != nil {
		t.Fatalf("unmarshal raw app factory mention context: %v\n%s", err, string(contextData))
	}
	if _, ok := rawMentionContext["reference"]; ok {
		t.Fatalf("context should not expose reference cache paths:\n%s", string(contextData))
	}
	if mentionContext.Metadata.AppID != job.AppID {
		t.Fatalf("context appId = %q, want %q", mentionContext.Metadata.AppID, job.AppID)
	}
	if mentionContext.Metadata.Version != defaultFactoryAppVersion {
		t.Fatalf("context version = %q, want %q", mentionContext.Metadata.Version, defaultFactoryAppVersion)
	}
	if mentionContext.Metadata.DisplayName != "Weather Watch" {
		t.Fatalf("context displayName = %q, want Weather Watch", mentionContext.Metadata.DisplayName)
	}
	if mentionContext.Metadata.Description.Exact {
		t.Fatalf("context description exact = true, want generated instruction")
	}
	if !strings.Contains(mentionContext.Metadata.Description.Instruction, "Generate a concise, natural, user-facing one-sentence description") {
		t.Fatalf("context description instruction = %q", mentionContext.Metadata.Description.Instruction)
	}
	if strings.Contains(mentionContext.Metadata.Description.Instruction, "description: "+quoteFactoryPromptContextValue("Create a weather app.")) {
		t.Fatalf("context reused user request as description:\n%s", string(contextData))
	}
	if strings.Contains(mentionContext.Metadata.Description.Instruction, quoteFactoryPromptContextValue("Weather Watch workspace app.")) &&
		!strings.Contains(mentionContext.Metadata.Description.Instruction, "Do not use generic placeholder wording") {
		t.Fatalf("context used placeholder description:\n%s", string(contextData))
	}
	if mentionContext.Workspace.ID != "ws-1" || mentionContext.Workspace.Name != "Workspace" || mentionContext.Workspace.PhysicalRoot != "/Users/example" {
		t.Fatalf("context workspace = %#v", mentionContext.Workspace)
	}
	if !mentionContext.Workspace.FilesReadonlyByDefault {
		t.Fatalf("context workspace files should be readonly by default")
	}
	constraints := strings.Join(mentionContext.Constraints, "\n")
	if len(mentionContext.Constraints) == 0 || !strings.Contains(constraints, "Do not assume hidden Tutti daemon internals") {
		t.Fatalf("context constraints = %#v", mentionContext.Constraints)
	}
	if !strings.Contains(strings.Join(mentionContext.Constraints, "\n"), "overflow") {
		t.Fatalf("context constraints should include overflow prevention: %#v", mentionContext.Constraints)
	}
	for _, want := range []string{
		"Default new apps to a Node server",
		"@tutti-os/agent-acp-kit",
		"raw TUTTI_CLI agent commands or session polling",
		"current Tutti Agent Target catalog",
		"exact agent ids as selection identity",
		"dynamic-agent-providers.md",
	} {
		if !strings.Contains(constraints, want) {
			t.Fatalf("context constraints missing %q: %#v", want, mentionContext.Constraints)
		}
	}
	if strings.Contains(constraints, "AI-generated user-facing content") {
		t.Fatalf("context constraints should not force non-agent AI integrations onto agent-acp-kit: %#v", mentionContext.Constraints)
	}

	secondJob, err := service.Create(ctx, "ws-1", CreateAppFactoryJobInput{
		AgentTargetID: agenttargetbiz.IDLocalCodex,
		DisplayName:   "Second App",
		Prompt:        "Create another app.",
	})
	if err != nil {
		t.Fatalf("Create(second) error = %v", err)
	}
	if secondJob.DraftDir == job.DraftDir {
		t.Fatalf("second draft dir reused first draft dir %q", job.DraftDir)
	}
}

func TestAppFactoryServiceCreateLaunchesSessionsWithAgentTargetID(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name          string
		agentTargetID string
		wantProvider  string
	}{
		{
			name:          "codex",
			agentTargetID: agenttargetbiz.IDLocalCodex,
			wantProvider:  "codex",
		},
		{
			name:          "claude code",
			agentTargetID: agenttargetbiz.IDLocalClaudeCode,
			wantProvider:  "claude-code",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			sessions := &factoryAgentSessionServiceStub{}
			service := AppFactoryService{
				Store:               newAppFactoryStoreStub(),
				AgentSessionService: sessions,
				AgentTargetStore:    newAppFactoryAgentTargetStoreStub(),
				StateDir:            t.TempDir(),
				WorkspaceRootResolver: workspaceRootResolverStub{root: workspacefiles.WorkspaceRoot{
					LogicalRoot:  "/workspace",
					PhysicalRoot: "/Users/example",
				}},
				WorkspaceStore: &catalogStoreStub{
					getWorkspace: workspacebiz.Summary{ID: "ws-1", Name: "Workspace"},
				},
			}

			job, err := service.Create(context.Background(), "ws-1", CreateAppFactoryJobInput{
				AgentTargetID: tt.agentTargetID,
				DisplayName:   "Target App",
				Prompt:        "Create an app.",
			})
			if err != nil {
				t.Fatalf("Create() error = %v", err)
			}
			if job.Status != workspacebiz.AppFactoryJobStatusGenerating {
				t.Fatalf("status = %q, want generating", job.Status)
			}
			if sessions.createInput.AgentTargetID != tt.agentTargetID {
				t.Fatalf("CreateSession agentTargetId = %q, want %q", sessions.createInput.AgentTargetID, tt.agentTargetID)
			}
			if sessions.createInput.Provider != tt.wantProvider {
				t.Fatalf("CreateSession provider = %q, want %q", sessions.createInput.Provider, tt.wantProvider)
			}
		})
	}
}

func TestAppFactoryServiceCreateRequiresDisplayName(t *testing.T) {
	t.Parallel()

	service := AppFactoryService{
		WorkspaceStore: &catalogStoreStub{
			getWorkspace: workspacebiz.Summary{ID: "ws-1", Name: "Workspace"},
		},
	}

	_, err := service.Create(context.Background(), "ws-1", CreateAppFactoryJobInput{
		Prompt: "Build a lightweight todo tracker.",
	})
	if err == nil || !strings.Contains(err.Error(), "app factory display name is required") {
		t.Fatalf("Create() error = %v, want display name required", err)
	}
}

func TestValidateAppFactoryManifestMetadataRejectsModelDrift(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name      string
		job       workspacebiz.AppFactoryJob
		manifest  workspacebiz.AppManifest
		wantError string
	}{
		{
			name: "accepts requested name and generated description",
			job: workspacebiz.AppFactoryJob{
				AppID:       "app_1",
				DisplayName: "Todo Tracker",
			},
			manifest: appFactoryManifestForMetadataTest("app_1", "0.1.0", "Todo Tracker", "Track lightweight workspace todos."),
		},
		{
			name: "rejects changed app id",
			job: workspacebiz.AppFactoryJob{
				AppID:       "app_1",
				DisplayName: "Todo Tracker",
			},
			manifest:  appFactoryManifestForMetadataTest("app_2", "0.1.0", "Todo Tracker", "Track lightweight workspace todos."),
			wantError: `app manifest appId must be the generated id "app_1"`,
		},
		{
			name: "rejects changed version",
			job: workspacebiz.AppFactoryJob{
				AppID:       "app_1",
				DisplayName: "Todo Tracker",
			},
			manifest:  appFactoryManifestForMetadataTest("app_1", "0.2.0", "Todo Tracker", "Track lightweight workspace todos."),
			wantError: `app manifest version must be "0.1.0"`,
		},
		{
			name: "rejects missing requested display name",
			job: workspacebiz.AppFactoryJob{
				AppID: "app_1",
			},
			manifest:  appFactoryManifestForMetadataTest("app_1", "0.1.0", "Todo Tracker", "Track lightweight workspace todos."),
			wantError: "app factory display name is required",
		},
		{
			name: "rejects generic generated description",
			job: workspacebiz.AppFactoryJob{
				AppID:       "app_1",
				DisplayName: "Todo Tracker",
			},
			manifest:  appFactoryManifestForMetadataTest("app_1", "0.1.0", "Todo Tracker", "Todo Tracker workspace app."),
			wantError: "app manifest description must be a generated user-facing description",
		},
		{
			name: "rejects changed requested display name",
			job: workspacebiz.AppFactoryJob{
				AppID:       "app_1",
				DisplayName: "Weather Watch",
			},
			manifest:  appFactoryManifestForMetadataTest("app_1", "0.1.0", "Weather Station", "Track lightweight workspace todos."),
			wantError: `app manifest name must match requested display name "Weather Watch"`,
		},
		{
			name: "rejects changed requested description",
			job: workspacebiz.AppFactoryJob{
				AppID:       "app_1",
				DisplayName: "Weather Watch",
				Description: "Shows the current weather.",
			},
			manifest:  appFactoryManifestForMetadataTest("app_1", "0.1.0", "Weather Watch", "Track lightweight workspace todos."),
			wantError: `app manifest description must match requested description "Shows the current weather."`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			err := validateAppFactoryManifestMetadata(tt.job, tt.manifest)
			if tt.wantError == "" {
				if err != nil {
					t.Fatalf("validateAppFactoryManifestMetadata() error = %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tt.wantError) {
				t.Fatalf("validateAppFactoryManifestMetadata() error = %v, want %q", err, tt.wantError)
			}
		})
	}
}

func TestAppFactoryServiceReconcileInterruptedJobsMarksActiveJobsFailed(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := newAppFactoryStoreStub()
	for _, job := range []workspacebiz.AppFactoryJob{
		{WorkspaceID: "ws-1", JobID: "queued", Status: workspacebiz.AppFactoryJobStatusQueued},
		{WorkspaceID: "ws-1", JobID: "generating", Status: workspacebiz.AppFactoryJobStatusGenerating, AgentSessionID: "agent-generating", Provider: "codex"},
		{WorkspaceID: "ws-1", JobID: "preparing", Status: workspacebiz.AppFactoryJobStatusPreparing},
		{WorkspaceID: "ws-1", JobID: "validating", Status: workspacebiz.AppFactoryJobStatusValidating},
		{WorkspaceID: "ws-1", JobID: "ready", Status: workspacebiz.AppFactoryJobStatusReady},
		{WorkspaceID: "ws-1", JobID: "failed", Status: workspacebiz.AppFactoryJobStatusFailed, FailureReason: "already failed"},
		{WorkspaceID: "ws-1", JobID: "failed-interrupted", Status: workspacebiz.AppFactoryJobStatusFailed, AgentSessionID: "agent-failed-interrupted", FailureReason: interruptedFactoryJobReason},
	} {
		if err := store.PutAppFactoryJob(ctx, job); err != nil {
			t.Fatalf("PutAppFactoryJob(%s) error = %v", job.JobID, err)
		}
	}
	publisher := &workspaceAppFactoryPublisherStub{}
	agentState := &factoryAgentSessionStateReporterStub{}
	service := AppFactoryService{
		Store: store,
		WorkspaceStore: &catalogStoreStub{
			listWorkspaces: []workspacebiz.Summary{{ID: "ws-1", Name: "Workspace"}},
		},
		AgentSessionState: agentState,
		Publisher:         publisher,
	}

	reconciled, err := service.ReconcileInterruptedJobs(ctx)
	if err != nil {
		t.Fatalf("ReconcileInterruptedJobs() error = %v", err)
	}
	if reconciled != 4 {
		t.Fatalf("reconciled = %d, want 4", reconciled)
	}
	for _, jobID := range []string{"queued", "generating", "preparing", "validating"} {
		job, err := store.GetAppFactoryJob(ctx, "ws-1", jobID)
		if err != nil {
			t.Fatalf("GetAppFactoryJob(%s) error = %v", jobID, err)
		}
		if job.Status != workspacebiz.AppFactoryJobStatusFailed || job.FailureReason != interruptedFactoryJobReason {
			t.Fatalf("job %s = status %q reason %q", jobID, job.Status, job.FailureReason)
		}
	}
	ready, err := store.GetAppFactoryJob(ctx, "ws-1", "ready")
	if err != nil {
		t.Fatalf("GetAppFactoryJob(ready) error = %v", err)
	}
	if ready.Status != workspacebiz.AppFactoryJobStatusReady || ready.FailureReason != "" {
		t.Fatalf("ready job changed: %#v", ready)
	}
	failed, err := store.GetAppFactoryJob(ctx, "ws-1", "failed")
	if err != nil {
		t.Fatalf("GetAppFactoryJob(failed) error = %v", err)
	}
	if failed.Status != workspacebiz.AppFactoryJobStatusFailed || failed.FailureReason != "already failed" {
		t.Fatalf("failed job changed: %#v", failed)
	}
	if len(publisher.published) != 4 {
		t.Fatalf("published updates = %d, want 4", len(publisher.published))
	}
	interruptedFailed, err := store.GetAppFactoryJob(ctx, "ws-1", "failed-interrupted")
	if err != nil {
		t.Fatalf("GetAppFactoryJob(failed-interrupted) error = %v", err)
	}
	if interruptedFailed.Status != workspacebiz.AppFactoryJobStatusFailed ||
		interruptedFailed.FailureReason != interruptedFactoryJobReason {
		t.Fatalf("failed-interrupted job changed: %#v", interruptedFailed)
	}
	if len(agentState.reports) != 0 {
		t.Fatalf("agent state reports = %d, want no synthetic lifecycle patch", len(agentState.reports))
	}
}

func TestPrepareAppFactoryJobInjectsToolchainRoot(t *testing.T) {
	ctx := context.Background()
	stateDir := t.TempDir()
	draftDir := filepath.Join(stateDir, "apps", "factory", "jobs", "job-1", "draft")
	packageDir := filepath.Join(draftDir, appFactoryPackageRootRelativePath)
	runtimeDir := filepath.Join(stateDir, "apps", "factory", "jobs", "job-1", "runtime")
	dataDir := filepath.Join(stateDir, "apps", "factory", "jobs", "job-1", "data")
	logDir := filepath.Join(stateDir, "apps", "factory", "jobs", "job-1", "logs")
	for _, dir := range []string{packageDir, runtimeDir, dataDir, logDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("create %s: %v", dir, err)
		}
	}
	t.Setenv("TUTTI_STATE_DIR", stateDir)
	t.Setenv(tuttiAppRuntimeRootEnv, createManagedAppRuntimeFixture(t, stateDir))

	preparePath := filepath.Join(packageDir, "prepare.sh")
	if err := os.WriteFile(preparePath, []byte(`#!/bin/sh
printf '%s\n' "$TUTTI_APP_TOOLCHAIN_ROOT" > "$TUTTI_APP_DATA_DIR/toolchain-root.txt"
`), 0o755); err != nil {
		t.Fatalf("write prepare.sh: %v", err)
	}

	err := prepareAppFactoryJob(ctx, workspacebiz.AppFactoryJob{
		AppID:      "app_1",
		DraftDir:   draftDir,
		RuntimeDir: runtimeDir,
		DataDir:    dataDir,
		LogDir:     logDir,
	})
	if err != nil {
		t.Fatalf("prepareAppFactoryJob() error = %v", err)
	}
	data, err := os.ReadFile(filepath.Join(dataDir, "toolchain-root.txt"))
	if err != nil {
		t.Fatalf("read toolchain root probe: %v", err)
	}
	want := filepath.Join(stateDir, "app-toolchains") + "\n"
	if string(data) != want {
		t.Fatalf("toolchain root = %q, want %q", data, want)
	}
}

func TestAppFactoryServiceReconcileIdleCompletedAgentSessionKeepsGenerating(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := newAppFactoryStoreStub()
	draftDir := t.TempDir()
	if err := store.PutAppFactoryJob(ctx, workspacebiz.AppFactoryJob{
		AgentSessionID: "session-1",
		AppID:          "app_1",
		DraftDir:       draftDir,
		JobID:          "job-1",
		Status:         workspacebiz.AppFactoryJobStatusGenerating,
		WorkspaceID:    "ws-1",
	}); err != nil {
		t.Fatalf("PutAppFactoryJob() error = %v", err)
	}
	service := AppFactoryService{
		Store:    store,
		AppStore: newAppStoreStub(),
		WorkspaceStore: &catalogStoreStub{
			listWorkspaces: []workspacebiz.Summary{{ID: "ws-1", Name: "Workspace"}},
		},
		AgentSessionReader: factoryAgentSessionReaderStub{
			sessions: map[string]agentservice.PersistedSession{
				appFactoryJobStoreKey("ws-1", "session-1"): {
					ID:           "session-1",
					WorkspaceID:  "ws-1",
					ActiveTurnID: "turn-1",
				},
			},
		},
		AgentMessageReader: factoryAgentMessageReaderStub{
			pages: map[string]agentservice.SessionMessagesPage{
				appFactoryJobStoreKey("ws-1", "session-1"): {
					AgentSessionID: "session-1",
					Messages: []agentservice.SessionMessage{
						{
							AgentSessionID: "session-1",
							Kind:           "text",
							Role:           "assistant",
							Status:         "completed",
							Version:        1,
						},
					},
				},
			},
		},
	}

	reconciled, err := service.ReconcileInterruptedJobs(ctx)
	if err != nil {
		t.Fatalf("ReconcileInterruptedJobs() error = %v", err)
	}
	if reconciled != 1 {
		t.Fatalf("reconciled = %d, want 1", reconciled)
	}
	job, err := store.GetAppFactoryJob(ctx, "ws-1", "job-1")
	if err != nil {
		t.Fatalf("GetAppFactoryJob() error = %v", err)
	}
	if job.Status != workspacebiz.AppFactoryJobStatusGenerating {
		t.Fatalf("status = %q, want generating", job.Status)
	}
	if strings.TrimSpace(job.ValidationResultJSON) != "" {
		t.Fatalf("validation result = %q, want empty", job.ValidationResultJSON)
	}
}

func TestAppFactoryServiceReconcileRecoversPreValidationFailure(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := newAppFactoryStoreStub()
	draftDir := t.TempDir()
	if err := store.PutAppFactoryJob(ctx, workspacebiz.AppFactoryJob{
		AgentSessionID: "session-1",
		AppID:          "app_1",
		DraftDir:       draftDir,
		FailureReason:  "App Factory agent session failed before validation.",
		JobID:          "job-1",
		Status:         workspacebiz.AppFactoryJobStatusFailed,
		WorkspaceID:    "ws-1",
	}); err != nil {
		t.Fatalf("PutAppFactoryJob() error = %v", err)
	}
	service := AppFactoryService{
		Store:    store,
		AppStore: newAppStoreStub(),
		WorkspaceStore: &catalogStoreStub{
			listWorkspaces: []workspacebiz.Summary{{ID: "ws-1", Name: "Workspace"}},
		},
		AgentSessionReader: factoryAgentSessionReaderStub{
			sessions: map[string]agentservice.PersistedSession{
				appFactoryJobStoreKey("ws-1", "session-1"): {
					ID:          "session-1",
					WorkspaceID: "ws-1",
				},
			},
			latestTurns: map[string]agentactivitybiz.Turn{
				appFactoryJobStoreKey("ws-1", "session-1"): {TurnID: "turn-1", Phase: "settled", Outcome: "completed"},
			},
		},
		AgentMessageReader: factoryAgentMessageReaderStub{
			pages: map[string]agentservice.SessionMessagesPage{
				appFactoryJobStoreKey("ws-1", "session-1"): {
					AgentSessionID: "session-1",
					Messages: []agentservice.SessionMessage{
						{
							AgentSessionID: "session-1",
							Kind:           "text",
							Role:           "assistant",
							Status:         "completed",
							Version:        1,
						},
					},
				},
			},
		},
	}

	reconciled, err := service.ReconcileInterruptedJobs(ctx)
	if err != nil {
		t.Fatalf("ReconcileInterruptedJobs() error = %v", err)
	}
	if reconciled != 1 {
		t.Fatalf("reconciled = %d, want 1", reconciled)
	}
	job, err := store.GetAppFactoryJob(ctx, "ws-1", "job-1")
	if err != nil {
		t.Fatalf("GetAppFactoryJob() error = %v", err)
	}
	if job.Status != workspacebiz.AppFactoryJobStatusFailed {
		t.Fatalf("status = %q, want failed validation", job.Status)
	}
	if strings.TrimSpace(job.ValidationResultJSON) == "" {
		t.Fatal("validation result is empty, want validation to be retried")
	}
	if job.FailureReason == "App Factory agent session failed before validation." {
		t.Fatalf("failure reason was not replaced after reconcile: %q", job.FailureReason)
	}
}

func TestAppFactoryValidationRejectsAgentsFileWithOnlyRuntimeManagedBlock(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	draftDir := t.TempDir()
	packageDir := filepath.Join(draftDir, appFactoryPackageRootRelativePath)
	appID := "app_test-agents-cleanup"
	if err := os.MkdirAll(packageDir, 0o755); err != nil {
		t.Fatalf("create package dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(packageDir, "tutti.app.json"), []byte(`{
  "schemaVersion": "tutti.app.manifest.v1",
  "appId": "`+appID+`",
  "version": "0.1.0",
  "name": "Test App",
  "description": "Test app",
  "runtime": {
    "bootstrap": "bootstrap.sh",
    "healthcheckPath": "/healthz"
  }
}`), 0o644); err != nil {
		t.Fatalf("write manifest: %v", err)
	}
	if err := os.WriteFile(filepath.Join(packageDir, "bootstrap.sh"), []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatalf("write bootstrap: %v", err)
	}
	managedOnly := tuttiRuntimeManagedBlockBegin + "\n# Tutti Runtime\n" + tuttiRuntimeManagedBlockEnd + "\n"
	if err := os.WriteFile(filepath.Join(packageDir, "AGENTS.md"), []byte(managedOnly), 0o644); err != nil {
		t.Fatalf("write AGENTS.md: %v", err)
	}
	service := AppFactoryService{
		AppStore: newAppStoreStub(),
	}

	err := service.validatePackage(ctx, "ws-1", workspacebiz.AppFactoryJob{
		AppID:       appID,
		DisplayName: "Test App",
		DraftDir:    draftDir,
	})
	if err == nil || !strings.Contains(err.Error(), "AGENTS.md must be non-empty") {
		t.Fatalf("validatePackage() error = %v, want AGENTS.md non-empty error", err)
	}
	content, readErr := os.ReadFile(filepath.Join(packageDir, "AGENTS.md"))
	if readErr != nil {
		t.Fatalf("read cleaned AGENTS.md: %v", readErr)
	}
	if strings.Contains(string(content), "TUTTI-RUNTIME") {
		t.Fatalf("runtime managed block was not removed: %q", string(content))
	}
}

func TestAppFactoryServicePublishMarksMissingAgentsFileAsValidationFailure(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	draftDir := t.TempDir()
	packageDir := filepath.Join(draftDir, appFactoryPackageRootRelativePath)
	if err := os.MkdirAll(packageDir, 0o755); err != nil {
		t.Fatalf("create package dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(packageDir, "tutti.app.json"), []byte(`{
  "schemaVersion": "tutti.app.manifest.v1",
  "appId": "app_missing-agents",
  "version": "0.1.0",
  "name": "Missing Agents",
  "description": "Missing agents test app",
  "runtime": {
    "bootstrap": "bootstrap.sh",
    "healthcheckPath": "/healthz"
  }
}`), 0o644); err != nil {
		t.Fatalf("write manifest: %v", err)
	}
	if err := os.WriteFile(filepath.Join(packageDir, "bootstrap.sh"), []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatalf("write bootstrap: %v", err)
	}
	store := newAppFactoryStoreStub()
	if err := store.PutAppFactoryJob(ctx, workspacebiz.AppFactoryJob{
		AppID:       "app_missing-agents",
		DisplayName: "Missing Agents",
		DraftDir:    draftDir,
		JobID:       "job-1",
		Status:      workspacebiz.AppFactoryJobStatusReady,
		WorkspaceID: "ws-1",
	}); err != nil {
		t.Fatalf("PutAppFactoryJob() error = %v", err)
	}
	publisher := &workspaceAppFactoryPublisherStub{}
	service := AppFactoryService{
		Store:          store,
		AppStore:       newAppStoreStub(),
		Publisher:      publisher,
		WorkspaceStore: &catalogStoreStub{getWorkspace: workspacebiz.Summary{ID: "ws-1", Name: "Workspace"}},
	}

	if _, _, err := service.Publish(ctx, "ws-1", "job-1"); err == nil || !strings.Contains(err.Error(), "read AGENTS.md") {
		t.Fatalf("Publish() error = %v, want read AGENTS.md error", err)
	}
	job, err := store.GetAppFactoryJob(ctx, "ws-1", "job-1")
	if err != nil {
		t.Fatalf("GetAppFactoryJob() error = %v", err)
	}
	if job.Status != workspacebiz.AppFactoryJobStatusFailed {
		t.Fatalf("status = %q, want failed", job.Status)
	}
	if !strings.Contains(job.FailureReason, "read AGENTS.md") {
		t.Fatalf("failure reason = %q, want AGENTS.md error", job.FailureReason)
	}
	var result workspacebiz.AppFactoryValidationResult
	if err := json.Unmarshal([]byte(job.ValidationResultJSON), &result); err != nil {
		t.Fatalf("unmarshal validation result: %v", err)
	}
	if result.OK || len(result.Errors) != 1 || !strings.Contains(result.Errors[0], "read AGENTS.md") {
		t.Fatalf("validation result = %#v, want one AGENTS.md error", result)
	}
	if len(publisher.published) != 1 {
		t.Fatalf("published updates = %d, want failure update", len(publisher.published))
	}
}

func TestCopyDirectoryCopiesManyFilesWithoutAccumulatingDescriptors(t *testing.T) {
	t.Parallel()

	sourceDir := t.TempDir()
	targetDir := t.TempDir()
	for index := range 1500 {
		path := filepath.Join(sourceDir, "files", strconv.Itoa(index)+".txt")
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatalf("create source parent: %v", err)
		}
		if err := os.WriteFile(path, []byte("file "+strconv.Itoa(index)), 0o644); err != nil {
			t.Fatalf("write source file: %v", err)
		}
	}

	if err := copyDirectory(sourceDir, targetDir); err != nil {
		t.Fatalf("copyDirectory() error = %v", err)
	}

	for _, index := range []int{0, 1499} {
		path := filepath.Join(targetDir, "files", strconv.Itoa(index)+".txt")
		content, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read copied file: %v", err)
		}
		if string(content) != "file "+strconv.Itoa(index) {
			t.Fatalf("copied file %d = %q", index, string(content))
		}
	}
}

func TestAppFactoryDraftChangedComparesPublishedPackageFiles(t *testing.T) {
	t.Parallel()

	draftDir := t.TempDir()
	draftPackageDir := filepath.Join(draftDir, appFactoryPackageRootRelativePath)
	packageDir := t.TempDir()
	for _, root := range []string{draftPackageDir, packageDir} {
		if err := os.MkdirAll(root, 0o755); err != nil {
			t.Fatalf("create package root: %v", err)
		}
		if err := os.WriteFile(filepath.Join(root, "app.js"), []byte("app"), 0o644); err != nil {
			t.Fatalf("write app file: %v", err)
		}
		if err := os.WriteFile(filepath.Join(root, "bootstrap.sh"), []byte("#!/bin/sh\n"), 0o755); err != nil {
			t.Fatalf("write bootstrap: %v", err)
		}
	}
	if err := os.WriteFile(filepath.Join(draftDir, "context.json"), []byte("{}"), 0o644); err != nil {
		t.Fatalf("write context file: %v", err)
	}

	changed, err := appFactoryDraftChanged(workspacebiz.AppFactoryJob{
		DraftDir:   draftDir,
		PackageDir: packageDir,
	})
	if err != nil {
		t.Fatalf("appFactoryDraftChanged() error = %v", err)
	}
	if changed {
		t.Fatal("appFactoryDraftChanged() = true, want false for equivalent package files")
	}

	if err := os.WriteFile(filepath.Join(draftPackageDir, "app.js"), []byte("changed"), 0o644); err != nil {
		t.Fatalf("write changed app file: %v", err)
	}
	changed, err = appFactoryDraftChanged(workspacebiz.AppFactoryJob{
		DraftDir:   draftDir,
		PackageDir: packageDir,
	})
	if err != nil {
		t.Fatalf("appFactoryDraftChanged() after edit error = %v", err)
	}
	if !changed {
		t.Fatal("appFactoryDraftChanged() = false, want true after draft edit")
	}
}

func TestAppFactoryServiceRetryValidationRejectsActiveJob(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := newAppFactoryStoreStub()
	if err := store.PutAppFactoryJob(ctx, workspacebiz.AppFactoryJob{
		WorkspaceID: "ws-1",
		JobID:       "job-1",
		Status:      workspacebiz.AppFactoryJobStatusGenerating,
	}); err != nil {
		t.Fatalf("PutAppFactoryJob() error = %v", err)
	}
	service := AppFactoryService{
		Store: store,
		WorkspaceStore: &catalogStoreStub{
			getWorkspace: workspacebiz.Summary{ID: "ws-1", Name: "Workspace"},
		},
	}

	if _, err := service.RetryValidation(ctx, "ws-1", "job-1"); err == nil {
		t.Fatal("RetryValidation() error = nil, want error")
	}
	job, err := store.GetAppFactoryJob(ctx, "ws-1", "job-1")
	if err != nil {
		t.Fatalf("GetAppFactoryJob() error = %v", err)
	}
	if job.Status != workspacebiz.AppFactoryJobStatusGenerating {
		t.Fatalf("status = %q, want generating", job.Status)
	}
}

func TestAppFactoryServiceCompletedAgentSessionStartsValidation(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := newAppFactoryStoreStub()
	draftDir := t.TempDir()
	if err := store.PutAppFactoryJob(ctx, workspacebiz.AppFactoryJob{
		AgentSessionID: "session-1",
		AppID:          "app_1",
		DraftDir:       draftDir,
		JobID:          "job-1",
		Status:         workspacebiz.AppFactoryJobStatusGenerating,
		WorkspaceID:    "ws-1",
	}); err != nil {
		t.Fatalf("PutAppFactoryJob() error = %v", err)
	}
	publisher := &workspaceAppFactoryPublisherStub{}
	service := AppFactoryService{
		Store:     store,
		AppStore:  newAppStoreStub(),
		Publisher: publisher,
	}

	if err := service.handleAgentSessionTerminalState(ctx, "ws-1", "session-1", "completed", ""); err != nil {
		t.Fatalf("handleAgentSessionTerminalState() error = %v", err)
	}
	job, err := store.GetAppFactoryJob(ctx, "ws-1", "job-1")
	if err != nil {
		t.Fatalf("GetAppFactoryJob() error = %v", err)
	}
	if job.Status != workspacebiz.AppFactoryJobStatusFailed {
		t.Fatalf("status = %q, want failed", job.Status)
	}
	if strings.TrimSpace(job.ValidationResultJSON) == "" {
		t.Fatal("validation result is empty, want failed validation result")
	}
	if len(publisher.published) < 2 {
		t.Fatalf("published updates = %d, want preparing and failed updates", len(publisher.published))
	}
}

func TestAppFactoryServiceCompletedPublishedAgentSessionStartsRepublishValidation(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := newAppFactoryStoreStub()
	draftDir := t.TempDir()
	if err := store.PutAppFactoryJob(ctx, workspacebiz.AppFactoryJob{
		AgentSessionID:   "session-1",
		AppID:            "app_1",
		DraftDir:         draftDir,
		JobID:            "job-1",
		PublishedVersion: "0.1.0",
		Status:           workspacebiz.AppFactoryJobStatusPublished,
		WorkspaceID:      "ws-1",
	}); err != nil {
		t.Fatalf("PutAppFactoryJob() error = %v", err)
	}
	publisher := &workspaceAppFactoryPublisherStub{}
	service := AppFactoryService{
		Store:     store,
		AppStore:  newAppStoreStub(),
		Publisher: publisher,
	}

	if err := service.handleAgentSessionTerminalState(ctx, "ws-1", "session-1", "completed", ""); err != nil {
		t.Fatalf("handleAgentSessionTerminalState() error = %v", err)
	}
	job, err := store.GetAppFactoryJob(ctx, "ws-1", "job-1")
	if err != nil {
		t.Fatalf("GetAppFactoryJob() error = %v", err)
	}
	if job.Status != workspacebiz.AppFactoryJobStatusFailed {
		t.Fatalf("status = %q, want failed validation", job.Status)
	}
	if job.PublishedVersion != "0.1.0" {
		t.Fatalf("published version = %q, want unchanged baseline", job.PublishedVersion)
	}
	if len(publisher.published) < 2 {
		t.Fatalf("published updates = %d, want preparing and failed updates", len(publisher.published))
	}
}

func TestAppFactoryServiceBumpsManifestVersionAfterRepublish(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	stateDir := t.TempDir()
	draftDir := t.TempDir()
	if err := writeTestAppFactoryDraft(draftDir, "app_1", "0.1.0"); err != nil {
		t.Fatalf("write test app draft: %v", err)
	}
	store := newAppFactoryStoreStub()
	if err := store.PutAppFactoryJob(ctx, workspacebiz.AppFactoryJob{
		AgentSessionID:   "session-1",
		AppID:            "app_1",
		DraftDir:         draftDir,
		JobID:            "job-1",
		PublishedVersion: "0.1.0",
		Status:           workspacebiz.AppFactoryJobStatusReady,
		WorkspaceID:      "ws-1",
	}); err != nil {
		t.Fatalf("PutAppFactoryJob() error = %v", err)
	}
	appStore := newAppStoreStub()
	if err := appStore.PutAppPackage(ctx, workspacebiz.AppPackage{
		AppID:        "app_1",
		Version:      "0.1.0",
		PackageDir:   filepath.Join(stateDir, "apps", "packages", "app_1", "0.1.0"),
		Manifest:     testAppManifest("app_1", "0.1.0"),
		ManifestJSON: `{"schemaVersion":"tutti.app.manifest.v1","appId":"app_1","version":"0.1.0","name":"Test App","description":"Test app","icon":{"type":"","src":""},"runtime":{"kind":"custom","bootstrap":"bootstrap.sh","healthcheckPath":"/healthz"}}`,
		Source:       workspacebiz.AppPackageSourceGenerated,
		FactoryJobID: "job-1",
	}); err != nil {
		t.Fatalf("PutAppPackage() error = %v", err)
	}
	service := AppFactoryService{
		Store:          store,
		AppStore:       appStore,
		StateDir:       stateDir,
		WorkspaceStore: &catalogStoreStub{getWorkspace: workspacebiz.Summary{ID: "ws-1", Name: "Workspace"}},
	}
	job, err := store.GetAppFactoryJob(ctx, "ws-1", "job-1")
	if err != nil {
		t.Fatalf("GetAppFactoryJob() error = %v", err)
	}
	manifest, _, err := workspacebiz.ReadAppManifestFile(filepath.Join(draftDir, appFactoryPackageRootRelativePath, "tutti.app.json"))
	if err != nil {
		t.Fatalf("ReadAppManifestFile() error = %v", err)
	}

	bumped, _, err := service.bumpRepublishedManifestVersion(ctx, job, manifest)
	if err != nil {
		t.Fatalf("bumpRepublishedManifestVersion() error = %v", err)
	}
	if bumped.Version != "0.1.1" {
		t.Fatalf("bumped version = %q, want 0.1.1", bumped.Version)
	}
	manifest, _, err = workspacebiz.ReadAppManifestFile(filepath.Join(draftDir, appFactoryPackageRootRelativePath, "tutti.app.json"))
	if err != nil {
		t.Fatalf("ReadAppManifestFile() error = %v", err)
	}
	if manifest.Version != "0.1.1" {
		t.Fatalf("draft manifest version = %q, want 0.1.1", manifest.Version)
	}
}

func TestAppFactoryServicePrepareModificationResetsDraftFromActivePackage(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	stateDir := t.TempDir()
	packageDir := createWorkspaceAppPackageForTest(t, t.TempDir(), workspacebiz.AppManifest{
		SchemaVersion: workspacebiz.AppManifestSchemaVersionV1,
		AppID:         "app_1",
		Version:       "0.1.1",
		Name:          "Test App",
		Description:   "Test app",
		Runtime: workspacebiz.AppManifestRuntime{
			Bootstrap:       "bootstrap.sh",
			HealthcheckPath: "/ready",
		},
	})
	if err := os.WriteFile(filepath.Join(packageDir, "icon.png"), []byte("current icon"), 0o644); err != nil {
		t.Fatalf("write package icon: %v", err)
	}

	jobRoot := filepath.Join(stateDir, "apps", "factory", "jobs", "job-1")
	draftDir := filepath.Join(jobRoot, "draft")
	runtimeDir := filepath.Join(jobRoot, "runtime")
	dataDir := filepath.Join(jobRoot, "data")
	if err := os.MkdirAll(draftDir, 0o755); err != nil {
		t.Fatalf("create draft dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(draftDir, "stale.txt"), []byte("stale"), 0o644); err != nil {
		t.Fatalf("write stale draft file: %v", err)
	}
	if err := os.MkdirAll(runtimeDir, 0o755); err != nil {
		t.Fatalf("create runtime dir: %v", err)
	}
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		t.Fatalf("create data dir: %v", err)
	}

	store := newAppFactoryStoreStub()
	if err := store.PutAppFactoryJob(ctx, workspacebiz.AppFactoryJob{
		AgentSessionID:   "session-1",
		AppID:            "app_1",
		DataDir:          dataDir,
		DraftDir:         draftDir,
		JobID:            "job-1",
		LogDir:           filepath.Join(jobRoot, "logs"),
		PackageDir:       filepath.Join(stateDir, "old-package"),
		PublishedVersion: "0.1.0",
		RuntimeDir:       runtimeDir,
		Status:           workspacebiz.AppFactoryJobStatusPublished,
		WorkspaceID:      "ws-1",
	}); err != nil {
		t.Fatalf("PutAppFactoryJob() error = %v", err)
	}
	appStore := newAppStoreStub()
	if err := appStore.PutAppPackage(ctx, workspacebiz.AppPackage{
		AppID:        "app_1",
		Version:      "0.1.1",
		PackageDir:   packageDir,
		Manifest:     mustReadManifestForTest(t, packageDir),
		Source:       workspacebiz.AppPackageSourceGenerated,
		FactoryJobID: "job-1",
	}); err != nil {
		t.Fatalf("PutAppPackage() error = %v", err)
	}
	service := AppFactoryService{
		Store:          store,
		AppStore:       appStore,
		StateDir:       stateDir,
		WorkspaceStore: &catalogStoreStub{getWorkspace: workspacebiz.Summary{ID: "ws-1", Name: "Workspace"}},
	}

	job, err := service.PrepareModification(ctx, "ws-1", "job-1")
	if err != nil {
		t.Fatalf("PrepareModification() error = %v", err)
	}
	if job.PackageDir != packageDir || job.PublishedVersion != "0.1.1" || job.Status != workspacebiz.AppFactoryJobStatusPublished {
		t.Fatalf("prepared job = %#v, want package dir/version/status synchronized", job)
	}
	if _, err := os.Stat(filepath.Join(draftDir, "stale.txt")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("stale draft file stat error = %v, want not exist", err)
	}
	if data, err := os.ReadFile(filepath.Join(draftDir, appFactoryPackageRootRelativePath, "icon.png")); err != nil || string(data) != "current icon" {
		t.Fatalf("draft package icon = %q, err = %v", data, err)
	}
	if _, err := os.Stat(runtimeDir); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("runtime dir stat error = %v, want not exist", err)
	}
	if _, err := os.Stat(dataDir); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("data dir stat error = %v, want not exist", err)
	}
}

func TestAppFactoryServicePublishRecoversExistingPackageForSameJob(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	stateDir := t.TempDir()
	draftDir := t.TempDir()
	if err := writeTestAppFactoryDraft(draftDir, "app_1", "0.1.0"); err != nil {
		t.Fatalf("write test app draft: %v", err)
	}
	store := newAppFactoryStoreStub()
	if err := store.PutAppFactoryJob(ctx, workspacebiz.AppFactoryJob{
		AgentSessionID: "session-1",
		DraftDir:       draftDir,
		JobID:          "job-1",
		Status:         workspacebiz.AppFactoryJobStatusReady,
		WorkspaceID:    "ws-1",
	}); err != nil {
		t.Fatalf("PutAppFactoryJob() error = %v", err)
	}
	appStore := newAppStoreStub()
	packageDir := filepath.Join(stateDir, "apps", "packages", "app_1", "0.1.0")
	if err := appStore.PutAppPackage(ctx, workspacebiz.AppPackage{
		AppID:                "app_1",
		Version:              "0.1.0",
		PackageDir:           packageDir,
		Manifest:             testAppManifest("app_1", "0.1.0"),
		ManifestJSON:         `{"schemaVersion":"tutti.app.manifest.v1","appId":"app_1","version":"0.1.0","name":"Test App","description":"Test app","runtime":{"bootstrap":"bootstrap.sh","healthcheckPath":"/healthz"}}`,
		Source:               workspacebiz.AppPackageSourceGenerated,
		FactoryJobID:         "job-1",
		CreatedInWorkspaceID: "ws-1",
	}); err != nil {
		t.Fatalf("PutAppPackage() error = %v", err)
	}
	workspaceStore := &catalogStoreStub{getWorkspace: workspacebiz.Summary{ID: "ws-1", Name: "Workspace"}}
	appCenter := &AppCenterService{
		Store:          appStore,
		WorkspaceStore: workspaceStore,
		Runner:         &AppRunner{RuntimeResolver: &appRuntimeResolverStub{called: make(chan struct{}), err: errors.New("skip runtime")}},
		BuiltinCatalog: func() ([]builtinapps.App, error) { return nil, nil },
	}
	service := AppFactoryService{
		AppCenter:      appCenter,
		AppStore:       appStore,
		StateDir:       stateDir,
		Store:          store,
		WorkspaceStore: workspaceStore,
	}

	job, app, err := service.Publish(ctx, "ws-1", "job-1")
	if err != nil {
		t.Fatalf("Publish() error = %v", err)
	}
	if job.Status != workspacebiz.AppFactoryJobStatusPublished || job.PublishedVersion != "0.1.0" || job.PackageDir != packageDir {
		t.Fatalf("published job = %#v", job)
	}
	if job.AppID != "app_1" {
		t.Fatalf("published job app id = %q, want app_1", job.AppID)
	}
	if app.Package.AppID != "app_1" || app.Package.Version != "0.1.0" {
		t.Fatalf("published app = %#v", app)
	}
	storedJob, err := store.GetAppFactoryJob(ctx, "ws-1", "job-1")
	if err != nil {
		t.Fatalf("GetAppFactoryJob() error = %v", err)
	}
	if storedJob.Status != workspacebiz.AppFactoryJobStatusPublished || storedJob.PublishedVersion != "0.1.0" || storedJob.AppID != "app_1" {
		t.Fatalf("stored job = %#v", storedJob)
	}
}

func TestAppFactoryServicePublishReturnsPublishedJobIdempotently(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	stateDir := t.TempDir()
	store := newAppFactoryStoreStub()
	if err := store.PutAppFactoryJob(ctx, workspacebiz.AppFactoryJob{
		AppID:            "app_1",
		JobID:            "job-1",
		PackageDir:       filepath.Join(stateDir, "apps", "packages", "app_1", "0.1.0"),
		PublishedVersion: "0.1.0",
		Status:           workspacebiz.AppFactoryJobStatusPublished,
		WorkspaceID:      "ws-1",
	}); err != nil {
		t.Fatalf("PutAppFactoryJob() error = %v", err)
	}
	appStore := newAppStoreStub()
	if err := appStore.PutAppPackage(ctx, workspacebiz.AppPackage{
		AppID:                "app_1",
		Version:              "0.1.0",
		PackageDir:           filepath.Join(stateDir, "apps", "packages", "app_1", "0.1.0"),
		Manifest:             testAppManifest("app_1", "0.1.0"),
		ManifestJSON:         `{"schemaVersion":"tutti.app.manifest.v1","appId":"app_1","version":"0.1.0","name":"Test App","description":"Test app","runtime":{"bootstrap":"bootstrap.sh","healthcheckPath":"/healthz"}}`,
		Source:               workspacebiz.AppPackageSourceGenerated,
		FactoryJobID:         "job-1",
		CreatedInWorkspaceID: "ws-1",
	}); err != nil {
		t.Fatalf("PutAppPackage() error = %v", err)
	}
	workspaceStore := &catalogStoreStub{getWorkspace: workspacebiz.Summary{ID: "ws-1", Name: "Workspace"}}
	appCenter := &AppCenterService{
		Store:          appStore,
		WorkspaceStore: workspaceStore,
		Runner:         &AppRunner{RuntimeResolver: &appRuntimeResolverStub{called: make(chan struct{}), err: errors.New("skip runtime")}},
		BuiltinCatalog: func() ([]builtinapps.App, error) { return nil, nil },
	}
	service := AppFactoryService{
		AppCenter:      appCenter,
		AppStore:       appStore,
		StateDir:       stateDir,
		Store:          store,
		WorkspaceStore: workspaceStore,
	}

	job, app, err := service.Publish(ctx, "ws-1", "job-1")
	if err != nil {
		t.Fatalf("Publish() error = %v", err)
	}
	if job.Status != workspacebiz.AppFactoryJobStatusPublished || job.PublishedVersion != "0.1.0" {
		t.Fatalf("published job = %#v", job)
	}
	if app.Package.AppID != "app_1" || app.Package.Version != "0.1.0" {
		t.Fatalf("published app = %#v", app)
	}
}

func TestAppFactoryServiceFailedTurnOutcomeFailsGeneratingJob(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := newAppFactoryStoreStub()
	if err := store.PutAppFactoryJob(ctx, workspacebiz.AppFactoryJob{
		AgentSessionID: "session-1",
		AppID:          "app_1",
		JobID:          "job-1",
		Status:         workspacebiz.AppFactoryJobStatusGenerating,
		WorkspaceID:    "ws-1",
	}); err != nil {
		t.Fatalf("PutAppFactoryJob() error = %v", err)
	}
	service := AppFactoryService{Store: store}
	state := canonical.WorkspaceAgentSessionStateUpdate{
		LastError: "Codex request failed because a quota or rate limit was reached.",
		Turn: &canonical.WorkspaceAgentTurnStateUpdate{
			Outcome: "failed",
			Phase:   "settled",
			TurnID:  "turn-1",
		},
	}
	status := factorySettledTurnOutcome(state.Turn)
	if status != "failed" {
		t.Fatalf("terminal status = %q, want failed", status)
	}
	if err := service.handleAgentSessionTerminalState(ctx, "ws-1", "session-1", status, state.LastError); err != nil {
		t.Fatalf("handleAgentSessionTerminalState() error = %v", err)
	}
	job, err := store.GetAppFactoryJob(ctx, "ws-1", "job-1")
	if err != nil {
		t.Fatalf("GetAppFactoryJob() error = %v", err)
	}
	if job.Status != workspacebiz.AppFactoryJobStatusFailed {
		t.Fatalf("status = %q, want failed", job.Status)
	}
	if job.FailureReason != state.LastError {
		t.Fatalf("failure reason = %q, want %q", job.FailureReason, state.LastError)
	}
}

func TestAppFactoryServiceListReconcilesFailedAgentSession(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := newAppFactoryStoreStub()
	if err := store.PutAppFactoryJob(ctx, workspacebiz.AppFactoryJob{
		AgentSessionID: "session-1",
		AppID:          "app_1",
		JobID:          "job-1",
		Status:         workspacebiz.AppFactoryJobStatusGenerating,
		WorkspaceID:    "ws-1",
	}); err != nil {
		t.Fatalf("PutAppFactoryJob() error = %v", err)
	}
	service := AppFactoryService{
		Store: store,
		WorkspaceStore: &catalogStoreStub{
			getWorkspace: workspacebiz.Summary{ID: "ws-1", Name: "Workspace"},
		},
		AgentSessionReader: factoryAgentSessionReaderStub{
			sessions: map[string]agentservice.PersistedSession{
				appFactoryJobStoreKey("ws-1", "session-1"): {
					ID:          "session-1",
					WorkspaceID: "ws-1",
				},
			},
			latestTurns: map[string]agentactivitybiz.Turn{
				appFactoryJobStoreKey("ws-1", "session-1"): {
					TurnID: "turn-1", Phase: "settled", Outcome: "failed",
					ErrorMessage: "Codex request failed because a quota or rate limit was reached.",
				},
			},
		},
	}

	jobs, err := service.List(ctx, "ws-1")
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if len(jobs) != 1 {
		t.Fatalf("jobs = %d, want 1", len(jobs))
	}
	if jobs[0].Status != workspacebiz.AppFactoryJobStatusFailed {
		t.Fatalf("status = %q, want failed", jobs[0].Status)
	}
	if jobs[0].FailureReason != "Codex request failed because a quota or rate limit was reached." {
		t.Fatalf("failure reason = %q, want quota failure message", jobs[0].FailureReason)
	}
}

func TestAppFactoryServiceFailedAgentSessionFailsGeneratingJob(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := newAppFactoryStoreStub()
	if err := store.PutAppFactoryJob(ctx, workspacebiz.AppFactoryJob{
		AgentSessionID: "session-1",
		AppID:          "app_1",
		JobID:          "job-1",
		Status:         workspacebiz.AppFactoryJobStatusGenerating,
		WorkspaceID:    "ws-1",
	}); err != nil {
		t.Fatalf("PutAppFactoryJob() error = %v", err)
	}
	service := AppFactoryService{Store: store}

	if err := service.handleAgentSessionTerminalState(ctx, "ws-1", "session-1", "failed", "provider failed"); err != nil {
		t.Fatalf("handleAgentSessionTerminalState() error = %v", err)
	}
	job, err := store.GetAppFactoryJob(ctx, "ws-1", "job-1")
	if err != nil {
		t.Fatalf("GetAppFactoryJob() error = %v", err)
	}
	if job.Status != workspacebiz.AppFactoryJobStatusFailed || job.FailureReason != "provider failed" {
		t.Fatalf("job = status %q reason %q, want failed provider failed", job.Status, job.FailureReason)
	}
}

func TestAppFactoryServiceIgnoresStaleTerminalAgentSessionState(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := newAppFactoryStoreStub()
	if err := store.PutAppFactoryJob(ctx, workspacebiz.AppFactoryJob{
		AgentSessionID: "session-1",
		AppID:          "app_1",
		JobID:          "job-1",
		Status:         workspacebiz.AppFactoryJobStatusGenerating,
		WorkspaceID:    "ws-1",
	}); err != nil {
		t.Fatalf("PutAppFactoryJob() error = %v", err)
	}
	service := AppFactoryService{Store: store}

	service.ObserveAgentSessionState(ctx, canonical.ReportSessionStateInput{
		WorkspaceID:    "ws-1",
		AgentSessionID: "session-1",
		State: canonical.WorkspaceAgentSessionStateUpdate{
			LastError: "stale failure", OccurredAtUnixMS: 150,
			Turn: &canonical.WorkspaceAgentTurnStateUpdate{TurnID: "turn-1", Phase: "settled", Outcome: "failed"},
		},
	}, canonical.ReportSessionStateReply{
		Accepted:          true,
		StateApplied:      false,
		LastEventAtUnixMS: 200,
	})

	job, err := store.GetAppFactoryJob(ctx, "ws-1", "job-1")
	if err != nil {
		t.Fatalf("GetAppFactoryJob() error = %v", err)
	}
	if job.Status != workspacebiz.AppFactoryJobStatusGenerating || job.FailureReason != "" {
		t.Fatalf("job = status %q reason %q, want unchanged generating job", job.Status, job.FailureReason)
	}
}

func TestFactorySettledTurnOutcomeCompleted(t *testing.T) {
	t.Parallel()

	status := factorySettledTurnOutcome(&canonical.WorkspaceAgentTurnStateUpdate{Outcome: "completed", Phase: "settled"})
	if status != "completed" {
		t.Fatalf("status = %q, want completed", status)
	}
}

func TestFactorySettledTurnOutcomeFailed(t *testing.T) {
	t.Parallel()

	status := factorySettledTurnOutcome(&canonical.WorkspaceAgentTurnStateUpdate{Outcome: "failed", Phase: "settled"})
	if status != "failed" {
		t.Fatalf("status = %q, want failed", status)
	}
}

func TestFactorySettledTurnOutcomeIgnoresMissingTurn(t *testing.T) {
	t.Parallel()

	status := factorySettledTurnOutcome(nil)
	if status != "" {
		t.Fatalf("status = %q, want empty", status)
	}
}

func TestFactorySettledTurnOutcomeInterruptedIsFailure(t *testing.T) {
	t.Parallel()

	status := factorySettledTurnOutcome(&canonical.WorkspaceAgentTurnStateUpdate{Outcome: "interrupted", Phase: "settled"})
	if status != "failed" {
		t.Fatalf("status = %q, want failed for interrupted settled turn", status)
	}
}

func TestFactorySettledTurnOutcomeCanceled(t *testing.T) {
	t.Parallel()

	status := factorySettledTurnOutcome(&canonical.WorkspaceAgentTurnStateUpdate{Outcome: "canceled", Phase: "settled"})
	if status != "canceled" {
		t.Fatalf("status = %q, want canceled", status)
	}
}

func TestAppFactoryServiceCompletedAgentSessionRecoversPreValidationFailure(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := newAppFactoryStoreStub()
	draftDir := t.TempDir()
	if err := store.PutAppFactoryJob(ctx, workspacebiz.AppFactoryJob{
		AgentSessionID: "session-1",
		AppID:          "app_1",
		DraftDir:       draftDir,
		FailureReason:  "App Factory agent session failed before validation.",
		JobID:          "job-1",
		Status:         workspacebiz.AppFactoryJobStatusFailed,
		WorkspaceID:    "ws-1",
	}); err != nil {
		t.Fatalf("PutAppFactoryJob() error = %v", err)
	}
	publisher := &workspaceAppFactoryPublisherStub{}
	service := AppFactoryService{
		Store:     store,
		AppStore:  newAppStoreStub(),
		Publisher: publisher,
	}

	if err := service.handleAgentSessionTerminalState(ctx, "ws-1", "session-1", "completed", ""); err != nil {
		t.Fatalf("handleAgentSessionTerminalState() error = %v", err)
	}
	job, err := store.GetAppFactoryJob(ctx, "ws-1", "job-1")
	if err != nil {
		t.Fatalf("GetAppFactoryJob() error = %v", err)
	}
	if job.Status != workspacebiz.AppFactoryJobStatusFailed {
		t.Fatalf("status = %q, want failed validation", job.Status)
	}
	if strings.TrimSpace(job.ValidationResultJSON) == "" {
		t.Fatal("validation result is empty, want validation to be retried")
	}
	if job.FailureReason == "App Factory agent session failed before validation." {
		t.Fatalf("failure reason was not replaced after validation retry: %q", job.FailureReason)
	}
	if len(publisher.published) < 2 {
		t.Fatalf("published updates = %d, want validation retry updates", len(publisher.published))
	}
}

func TestAppFactoryServiceRejectsFixAndValidationRetryAfterInterruptedFailure(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := newAppFactoryStoreStub()
	if err := store.PutAppFactoryJob(ctx, workspacebiz.AppFactoryJob{
		AgentSessionID: "session-1",
		WorkspaceID:    "ws-1",
		JobID:          "job-1",
		Status:         workspacebiz.AppFactoryJobStatusFailed,
		FailureReason:  interruptedFactoryJobReason,
	}); err != nil {
		t.Fatalf("PutAppFactoryJob() error = %v", err)
	}
	service := AppFactoryService{
		Store: store,
		WorkspaceStore: &catalogStoreStub{
			getWorkspace: workspacebiz.Summary{ID: "ws-1", Name: "Workspace"},
		},
		AgentSessionService: &factoryAgentSessionServiceStub{},
	}

	if _, err := service.RetryValidation(ctx, "ws-1", "job-1"); err == nil {
		t.Fatal("RetryValidation() error = nil, want error")
	}
	if _, err := service.Fix(ctx, "ws-1", "job-1", FixAppFactoryJobInput{Prompt: "fix it"}); err == nil {
		t.Fatal("Fix() error = nil, want error")
	}
}

func TestAppFactoryServiceFixIncludesFailureReasonInAgentPrompt(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := newAppFactoryStoreStub()
	validationResult, err := json.Marshal(workspacebiz.AppFactoryValidationResult{
		CheckedAt: 1,
		Errors:    []string{"read AGENTS.md: no such file or directory"},
	})
	if err != nil {
		t.Fatalf("marshal validation result: %v", err)
	}
	if err := store.PutAppFactoryJob(ctx, workspacebiz.AppFactoryJob{
		AgentSessionID:       "session-1",
		WorkspaceID:          "ws-1",
		JobID:                "job-1",
		Status:               workspacebiz.AppFactoryJobStatusFailed,
		FailureReason:        "read AGENTS.md: no such file or directory",
		ValidationResultJSON: string(validationResult),
	}); err != nil {
		t.Fatalf("PutAppFactoryJob() error = %v", err)
	}
	sessions := &factoryAgentSessionServiceStub{}
	service := AppFactoryService{
		Store:               store,
		AgentSessionService: sessions,
		WorkspaceStore:      &catalogStoreStub{getWorkspace: workspacebiz.Summary{ID: "ws-1", Name: "Workspace"}},
	}

	if _, err := service.Fix(ctx, "ws-1", "job-1", FixAppFactoryJobInput{Prompt: "fix it"}); err != nil {
		t.Fatalf("Fix() error = %v", err)
	}
	if len(sessions.sendInput.Content) != 1 {
		t.Fatalf("send input blocks = %d, want 1", len(sessions.sendInput.Content))
	}
	text := sessions.sendInput.Content[0].Text
	if !strings.Contains(text, "Current failure reason:\nread AGENTS.md: no such file or directory") {
		t.Fatalf("fix prompt missing failure reason: %q", text)
	}
	if !strings.Contains(text, "User request:\nfix it") {
		t.Fatalf("fix prompt missing user request: %q", text)
	}
	if sessions.sendInput.DisplayPrompt != "fix it" {
		t.Fatalf("fix display prompt = %q", sessions.sendInput.DisplayPrompt)
	}
}

func TestAppFactoryServiceDeleteRemovesTerminalJob(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	stateDir := t.TempDir()
	store := newAppFactoryStoreStub()
	jobRoot := filepath.Join(stateDir, "apps", "factory", "jobs", "job-1")
	if err := os.MkdirAll(filepath.Join(jobRoot, "draft"), 0o755); err != nil {
		t.Fatalf("create job draft dir: %v", err)
	}
	if err := store.PutAppFactoryJob(ctx, workspacebiz.AppFactoryJob{
		WorkspaceID: "ws-1",
		JobID:       "job-1",
		Status:      workspacebiz.AppFactoryJobStatusFailed,
		DraftDir:    filepath.Join(jobRoot, "draft"),
	}); err != nil {
		t.Fatalf("PutAppFactoryJob() error = %v", err)
	}
	service := AppFactoryService{
		Store:    store,
		StateDir: stateDir,
		WorkspaceStore: &catalogStoreStub{
			getWorkspace: workspacebiz.Summary{ID: "ws-1", Name: "Workspace"},
		},
	}

	if err := service.Delete(ctx, "ws-1", "job-1"); err != nil {
		t.Fatalf("Delete() error = %v", err)
	}
	if _, err := store.GetAppFactoryJob(ctx, "ws-1", "job-1"); !errors.Is(err, workspacedata.ErrWorkspaceAppFactoryJobNotFound) {
		t.Fatalf("GetAppFactoryJob() error = %v, want not found", err)
	}
	if _, err := os.Stat(jobRoot); !os.IsNotExist(err) {
		t.Fatalf("job root still exists, err = %v", err)
	}
}

func TestAppFactoryServiceDeleteRejectsActiveJob(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := newAppFactoryStoreStub()
	if err := store.PutAppFactoryJob(ctx, workspacebiz.AppFactoryJob{
		WorkspaceID: "ws-1",
		JobID:       "job-1",
		Status:      workspacebiz.AppFactoryJobStatusGenerating,
	}); err != nil {
		t.Fatalf("PutAppFactoryJob() error = %v", err)
	}
	service := AppFactoryService{
		Store: store,
		WorkspaceStore: &catalogStoreStub{
			getWorkspace: workspacebiz.Summary{ID: "ws-1", Name: "Workspace"},
		},
	}

	if err := service.Delete(ctx, "ws-1", "job-1"); err == nil {
		t.Fatal("Delete() error = nil, want error")
	}
}

func appFactoryJobStoreKey(workspaceID string, jobID string) string {
	return workspaceID + "\x00" + jobID
}

func writeTestAppFactoryDraft(draftDir string, appID string, version string) error {
	packageDir := filepath.Join(draftDir, appFactoryPackageRootRelativePath)
	if err := os.MkdirAll(packageDir, 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(packageDir, "tutti.app.json"), []byte(`{
  "schemaVersion": "tutti.app.manifest.v1",
  "appId": "`+appID+`",
  "version": "`+version+`",
  "name": "Test App",
  "description": "Test app",
  "runtime": {
    "bootstrap": "bootstrap.sh",
    "healthcheckPath": "/healthz"
  }
}`), 0o644); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(packageDir, "bootstrap.sh"), []byte("#!/bin/sh\nsleep 1\n"), 0o755); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(packageDir, "AGENTS.md"), []byte("Test app package.\n"), 0o644)
}

func testAppManifest(appID string, version string) workspacebiz.AppManifest {
	return workspacebiz.AppManifest{
		SchemaVersion: workspacebiz.AppManifestSchemaVersionV1,
		AppID:         appID,
		Version:       version,
		Name:          "Test App",
		Description:   "Test app",
		Runtime: workspacebiz.AppManifestRuntime{
			Bootstrap:       "bootstrap.sh",
			HealthcheckPath: "/healthz",
		},
	}
}

func appFactoryManifestForMetadataTest(appID string, version string, name string, description string) workspacebiz.AppManifest {
	manifest := testAppManifest(appID, version)
	manifest.Name = name
	manifest.Description = description
	return manifest
}

func waitForAppFactoryJobStatus(t *testing.T, store *appFactoryStoreStub, workspaceID string, jobID string, status workspacebiz.AppFactoryJobStatus) workspacebiz.AppFactoryJob {
	t.Helper()

	deadline := time.Now().Add(time.Second)
	var job workspacebiz.AppFactoryJob
	for time.Now().Before(deadline) {
		var err error
		job, err = store.GetAppFactoryJob(context.Background(), workspaceID, jobID)
		if err != nil {
			t.Fatalf("GetAppFactoryJob() error = %v", err)
		}
		if job.Status == status {
			return job
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("status = %q, want %q", job.Status, status)
	return workspacebiz.AppFactoryJob{}
}

// systemNoticeMessagePayload reproduces the exact payload shape codex/ACP
// system notices are persisted with (see acpSystemNoticeEvent in
// packages/agent/daemon/runtime/acp_update_events.go), e.g. the
// "Skill descriptions were shortened to fit the 2% skills context budget."
// warning observed in a real App Factory job (答案之书) that was marked
// failed within ~6 seconds of creation, before the agent had written any
// app files.
func systemNoticeMessagePayload() map[string]any {
	return map[string]any{
		"kind":       "agent_system_notice",
		"noticeKind": "warning",
		"severity":   "warning",
		"title":      "Skill descriptions were shortened to fit the 2% skills context budget.",
		"source":     "runtime",
	}
}

func TestIsCompletedAssistantTextMessageIgnoresSystemNotice(t *testing.T) {
	t.Parallel()

	if isCompletedAssistantTextMessage("assistant", "text", "completed", systemNoticeMessagePayload()) {
		t.Fatal("system notice message was treated as completed assistant text, want ignored")
	}
	if !isCompletedAssistantTextMessage("assistant", "text", "completed", nil) {
		t.Fatal("genuine completed assistant text message was ignored, want treated as completed")
	}
	if !isCompletedAssistantTextMessage("assistant", "text", "completed", map[string]any{"content": "done"}) {
		t.Fatal("genuine completed assistant text message with unrelated payload was ignored, want treated as completed")
	}
}

func TestFactoryAgentMessageUpdatesContainCompletedAssistantTextIgnoresSystemNotice(t *testing.T) {
	t.Parallel()

	updates := []canonical.WorkspaceAgentSessionMessageUpdate{
		{
			Role:    "assistant",
			Kind:    "text",
			Status:  "completed",
			Payload: systemNoticeMessagePayload(),
		},
	}
	if factoryAgentMessageUpdatesContainCompletedAssistantText(updates) {
		t.Fatal("system notice update was treated as completed assistant text, want ignored")
	}

	updates = append(updates, canonical.WorkspaceAgentSessionMessageUpdate{
		Role:   "assistant",
		Kind:   "text",
		Status: "completed",
	})
	if !factoryAgentMessageUpdatesContainCompletedAssistantText(updates) {
		t.Fatal("genuine completed assistant text update was ignored, want treated as completed")
	}
}

func TestFactoryAgentMessageUpdatesContainCanceledTurnToolCall(t *testing.T) {
	t.Parallel()

	updates := []canonical.WorkspaceAgentSessionMessageUpdate{
		{
			Role:   "assistant",
			Kind:   "tool_call",
			Status: "failed",
			Payload: map[string]any{
				"status": "canceled",
				"error": map[string]any{
					"message": "interrupted",
					"reason":  "interrupted",
					"status":  "canceled",
					"text":    "interrupted",
				},
			},
		},
	}
	if !factoryAgentMessageUpdatesContainCanceledTurnToolCall(updates) {
		t.Fatal("canceled interrupted tool call was ignored, want treated as canceled turn evidence")
	}
}

func TestFactoryAgentMessageUpdatesContainCanceledTurnToolCallIgnoresApproval(t *testing.T) {
	t.Parallel()

	updates := []canonical.WorkspaceAgentSessionMessageUpdate{
		{
			Role:   "assistant",
			Kind:   "tool_call",
			Status: "failed",
			Payload: map[string]any{
				"callType": "approval",
				"status":   "canceled",
				"error": map[string]any{
					"reason": "interrupted",
					"status": "canceled",
				},
			},
		},
	}
	if factoryAgentMessageUpdatesContainCanceledTurnToolCall(updates) {
		t.Fatal("canceled approval update was treated as canceled turn evidence")
	}
}

func TestFactoryAgentMessageUpdatesContainCanceledTurnToolCallRequiresInterruptedReason(t *testing.T) {
	t.Parallel()

	updates := []canonical.WorkspaceAgentSessionMessageUpdate{
		{
			Role:   "assistant",
			Kind:   "tool_call",
			Status: "failed",
			Payload: map[string]any{
				"status": "canceled",
				"error": map[string]any{
					"message": "command canceled by tool",
					"status":  "canceled",
				},
			},
		},
	}
	if factoryAgentMessageUpdatesContainCanceledTurnToolCall(updates) {
		t.Fatal("ordinary canceled tool call was treated as interrupted turn cancellation")
	}
}

// TestAppFactoryServiceObserveAgentSessionMessagesIgnoresSystemNoticeForCompletionDetection
// reproduces the exact false-failure sequence found in a real diagnostic log
// bundle (tutti-logs-20260706-012540.zip) for the "答案之书" App Factory job:
// the codex agent emitted only a "skills context budget" system notice
// (role=assistant, kind=text, status=completed) a few seconds into a job,
// long before writing any app files. Before this fix, that notice alone was
// enough to make the App Factory service believe the agent session had
// completed and immediately run validation — failing with "read app
// manifest: ... no such file or directory" while the agent kept working (and
// went on to succeed) in the background. The job's status then stayed
// "failed" forever with no way to reconcile once the agent actually
// finished.
func TestAppFactoryServiceObserveAgentSessionMessagesIgnoresSystemNoticeForCompletionDetection(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := newAppFactoryStoreStub()
	draftDir := t.TempDir()
	if err := store.PutAppFactoryJob(ctx, workspacebiz.AppFactoryJob{
		AgentSessionID: "session-1",
		AppID:          "app_1",
		DraftDir:       draftDir,
		JobID:          "job-1",
		Status:         workspacebiz.AppFactoryJobStatusGenerating,
		WorkspaceID:    "ws-1",
	}); err != nil {
		t.Fatalf("PutAppFactoryJob() error = %v", err)
	}
	publisher := &workspaceAppFactoryPublisherStub{}
	service := AppFactoryService{
		Store:     store,
		AppStore:  newAppStoreStub(),
		Publisher: publisher,
		// Even if the session's reported canonical status momentarily reads
		// "completed" (the suspected upstream race), the observer must not
		// act on it when the only new message is a system notice.
		AgentSessionReader: factoryAgentSessionReaderStub{
			sessions: map[string]agentservice.PersistedSession{
				appFactoryJobStoreKey("ws-1", "session-1"): {
					ID:          "session-1",
					WorkspaceID: "ws-1",
				},
			},
		},
		AgentMessageReader: factoryAgentMessageReaderStub{},
	}

	service.ObserveAgentSessionMessages(ctx, canonical.ReportSessionMessagesInput{
		WorkspaceID:    "ws-1",
		AgentSessionID: "session-1",
		Updates: []canonical.WorkspaceAgentSessionMessageUpdate{
			{
				MessageID: "notice-1",
				Role:      "assistant",
				Kind:      "text",
				Status:    "completed",
				Payload:   systemNoticeMessagePayload(),
			},
		},
	}, canonical.ReportSessionMessagesReply{AcceptedCount: 1})

	// The guard in ObserveAgentSessionMessages returns synchronously (no
	// goroutine spawned) when the update slice contains no genuine completed
	// assistant text, so the job status is safe to assert immediately.
	job, err := store.GetAppFactoryJob(ctx, "ws-1", "job-1")
	if err != nil {
		t.Fatalf("GetAppFactoryJob() error = %v", err)
	}
	if job.Status != workspacebiz.AppFactoryJobStatusGenerating {
		t.Fatalf("status = %q, want generating (job must not fail on a system notice alone)", job.Status)
	}
	if strings.TrimSpace(job.FailureReason) != "" {
		t.Fatalf("failure reason = %q, want empty", job.FailureReason)
	}
	if len(publisher.published) != 0 {
		t.Fatalf("published updates = %d, want 0", len(publisher.published))
	}
}

func TestAppFactoryServiceObserveAgentSessionMessagesDoesNotTreatToolCallAsTerminal(t *testing.T) {
	ctx := context.Background()
	store := newAppFactoryStoreStub()
	if err := store.PutAppFactoryJob(ctx, workspacebiz.AppFactoryJob{
		AgentSessionID: "session-1",
		AppID:          "app_1",
		JobID:          "job-1",
		Status:         workspacebiz.AppFactoryJobStatusGenerating,
		WorkspaceID:    "ws-1",
	}); err != nil {
		t.Fatalf("PutAppFactoryJob() error = %v", err)
	}
	service := AppFactoryService{Store: store}

	service.ObserveAgentSessionMessages(ctx, canonical.ReportSessionMessagesInput{
		WorkspaceID:    "ws-1",
		AgentSessionID: "session-1",
		Updates: []canonical.WorkspaceAgentSessionMessageUpdate{
			{
				MessageID: "tool-1",
				Role:      "assistant",
				Kind:      "tool_call",
				Status:    "failed",
				Payload: map[string]any{
					"status": "canceled",
					"error": map[string]any{
						"message": "interrupted",
						"reason":  "interrupted",
						"status":  "canceled",
						"text":    "interrupted",
					},
				},
			},
		},
	}, canonical.ReportSessionMessagesReply{AcceptedCount: 1})

	job := waitForAppFactoryJobStatus(t, store, "ws-1", "job-1", workspacebiz.AppFactoryJobStatusGenerating)
	if job.FailureReason != "" {
		t.Fatalf("failure reason = %q, want empty", job.FailureReason)
	}
}

// TestAppFactoryServiceIgnoresCompletedTextMidLiveTurn reproduces the
// A completed assistant text is only a reconciliation trigger. The durable
// latest Turn remains the terminal authority, so interim narration cannot
// finish an App Factory job while that Turn is still running.
func TestAppFactoryServiceIgnoresCompletedTextWhileDurableLatestTurnIsRunning(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := newAppFactoryStoreStub()
	if err := store.PutAppFactoryJob(ctx, workspacebiz.AppFactoryJob{
		AgentSessionID: "session-1", AppID: "app_1", DraftDir: t.TempDir(),
		JobID: "job-1", Status: workspacebiz.AppFactoryJobStatusGenerating, WorkspaceID: "ws-1",
	}); err != nil {
		t.Fatalf("PutAppFactoryJob() error = %v", err)
	}
	service := AppFactoryService{
		Store: store,
		AgentSessionReader: factoryAgentSessionReaderStub{
			sessions: map[string]agentservice.PersistedSession{
				appFactoryJobStoreKey("ws-1", "session-1"): {ID: "session-1", WorkspaceID: "ws-1", ActiveTurnID: "turn-1"},
			},
			latestTurns: map[string]agentactivitybiz.Turn{
				appFactoryJobStoreKey("ws-1", "session-1"): {AgentSessionID: "session-1", TurnID: "turn-1", Phase: agentactivitybiz.TurnPhaseRunning},
			},
		},
	}

	if err := service.handleAgentSessionCompletedMessage(ctx, "ws-1", "session-1"); err != nil {
		t.Fatalf("handleAgentSessionCompletedMessage() error = %v", err)
	}
	job, err := store.GetAppFactoryJob(ctx, "ws-1", "job-1")
	if err != nil {
		t.Fatalf("GetAppFactoryJob() error = %v", err)
	}
	if job.Status != workspacebiz.AppFactoryJobStatusGenerating || job.FailureReason != "" {
		t.Fatalf("job = %#v, want generating while durable latest turn is live", job)
	}
}
