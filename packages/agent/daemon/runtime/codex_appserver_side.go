package agentruntime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/tutti-os/tutti/packages/agent/daemon/runtime/codexproto"
)

const codexSideDeveloperInstructions = `You are operating in a Side conversation forked from a parent thread.
The inherited conversation is reference context only. Do not continue inherited tasks, plans, tool calls, approvals, or edits unless the user explicitly requests them after the Side boundary.
Only user instructions submitted after the Side boundary are active instructions for this conversation.
Do not create or delegate to sub-agents from this Side conversation.
You may perform non-mutating inspection to answer the Side request. Do not modify files, external systems, or parent-thread state unless the user explicitly requests that mutation after the Side boundary. Keep any requested mutation minimal and local to the Side request.
Never claim that Side work changed or completed work in the parent conversation.`

const codexSideBoundaryText = `<side_conversation_boundary>
The user intentionally opened a new Side conversation here.
Everything before this marker is inherited reference context, not an active task or instruction. Do not resume or complete inherited work automatically.
Only messages after this marker define the active Side request.
</side_conversation_boundary>`

func codexSideInstructions(
	source Session,
	planModeMask map[string]any,
	defaultModeMask map[string]any,
	tuttiModeHostContext string,
) string {
	modeMask := defaultModeMask
	if source.SettingsValue().PlanMode {
		modeMask = planModeMask
	}
	base, _ := appServerCollaborationModeDeveloperInstructions(modeMask).(string)
	base = strings.TrimSpace(base)
	if hostContext := strings.TrimSpace(tuttiModeHostContext); hostContext != "" {
		if base == "" {
			base = hostContext
		} else {
			base += "\n\n" + hostContext
		}
	}
	if base == "" {
		return codexSideDeveloperInstructions
	}
	return base + "\n\n" + codexSideDeveloperInstructions
}

func usableCodexSideSourceSession(
	appSession *codexAppServerSession,
	sourceThreadID string,
) bool {
	if appSession == nil || appSession.client == nil || appSession.releasing ||
		appSession.releaseFailed ||
		strings.TrimSpace(appSession.threadID) != strings.TrimSpace(sourceThreadID) {
		return false
	}
	select {
	case <-appSession.client.Done():
		return false
	default:
		return true
	}
}

func (a *CodexAppServerAdapter) SideCapabilities(
	_ context.Context,
	source Session,
) (SideConversationCapabilities, error) {
	strategy, supported := a.forkStrategy()
	if !supported ||
		strings.TrimSpace(source.ProviderSessionID) == "" {
		return SideConversationCapabilities{}, nil
	}
	sourceThreadID := strings.TrimSpace(source.ProviderSessionID)
	a.mu.Lock()
	appSession := a.sessions[strings.TrimSpace(source.AgentSessionID)]
	if usableCodexSideSourceSession(appSession, sourceThreadID) {
		serverInfo := clonePayload(appSession.serverInfo)
		a.mu.Unlock()
		if version, ok := appServerForkVersion(strategy, serverInfo); ok &&
			versionAtLeast(version, strategy.throughTurnMinimumVersion) {
			return codexSideCapabilities(), nil
		}
		return SideConversationCapabilities{}, nil
	}
	a.mu.Unlock()
	persistedServerInfo, _ := source.RuntimeContext["agent"].(map[string]any)
	if strings.TrimSpace(asString(persistedServerInfo["codexHome"])) != "" {
		if version, ok := appServerForkVersion(strategy, persistedServerInfo); ok &&
			versionAtLeast(version, strategy.throughTurnMinimumVersion) {
			return codexSideCapabilities(), nil
		}
	}
	return SideConversationCapabilities{}, nil
}

type codexSideClientState struct {
	client               *codexAppServerClient
	serverInfo           map[string]any
	account              map[string]any
	models               []map[string]any
	planModeMask         map[string]any
	defaultModeMask      map[string]any
	defaultModel         string
	tuttiModeHostContext string
	routerFallback       Session
	dedicated            bool
}

