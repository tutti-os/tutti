package workspace

import (
	"context"
	"log/slog"
	"sync/atomic"
	"time"

	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
)

var appRuntimeUpdatedUnixMs atomic.Int64

func (r *AppRunner) setRunningIfProcessCurrent(key string, start *appStart, process *appProcess, state workspacebiz.AppRuntimeState) bool {
	r.mu.Lock()
	current := r.states[key]
	if r.starts[key] != start || r.processes[key] != process || process.stopRequested || current.Status != workspacebiz.AppRuntimeStatusStarting {
		r.mu.Unlock()
		return false
	}
	updated := withRuntimeUpdated(state)
	r.states[key] = updated
	r.mu.Unlock()
	r.notifyStateChanged(key, updated)
	return true
}

func (r *AppRunner) setFailedForStart(key string, start *appStart, reason string, err error) (workspacebiz.AppRuntimeState, bool) {
	message := ""
	if err != nil {
		message = err.Error()
	}
	failurePhase := workspacebiz.AppFailurePhaseStarting
	return r.setStateForStart(key, start, workspacebiz.AppRuntimeState{
		Status:        workspacebiz.AppRuntimeStatusFailed,
		FailurePhase:  &failurePhase,
		FailureReason: &reason,
		LastError:     &message,
	})
}

func (r *AppRunner) setStateForStart(key string, start *appStart, state workspacebiz.AppRuntimeState) (workspacebiz.AppRuntimeState, bool) {
	r.mu.Lock()
	if r.starts[key] != start {
		current := currentRuntimeStateOrIdle(r.states[key])
		r.mu.Unlock()
		return current, false
	}
	updated := withRuntimeUpdated(state)
	r.states[key] = updated
	r.mu.Unlock()
	r.notifyStateChanged(key, updated)
	return updated, true
}

func (r *AppRunner) setState(key string, state workspacebiz.AppRuntimeState) workspacebiz.AppRuntimeState {
	r.ensure()
	r.mu.Lock()
	updated := withRuntimeUpdated(state)
	r.states[key] = updated
	r.mu.Unlock()
	r.notifyStateChanged(key, updated)
	return updated
}

func (r *AppRunner) notifyStateChanged(key string, state workspacebiz.AppRuntimeState) {
	if r.OnStateChanged == nil {
		return
	}
	r.OnStateChanged(appRuntimeWorkspaceIDFromKey(key), appRuntimeAppIDFromKey(key), state)
}

func (r *AppRunner) waitForProcess(key string, process *appProcess) {
	err := process.command.Wait()
	if process.containment != nil {
		_ = process.containment.close()
	}
	_ = process.logFile.Close()

	r.mu.Lock()
	if current := r.processes[key]; current != process {
		r.mu.Unlock()
		process.done <- err
		return
	}
	delete(r.processes, key)
	currentState := r.states[key]
	var nextState workspacebiz.AppRuntimeState
	if process.stopRequested {
		nextState = withRuntimeUpdated(workspacebiz.AppRuntimeState{Status: workspacebiz.AppRuntimeStatusIdle})
	} else {
		message := "workspace app process exited unexpectedly with status 0"
		if err != nil {
			message = err.Error()
		}
		failurePhase := workspacebiz.AppFailurePhaseStarting
		if currentState.Status == workspacebiz.AppRuntimeStatusRunning {
			failurePhase = workspacebiz.AppFailurePhaseRuntime
		}
		nextState = withRuntimeUpdated(workspacebiz.AppRuntimeState{
			Status:        workspacebiz.AppRuntimeStatusFailed,
			FailurePhase:  &failurePhase,
			FailureReason: stringPtr("process_exit"),
			LastError:     &message,
		})
	}
	if !process.stopRequested {
		lastError := ""
		if nextState.LastError != nil {
			lastError = *nextState.LastError
		}
		slog.Warn(
			"workspace_app_runtime_process_failed",
			"workspaceId", appRuntimeWorkspaceIDFromKey(key),
			"appId", appRuntimeAppIDFromKey(key),
			"failureReason", "process_exit",
			"lastError", lastError,
			"error", err,
		)
	}
	r.states[key] = nextState
	r.mu.Unlock()
	r.notifyStateChanged(key, nextState)
	process.done <- err
}

func (r *AppRunner) finishStart(key string, ctx context.Context, start *appStart) {
	r.mu.Lock()
	defer r.mu.Unlock()
	currentStart := r.starts[key]
	if currentStart == nil || currentStart != start {
		return
	}
	delete(r.starts, key)
	var nextState *workspacebiz.AppRuntimeState
	if ctx.Err() != nil && r.processes[key] == nil {
		current := r.states[key]
		if current.Status == workspacebiz.AppRuntimeStatusPreparing || current.Status == workspacebiz.AppRuntimeStatusStarting {
			state := withRuntimeUpdated(workspacebiz.AppRuntimeState{
				Status: workspacebiz.AppRuntimeStatusIdle,
			})
			r.states[key] = state
			nextState = &state
		}
	}
	if nextState != nil {
		go r.notifyStateChanged(key, *nextState)
	}
}

func waitForDetachedAppProcess(process *appProcess) {
	err := process.command.Wait()
	if process.containment != nil {
		_ = process.containment.close()
	}
	_ = process.logFile.Close()
	process.done <- err
}

func withRuntimeUpdated(state workspacebiz.AppRuntimeState) workspacebiz.AppRuntimeState {
	now := unixMsNow()
	for {
		previous := appRuntimeUpdatedUnixMs.Load()
		if now <= previous {
			now = previous + 1
		}
		if appRuntimeUpdatedUnixMs.CompareAndSwap(previous, now) {
			break
		}
	}
	state.UpdatedAtUnixMs = &now
	return state
}

func unixMsNow() int64 {
	return time.Now().UTC().UnixNano() / int64(time.Millisecond)
}

func stringPtr(value string) *string {
	return &value
}
