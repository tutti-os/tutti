package agentruntime

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"time"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func (a *CodexAppServerAdapter) fetchAccount(
	ctx context.Context,
	client *codexAppServerClient,
	session Session,
	trace *codexAppServerStartupTrace,
) (map[string]any, bool) {
	result, err := trace.TypedCall(acpStartCallTimeout, appServerMethodAccountRead, func() (json.RawMessage, error) {
		return client.AccountRead(ctx, acpStartCallTimeout, map[string]any{},
			func(ctx context.Context, message acpMessage) error {
				trace.LogMessage(message.Method, len(message.ID) > 0, len(message.Params))
				_, err := a.handleAppServerMessage(ctx, client, session, "", message, nil, nil, nil)
				return err
			})
	})
	if err != nil {
		// Account introspection is best-effort; authentication problems will
		// surface from thread/start instead.
		return nil, false
	}
	var payload struct {
		Account            map[string]any `json:"account"`
		RequiresOpenaiAuth bool           `json:"requiresOpenaiAuth"`
	}
	if err := json.Unmarshal(result, &payload); err != nil {
		return nil, false
	}
	trace.Log("account.parsed", map[string]any{
		"has_account":          payload.Account != nil,
		"requires_openai_auth": payload.RequiresOpenaiAuth,
	})
	return payload.Account, payload.RequiresOpenaiAuth && payload.Account == nil
}

func (a *CodexAppServerAdapter) fetchModels(
	ctx context.Context,
	client *codexAppServerClient,
	session Session,
	trace *codexAppServerStartupTrace,
) []map[string]any {
	result, err := trace.TypedCall(acpStartCallTimeout, appServerMethodModelList, func() (json.RawMessage, error) {
		return client.ModelList(ctx, acpStartCallTimeout, map[string]any{},
			func(ctx context.Context, message acpMessage) error {
				trace.LogMessage(message.Method, len(message.ID) > 0, len(message.Params))
				_, err := a.handleAppServerMessage(ctx, client, session, "", message, nil, nil, nil)
				return err
			})
	})
	if err != nil {
		return nil
	}
	var payload struct {
		Data []map[string]any `json:"data"`
	}
	if err := json.Unmarshal(result, &payload); err != nil {
		return nil
	}
	trace.Log("models.parsed", map[string]any{
		"count": len(payload.Data),
	})
	return payload.Data
}

func (*CodexAppServerAdapter) fetchModelsNoHandler(
	ctx context.Context,
	client *codexAppServerClient,
	trace *codexAppServerStartupTrace,
) []map[string]any {
	result, err := trace.TypedCallNoHandler(acpStartCallTimeout, appServerMethodModelList, func() (json.RawMessage, error) {
		return client.ModelListNoHandler(ctx, acpStartCallTimeout, map[string]any{})
	})
	if err != nil {
		return nil
	}
	var payload struct {
		Data []map[string]any `json:"data"`
	}
	if err := json.Unmarshal(result, &payload); err != nil {
		return nil
	}
	trace.Log("background_models.parsed", map[string]any{
		"count": len(payload.Data),
	})
	return payload.Data
}

func (*CodexAppServerAdapter) fetchRateLimitsNoHandler(
	ctx context.Context,
	client *codexAppServerClient,
	trace *codexAppServerStartupTrace,
) map[string]any {
	result, err := trace.TypedCallNoHandler(acpStartCallTimeout, appServerMethodRateLimitsRead, func() (json.RawMessage, error) {
		return client.AccountRateLimitsReadNoHandler(ctx, acpStartCallTimeout)
	})
	if err != nil {
		return nil
	}
	var payload struct {
		RateLimits map[string]any `json:"rateLimits"`
	}
	if err := json.Unmarshal(result, &payload); err != nil {
		return nil
	}
	trace.Log("background_rate_limits.parsed", map[string]any{
		"has_rate_limits": payload.RateLimits != nil,
	})
	return payload.RateLimits
}