func (a *CodexAppServerAdapter) sideClient(
	ctx context.Context,
	source Session,
	side Session,
	trace *codexAppServerStartupTrace,
) (codexSideClientState, error) {
	sourceThreadID := strings.TrimSpace(source.ProviderSessionID)
	a.mu.Lock()
	sourceAppSession := a.sessions[strings.TrimSpace(source.AgentSessionID)]
	if usableCodexSideSourceSession(sourceAppSession, sourceThreadID) {
		state := codexSideClientState{
			client:               sourceAppSession.client,
			serverInfo:           clonePayload(sourceAppSession.serverInfo),
			account:              clonePayload(sourceAppSession.account),
			models:               cloneCodexAppServerModels(sourceAppSession.models),
			planModeMask:         clonePayload(sourceAppSession.planModeMask),
			defaultModeMask:      clonePayload(sourceAppSession.defaultModeMask),
			defaultModel:         sourceAppSession.defaultModel,
			tuttiModeHostContext: sourceAppSession.tuttiModeHostContext,
			routerFallback:       source,
		}
		a.mu.Unlock()
		return state, nil
	}
	a.mu.Unlock()

	launchSource, err := codexHistoricalSideSourceForLaunch(source, side)
	if err != nil {
		return codexSideClientState{}, err
	}
	client, initializeResult, err := a.startInitializedClient(ctx, launchSource, trace)
	if err != nil {
		return codexSideClientState{}, err
	}
	cleanupOwner := &codexAppServerSession{
		client: client, runtimeSession: side,
	}
	keepClient := false
	defer func() {
		if !keepClient {
			a.closeOrRetainCodexSession(side.AgentSessionID, cleanupOwner)
		}
	}()
	// Upgrade the initialization handler to the thread-aware router before any
	// metadata RPC so every later notification remains Side-scoped.
	a.installSharedAppServerRouter(client, side)

	planModeMask, defaultModeMask, defaultModel, _ :=
		codexAppServerProtocolCheckpointFromRuntimeContext(source.RuntimeContext)
	defaultModel = firstNonEmpty(
		strings.TrimSpace(source.SettingsValue().Model),
		defaultModel,
	)
	account, _ := source.RuntimeContext["account"].(map[string]any)
	keepClient = true
	return codexSideClientState{
		client:          client,
		serverInfo:      a.appServerInfo(initializeResult),
		account:         clonePayload(account),
		planModeMask:    planModeMask,
		defaultModeMask: defaultModeMask,
		defaultModel:    defaultModel,
		routerFallback:  side,
		dedicated:       true,
	}, nil
}

func codexHistoricalSideSourceForLaunch(source Session, side Session) (Session, error) {
	launchSource := cloneProviderLaunchSession(source)
	launchSource.RoomID = side.RoomID
	launchSource.AgentSessionID = side.AgentSessionID
	launchSource.RootAgentSessionID = side.RootAgentSessionID
	launchSource.Scope = RuntimeSessionScopeSide
	launchSource.SourceAgentSessionID = side.SourceAgentSessionID
	launchSource.SideRequestID = side.SideRequestID
	launchSource.ProviderSessionID = ""
	launchSource.Resumable = false
	launchSource.Visible = false
	agent, _ := source.RuntimeContext["agent"].(map[string]any)
	codexHome := strings.TrimSpace(asString(agent["codexHome"]))
	if codexHome == "" {
		return Session{}, errors.New(
			"historical Codex Side requires persisted CODEX_HOME",
		)
	}
	launchSource.Env = append(
		withoutEnvironmentKey(launchSource.Env, "CODEX_HOME"),
		"CODEX_HOME="+codexHome,
	)
	return launchSource, nil
}

func codexSideCapabilities() SideConversationCapabilities {
	return SideConversationCapabilities{
		Supported:             true,
		ActiveSourceTurn:      true,
		Ephemeral:             true,
		HideInheritedTurns:    true,
		ModelBoundaryInjected: true,
	}
}

