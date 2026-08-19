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
	if appSession != nil && appSession.client != nil &&
		appSession.threadID == sourceThreadID {
		serverInfo := clonePayload(appSession.serverInfo)
		a.mu.Unlock()
		if version, ok := appServerForkVersion(strategy, serverInfo); ok &&
			versionAtLeast(version, strategy.throughTurnMinimumVersion) {
			return codexSideCapabilities(), nil
		}
		return SideConversationCapabilities{}, nil
	}
	a.mu.Unlock()
	// Side snapshots provider memory, including an in-progress Turn. A
	// historical probe can attest a binary version but cannot attest that
	// exact live context, so offline sources fail closed.
	return SideConversationCapabilities{}, nil
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
	trace := newCodexAppServerStartupTrace(side)
	defer func() { trace.Finish(err) }()
	a.mu.Lock()
	sourceAppSession := a.sessions[strings.TrimSpace(source.AgentSessionID)]
	if sourceAppSession == nil ||
		sourceAppSession.client == nil ||
		strings.TrimSpace(sourceAppSession.threadID) != sourceThreadID {
		a.mu.Unlock()
		return SideConversationOpenResult{}, ErrSideConversationExpired
	}
	client := sourceAppSession.client
	serverInfo := clonePayload(sourceAppSession.serverInfo)
	account := clonePayload(sourceAppSession.account)
	models := cloneCodexAppServerModels(sourceAppSession.models)
	planModeMask := sourceAppSession.planModeMask
	defaultModeMask := sourceAppSession.defaultModeMask
	defaultModel := sourceAppSession.defaultModel
	tuttiModeHostContext := sourceAppSession.tuttiModeHostContext
	a.mu.Unlock()
	version, ok := appServerForkVersion(strategy, serverInfo)
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
	// From this point all per-RPC and idle messages on the source-owned
	// connection are dispatched by thread id. This matches Codex App's Side
	// topology and preserves the source's in-memory active-Turn snapshot.
	a.installSharedAppServerRouter(client, source)

	params := map[string]any{
		"threadId":     sourceThreadID,
		"ephemeral":    true,
		"excludeTurns": true,
		"developerInstructions": codexSideInstructions(
			source,
			planModeMask,
			defaultModeMask,
			tuttiModeHostContext,
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
		codexAppServerConfigOptionDescriptors(models, side, raw),
	)
	// Register the child before boundary injection so connection-scoped
	// notifications and server requests already have an exact Side owner.
	sideAppSession := &codexAppServerSession{
		client:                 client,
		threadID:               childThreadID,
		runtimeSession:         side,
		serverInfo:             serverInfo,
		account:                account,
		models:                 cloneCodexAppServerModels(models),
		startupModelsReady:     len(models) > 0,
		startupRateLimitsReady: false,
		planModeMask:           planModeMask,
		defaultModeMask:        defaultModeMask,
		defaultModel:           defaultModel,
		tuttiModeHostContext:   tuttiModeHostContext,
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
				source,
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
	return SideConversationOpenResult{
		Session: side, Capabilities: codexSideCapabilities(),
	}, nil
}