// fetchGoal reads the thread's persisted goal. Best effort: any error means
// the in-memory goal stays as-is. NoHandler: this runs in the background and
// must not claim the message handler slot away from a streaming turn.
func (*CodexAppServerAdapter) fetchGoal(
	ctx context.Context,
	client *codexAppServerClient,
	threadID string,
	trace *codexAppServerStartupTrace,
) map[string]any {
	result, err := trace.TypedCallNoHandler(acpStartCallTimeout, appServerMethodThreadGoalGet, func() (json.RawMessage, error) {
		goalCtx, cancel := context.WithTimeout(ctx, acpStartCallTimeout)
		defer cancel()
		return client.ThreadGoalGetNoHandler(goalCtx, map[string]any{"threadId": threadID})
	})
	if err != nil {
		return nil
	}
	return appServerGoalFromResult(result)
}

// fetchCollaborationModeMasks probes the experimental collaboration mode list
// and returns the Plan and Default preset masks. The turn/start payload is
// assembled per turn because the schema requires a concrete settings.model.
// Best effort: any error means the capability stays off.
func (a *CodexAppServerAdapter) fetchCollaborationModeMasks(
	ctx context.Context,
	client *codexAppServerClient,
	session Session,
	trace *codexAppServerStartupTrace,
) (map[string]any, map[string]any) {
	result, err := trace.TypedCall(acpStartCallTimeout, appServerMethodCollaborationModeList, func() (json.RawMessage, error) {
		return client.CollaborationModeList(ctx, acpStartCallTimeout,
			func(ctx context.Context, message acpMessage) error {
				trace.LogMessage(message.Method, len(message.ID) > 0, len(message.Params))
				_, err := a.handleAppServerMessage(ctx, client, session, "", message, nil, nil, nil)
				return err
			})
	})
	if err != nil {
		return nil, nil
	}
	var payload struct {
		Data []map[string]any `json:"data"`
	}
	if err := json.Unmarshal(result, &payload); err != nil {
		return nil, nil
	}
	trace.Log("collaboration_modes.parsed", map[string]any{
		"count": len(payload.Data),
	})
	var planModeMask map[string]any
	var defaultModeMask map[string]any
	for _, preset := range payload.Data {
		mode := strings.ToLower(strings.TrimSpace(firstNonEmpty(asString(preset["mode"]), asString(preset["name"]))))
		switch mode {
		case "plan":
			trace.Log("plan_collaboration_mode.found", nil)
			planModeMask = clonePayload(preset)
		case "default":
			trace.Log("default_collaboration_mode.found", nil)
			defaultModeMask = clonePayload(preset)
		}
	}
	if planModeMask == nil {
		trace.Log("plan_collaboration_mode.missing", nil)
	}
	if defaultModeMask == nil {
		trace.Log("default_collaboration_mode.missing", nil)
	}
	return planModeMask, defaultModeMask
}

func codexAppServerTraceThreadStartParams(session Session, params map[string]any, resume bool) map[string]any {
	settings := session.SettingsValue()
	fields := map[string]any{
		"resume":             resume,
		"cwd":                asString(params["cwd"]),
		"has_thread_id":      strings.TrimSpace(asString(params["threadId"])) != "",
		"model":              asString(params["model"]),
		"settings_model":     settings.Model,
		"settings_plan_mode": settings.PlanMode,
		"permission_mode_id": session.PermissionModeID,
		"approval_policy":    asString(params["approvalPolicy"]),
		"sandbox":            asString(params["sandbox"]),
		"env_count":          len(session.Env),
	}
	if config := payloadObject(params["config"]); len(config) > 0 {
		fields["config_keys"] = sortedMapKeys(config)
		fields["reasoning_effort"] = asString(config["model_reasoning_effort"])
		fields["service_tier"] = asString(config["service_tier"])
		fields["reasoning_summary"] = asString(config[codexACPConfigModelReasoningSummary])
	}
	return fields
}