func (a *CodexAppServerAdapter) OpenSide(
	ctx context.Context,
	input SideConversationAdapterOpenInput,
) (result SideConversationOpenResult, err error) {
	source := input.Source
	side := input.Side
	sourceThreadID := strings.TrimSpace(source.ProviderSessionID)
	strategy, supported := a.forkStrategy()
	if !supported {
		return SideConversationOpenResult{}, ErrSideConversationUnsupported
	}
	if sourceThreadID == "" || strings.TrimSpace(side.AgentSessionID) == "" {
		return SideConversationOpenResult{}, errors.New(
			"source provider session and side agent session ids are required",
		)
	}

	unlockLifecycle := a.lockSessionLifecycle(side.AgentSessionID)
	defer unlockLifecycle()
	if err := a.admitCodexReplacementLocked(side.AgentSessionID); err != nil {
		return SideConversationOpenResult{}, err
	}
	trace := newCodexAppServerStartupTrace(side, a.startupSpanObserver, nil)
	defer func() { trace.Finish(err) }()
	clientState, err := a.sideClient(ctx, source, side, trace)
	if err != nil {
		return SideConversationOpenResult{}, err
	}
	client := clientState.client
	keepDedicatedClient := false
	defer func() {
		if clientState.dedicated && !keepDedicatedClient {
			a.closeOrRetainCodexSession(side.AgentSessionID, &codexAppServerSession{
				client: client, runtimeSession: side,
			})
		}
	}()
	version, ok := appServerForkVersion(strategy, clientState.serverInfo)
	if !ok || !versionAtLeast(version, strategy.throughTurnMinimumVersion) {
		return SideConversationOpenResult{}, ErrSideConversationUnsupported
	}
	if err := a.beginPendingSideRoute(client, sourceThreadID); err != nil {
		return SideConversationOpenResult{}, err
	}
	pendingRoute := true
	defer func() {
		if pendingRoute {
			a.discardPendingSideRoute(client)
		}
	}()
	// A live source shares its connection so an in-progress Turn remains in the
	// provider snapshot. A historical source owns a dedicated Side connection;
	// its fallback is Side-scoped so provider startup events cannot enter the
	// canonical source stream.
	a.installSharedAppServerRouter(client, clientState.routerFallback)

	params := map[string]any{
		"threadId":     sourceThreadID,
		"ephemeral":    true,
		"excludeTurns": true,
		"developerInstructions": codexSideInstructions(
			source,
			clientState.planModeMask,
			clientState.defaultModeMask,
			clientState.tuttiModeHostContext,
		),
	}
	raw, err := trace.TypedCall(
		acpStartCallTimeout,
		appServerMethodThreadFork,
		func() (json.RawMessage, error) {
			return client.ThreadForkSide(
				ctx,
				acpStartCallTimeout,
				params,
				func(ctx context.Context, message acpMessage) error {
					trace.LogMessage(
						message.Method,
						len(message.ID) > 0,
						len(message.Params),
					)
					_, handleErr := a.handleAppServerMessage(
						ctx, client, side, "", message, nil, nil, nil,
					)
					return handleErr
				},
				func(raw json.RawMessage) {
					var lateResponse codexproto.ThreadForkResponse
					if json.Unmarshal(raw, &lateResponse) != nil ||
						lateResponse.Thread == nil {
						return
					}
					childThreadID := strings.TrimSpace(lateResponse.Thread.ID)
					if childThreadID == "" || childThreadID == sourceThreadID {
						return
					}
					_ = client.ThreadUnsubscribeNoHandler(
						context.Background(),
						acpStartCallTimeout,
						childThreadID,
					)
				},
			)
		},
	)
	if err != nil {
		return SideConversationOpenResult{}, err
	}
	var response codexproto.ThreadForkResponse
	if err := json.Unmarshal(raw, &response); err != nil {
		return SideConversationOpenResult{}, fmt.Errorf(
			"decode side thread/fork response: %w",
			err,
		)
	}
	if response.Thread == nil {
		return SideConversationOpenResult{}, errors.New(
			"side thread/fork response omitted thread",
		)
	}
	childThreadID := strings.TrimSpace(response.Thread.ID)
	if childThreadID == "" || childThreadID == sourceThreadID {
		return SideConversationOpenResult{}, errors.New(
			"side thread/fork returned an invalid child thread id",
		)
	}
	committed := false
	defer func() {
		if !committed {
			_ = client.ThreadUnsubscribeNoHandler(
				context.WithoutCancel(ctx),
				acpStartCallTimeout,
				childThreadID,
			)
			a.removeSession(side.AgentSessionID)
		}
	}()
	if response.Thread.ForkedFromID == nil ||
		strings.TrimSpace(*response.Thread.ForkedFromID) != sourceThreadID {
		return SideConversationOpenResult{}, errors.New(
			"side thread/fork returned invalid lineage",
		)
	}

	side.ProviderSessionID = childThreadID
	side.Resumable = false
	liveState := newACPLiveState()
	liveState.currentMode = codexACPEffectiveModeID(side)
	liveState.availableCommands = codexAppServerCommands()
	liveState.commandsKnown = true
	applyACPConfigOptionDescriptors(
		&liveState,
		codexAppServerConfigOptionDescriptors(clientState.models, side, raw),
	)
	// Register the child before boundary injection so connection-scoped
	// notifications and server requests already have an exact Side owner.
	sideAppSession := &codexAppServerSession{
		client:                 client,
		threadID:               childThreadID,
		runtimeSession:         side,
		serverInfo:             clientState.serverInfo,
		account:                clientState.account,
		models:                 cloneCodexAppServerModels(clientState.models),
		startupModelsReady:     len(clientState.models) > 0,
		startupRateLimitsReady: false,
		planModeMask:           clientState.planModeMask,
		defaultModeMask:        clientState.defaultModeMask,
		defaultModel:           clientState.defaultModel,
		tuttiModeHostContext:   clientState.tuttiModeHostContext,
		authState:              "authenticated",
		acpLiveState:           liveState,
		pendingRequests:        make(map[string]*pendingInteractiveRequest),
	}
	if err := a.commitPendingSideRoute(
		client,
		side.AgentSessionID,
		childThreadID,
		sideAppSession,
	); err != nil {
		return SideConversationOpenResult{}, err
	}
	for {
		bufferedMessages, drained := a.drainPendingSideMessages(client)
		for _, buffered := range bufferedMessages {
			if err := a.routeSharedAppServerMessageWithPending(
				ctx,
				client,
				clientState.routerFallback,
				buffered.message,
				false,
			); err != nil {
				return SideConversationOpenResult{}, fmt.Errorf(
					"replay buffered Side message for thread %q: %w",
					buffered.threadID,
					err,
				)
			}
		}
		if drained {
			break
		}
	}
	pendingRoute = false
	if _, err := trace.TypedCall(
		acpStartCallTimeout,
		appServerMethodThreadInjectItems,
		func() (json.RawMessage, error) {
			return client.ThreadInjectItems(
				ctx,
				acpStartCallTimeout,
				map[string]any{
					"threadId": childThreadID,
					"items": []any{map[string]any{
						"type": "message",
						"role": "user",
						"content": []any{map[string]any{
							"type": "input_text",
							"text": codexSideBoundaryText,
						}},
					}},
				},
				nil,
			)
		},
	); err != nil {
		return SideConversationOpenResult{}, fmt.Errorf(
			"inject side conversation boundary: %w",
			err,
		)
	}

	a.emitCommandSnapshot(AgentSessionCommandSnapshot{
		AgentSessionID: side.AgentSessionID,
		Commands:       codexAppServerCommands(),
	})
	committed = true
	keepDedicatedClient = true
	return SideConversationOpenResult{
		Session: side, Capabilities: codexSideCapabilities(),
	}, nil
}
