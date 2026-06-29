package agentstatus

import (
	"context"
	"log/slog"
	"strings"
	"sync"
	"sync/atomic"
)

// Each install run owns its provider's active action via a unique token carried
// on the run's context. Mutators are token-scoped: a stale or superseded run can
// neither append into, overwrite, nor clear a newer run's active action for the
// same provider. This prevents two concurrent installs of the SAME provider from
// cross-contaminating stdout or having the first run's deferred clear delete the
// second run's entry. Concurrent installs of DIFFERENT providers are unaffected
// (separate map entries).
type activeActionTokenKey struct{}

var activeActionTokenSeq atomic.Uint64

func nextActiveActionToken() uint64 {
	return activeActionTokenSeq.Add(1)
}

func withActiveActionToken(ctx context.Context, token uint64) context.Context {
	return context.WithValue(ctx, activeActionTokenKey{}, token)
}

func activeActionTokenFromContext(ctx context.Context) uint64 {
	if ctx == nil {
		return 0
	}
	if token, ok := ctx.Value(activeActionTokenKey{}).(uint64); ok {
		return token
	}
	return 0
}

type ownedActiveAction struct {
	action ActiveAction
	token  uint64
}

var activeActions = struct {
	sync.Mutex
	byProvider map[string]ownedActiveAction
}{
	byProvider: map[string]ownedActiveAction{},
}

// claimActiveAction unconditionally takes ownership of the provider's active
// action for the run identified by the context token. Call it once at the start
// of a run; every later setActiveAction/append/clear for the same provider only
// takes effect while this token still owns the entry.
func claimActiveAction(ctx context.Context, provider string, action ActiveAction) {
	token := activeActionTokenFromContext(ctx)
	activeActions.Lock()
	activeActions.byProvider[provider] = ownedActiveAction{action: action, token: token}
	activeActions.Unlock()
	logActiveActionSet(provider, action)
}

// setActiveAction updates the provider's active action only while the context
// token still owns it (a superseded run is a no-op). Ownership is established by
// claimActiveAction, never here.
func setActiveAction(ctx context.Context, provider string, action ActiveAction) {
	token := activeActionTokenFromContext(ctx)
	activeActions.Lock()
	owned, ok := activeActions.byProvider[provider]
	if !ok || owned.token != token {
		activeActions.Unlock()
		return
	}
	activeActions.byProvider[provider] = ownedActiveAction{action: action, token: token}
	activeActions.Unlock()
	logActiveActionSet(provider, action)
}

func logActiveActionSet(provider string, action ActiveAction) {
	bytes, lines := activeActionOutputStats(action.Stdout)
	slog.Info(
		"agent provider active action set",
		"event", "tutti.agent_provider.active_action.set",
		"provider", provider,
		"actionId", action.ID,
		"status", action.Status,
		"step", action.Step,
		"registryPresent", strings.TrimSpace(action.Registry) != "",
		"stdoutBytes", bytes,
		"stdoutLines", lines,
	)
}

func appendActiveActionStdout(ctx context.Context, provider string, output string) {
	if output == "" {
		return
	}
	token := activeActionTokenFromContext(ctx)
	activeActions.Lock()
	owned, ok := activeActions.byProvider[provider]
	if !ok || owned.token != token {
		activeActions.Unlock()
		return
	}
	owned.action.Stdout = trimActionOutput(owned.action.Stdout + output)
	activeActions.byProvider[provider] = owned
	activeActions.Unlock()
	bytes, lines := activeActionOutputStats(owned.action.Stdout)
	slog.Info(
		"agent provider active action output appended",
		"event", "tutti.agent_provider.active_action.output_appended",
		"provider", provider,
		"chunkBytes", len(output),
		"stdoutBytes", bytes,
		"stdoutLines", lines,
	)
}

func activeActionStdoutAppender(ctx context.Context, provider string) func(string) {
	return func(output string) {
		appendActiveActionStdout(ctx, provider, output)
	}
}

// clearActiveAction removes the provider's active action only while the context
// token still owns it, so a superseded run's deferred clear cannot delete the
// active action a newer run for the same provider has taken over.
func clearActiveAction(ctx context.Context, provider string) {
	token := activeActionTokenFromContext(ctx)
	activeActions.Lock()
	owned, ok := activeActions.byProvider[provider]
	if !ok || owned.token != token {
		activeActions.Unlock()
		return
	}
	delete(activeActions.byProvider, provider)
	activeActions.Unlock()
	bytes, lines := activeActionOutputStats(owned.action.Stdout)
	slog.Info(
		"agent provider active action cleared",
		"event", "tutti.agent_provider.active_action.cleared",
		"provider", provider,
		"actionId", owned.action.ID,
		"status", owned.action.Status,
		"step", owned.action.Step,
		"stdoutBytes", bytes,
		"stdoutLines", lines,
	)
}

func activeActionForProvider(provider string) *ActiveAction {
	activeActions.Lock()
	defer activeActions.Unlock()
	owned, ok := activeActions.byProvider[provider]
	if !ok {
		return nil
	}
	action := owned.action
	return &action
}

// providerInstallInFlight reports whether the provider currently has a running
// install action. The network does not change during an install, so List skips
// the slow connectivity probe for such providers — otherwise the per-second
// install-progress poll re-probes (and flickers) a flaky proxy on every tick.
func providerInstallInFlight(provider string) bool {
	action := activeActionForProvider(provider)
	return action != nil && action.ID == ActionInstall && action.Status == "running"
}

func activeActionOutputStats(output string) (int, int) {
	trimmed := strings.TrimSpace(output)
	if trimmed == "" {
		return 0, 0
	}
	return len(trimmed), strings.Count(trimmed, "\n") + 1
}