func codexAppServerTraceTurnStartParams(session Session, params map[string]any, content []PromptContentBlock) map[string]any {
	settings := session.SettingsValue()
	fields := map[string]any{
		"thread_id":          asString(params["threadId"]),
		"has_thread_id":      strings.TrimSpace(asString(params["threadId"])) != "",
		"model":              asString(params["model"]),
		"effort":             asString(params["effort"]),
		"summary":            asString(params["summary"]),
		"settings_model":     settings.Model,
		"settings_plan_mode": settings.PlanMode,
		"permission_mode_id": session.PermissionModeID,
		"approval_policy":    asString(params["approvalPolicy"]),
		"content":            codexAppServerTracePromptContent(content),
	}
	if sandboxPolicy := payloadObject(params["sandboxPolicy"]); len(sandboxPolicy) > 0 {
		fields["sandbox_policy_keys"] = sortedMapKeys(sandboxPolicy)
	}
	if collaborationMode := payloadObject(params["collaborationMode"]); len(collaborationMode) > 0 {
		fields["collaboration_mode_keys"] = sortedMapKeys(collaborationMode)
		fields["collaboration_mode"] = firstNonEmpty(asString(collaborationMode["mode"]), asString(collaborationMode["name"]))
	}
	return fields
}

func codexAppServerTracePromptContent(content []PromptContentBlock) map[string]any {
	typeCounts := map[string]int{}
	textBytes := 0
	dataBytes := 0
	attachments := 0
	paths := 0
	for _, block := range content {
		blockType := strings.TrimSpace(block.Type)
		if blockType == "" {
			blockType = "unknown"
		}
		typeCounts[blockType]++
		textBytes += len(block.Text)
		dataBytes += len(block.Data)
		if strings.TrimSpace(block.AttachmentID) != "" {
			attachments++
		}
		if strings.TrimSpace(block.Path) != "" {
			paths++
		}
	}
	return map[string]any{
		"block_count":      len(content),
		"type_counts":      typeCounts,
		"text_bytes":       textBytes,
		"data_bytes":       dataBytes,
		"attachment_count": attachments,
		"path_count":       paths,
	}
}

func sortedMapKeys(values map[string]any) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func (a *CodexAppServerAdapter) refreshStartupMetadataAsync(
	session Session,
	threadResult json.RawMessage,
	fetchModels bool,
	fetchRateLimits bool,
	trace *codexAppServerStartupTrace,
) {
	if a == nil || (!fetchModels && !fetchRateLimits) {
		return
	}
	a.mu.Lock()
	hasEventSink := a.eventSink != nil
	a.mu.Unlock()
	if !hasEventSink {
		return
	}
	agentSessionID := strings.TrimSpace(session.AgentSessionID)
	if agentSessionID == "" {
		return
	}
	threadResult = append(json.RawMessage(nil), threadResult...)
	go func() {
		defer func() {
			if recovered := recover(); recovered != nil {
				trace.Log("background_metadata.panic", map[string]any{
					"panic": fmt.Sprint(recovered),
				})
			}
		}()
		ctx := context.Background()
		if fetchRateLimits {
			if appSession := a.getSession(agentSessionID); appSession != nil && appSession.client != nil {
				rateLimits := a.fetchRateLimitsNoHandler(ctx, appSession.client, trace)
				if a.applyRateLimits(agentSessionID, rateLimits) {
					a.emitStartupMetadataRefreshEvent(session, agentSessionID)
				}
			}
		}
		if fetchModels {
			// fetchModels re-resolves the session each attempt so the loop keeps
			// working against a live client and stops once the session is gone.
			fetch := func(ctx context.Context) []map[string]any {
				appSession := a.getSession(agentSessionID)
				if appSession == nil || appSession.client == nil {
					return nil
				}
				return a.fetchModelsNoHandler(ctx, appSession.client, trace)
			}
			sleep := func(ctx context.Context, d time.Duration) bool {
				return sleepWithContext(ctx, d) == nil
			}
			if a.retryStartupModels(ctx, agentSessionID, session, threadResult, fetch, sleep) {
				a.emitStartupMetadataRefreshEvent(session, agentSessionID)
			}
		}
		// The goal lives in codex's thread state; restore it after start or
		// resume so the banner survives daemon restarts and adopted
		// continuation turns find the goal status they gate on.
		if appSession := a.getSession(agentSessionID); appSession != nil && appSession.client != nil {
			if goal := a.fetchGoal(ctx, appSession.client, appSession.threadID, trace); len(goal) > 0 {
				a.applyGoalUpdate(agentSessionID, goal)
				a.emitStartupMetadataRefreshEvent(session, agentSessionID)
			}
		}
	}()
}

// retryStartupModels re-fetches the codex model/list until it returns a
// non-empty list (and the startup state resolves to "ready"), the session is
// torn down, the context is canceled, or the bounded backoff budget is
// exhausted. A single transient empty/slow response therefore no longer pins
// the composer's model options at "loading" forever — the previous code fetched
// exactly once and silently left the state stuck on failure.
func (a *CodexAppServerAdapter) retryStartupModels(
	ctx context.Context,
	agentSessionID string,
	session Session,
	threadResult json.RawMessage,
	fetch func(context.Context) []map[string]any,
	sleep func(context.Context, time.Duration) bool,
) bool {
	if a == nil || fetch == nil {
		return false
	}
	backoffs := a.startupModelRetryBackoffs
	if backoffs == nil {
		backoffs = defaultStartupModelRetryBackoffs()
	}
	for attempt := 0; attempt <= len(backoffs); attempt++ {
		if a.getSession(agentSessionID) == nil {
			return false
		}
		models := fetch(ctx)
		if a.applyStartupModels(agentSessionID, session, threadResult, models) {
			if attempt > 0 {
				slog.Info("agent session app-server model list resolved after retry",
					"agent_session_id", agentSessionID,
					"attempts", attempt+1,
				)
			}
			return true
		}
		if attempt == len(backoffs) {
			break
		}
		if sleep != nil && !sleep(ctx, backoffs[attempt]) {
			return false
		}
	}
	slog.Warn("agent session app-server model list never resolved",
		"agent_session_id", agentSessionID,
		"attempts", len(backoffs)+1,
	)
	return false
}

func (a *CodexAppServerAdapter) emitStartupMetadataRefreshEvent(session Session, agentSessionID string) {
	a.emitSessionEvents(agentSessionID, []activityshared.Event{
		newSessionActivityEvent(session, EventSessionUpdated, SessionStatusReady, map[string]any{
			"appServerMetadataRefresh": true,
		}),
	})
}

// defaultStartupModelRetryBackoffs ramps quickly then settles at a steady 30s
// cadence, giving codex time to recover from transient hiccups (rate limits,
// a still-materializing platform package, a slow first model/list) while
// keeping the background goroutine bounded.
func defaultStartupModelRetryBackoffs() []time.Duration {
	backoffs := []time.Duration{
		time.Second,
		2 * time.Second,
		5 * time.Second,
		10 * time.Second,
	}
	for i := 0; i < startupModelSteadyRetryCount; i++ {
		backoffs = append(backoffs, 30*time.Second)
	}
	return backoffs
}

// nextTurnLifecycleSeq allocates the next per-session lifecycle snapshot
// sequence number.
func (a *CodexAppServerAdapter) nextTurnLifecycleSeq(agentSessionID string) uint64 {
	a.mu.Lock()
	defer a.mu.Unlock()
	appSession := a.sessions[strings.TrimSpace(agentSessionID)]
	if appSession == nil {
		return 0
	}
	appSession.lifecycleSeq++
	return appSession.lifecycleSeq
}

// stampTurnLifecycleSnapshots stamps an adapter-origin TurnLifecycle snapshot
// onto every turn.* event in the batch (ADR 0008); see
// stampAdapterTurnLifecycleEvents for the contract.
func (a *CodexAppServerAdapter) stampTurnLifecycleSnapshots(agentSessionID string, events []activityshared.Event) []activityshared.Event {
	return stampAdapterTurnLifecycleEvents(events, func() uint64 {
		return a.nextTurnLifecycleSeq(agentSessionID)
	})
}

func (a *CodexAppServerAdapter) emitSessionEvents(agentSessionID string, events []activityshared.Event) {
	if a == nil || len(events) == 0 {
		return
	}
	a.mu.Lock()
	sink := a.eventSink
	a.mu.Unlock()
	if sink == nil {
		return
	}
	sink(agentSessionID, events)
}
