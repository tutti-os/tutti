package sessionreplay

import (
	"context"
	"errors"
	"strings"
)

func (w *Workflow) CreateReplayRun(
	ctx context.Context,
	cassetteID string,
) (ReplayRun, error) {
	cassetteID = strings.TrimSpace(cassetteID)
	if cassetteID == "" || w.Store == nil || w.NewID == nil {
		return ReplayRun{}, ErrInvalidState
	}
	if _, err := w.Store.GetCassette(ctx, cassetteID); err != nil {
		return ReplayRun{}, err
	}
	now := w.now().UnixMilli()
	run := ReplayRun{
		ID:              strings.TrimSpace(w.NewID()),
		CassetteID:      cassetteID,
		Status:          ReplayRunStatusStarting,
		CreatedAtUnixMS: now,
		UpdatedAtUnixMS: now,
	}
	if run.ID == "" {
		return ReplayRun{}, ErrInvalidState
	}
	if err := w.Store.PutReplayRun(ctx, run); err != nil {
		return ReplayRun{}, err
	}
	return run, nil
}

// PrepareReplayRun creates one durable run and resolves its immutable
// Cassette before a product adapter launches Electron or another isolated
// replay surface.
func (w *Workflow) PrepareReplayRun(
	ctx context.Context,
	cassetteID string,
) (ReplayRequest, error) {
	run, err := w.CreateReplayRun(ctx, cassetteID)
	if err != nil {
		return ReplayRequest{}, err
	}
	cassette, err := w.Store.GetCassette(ctx, run.CassetteID)
	if err != nil {
		_, failErr := w.failReplayRun(ctx, run, "cassette_not_found", err)
		return ReplayRequest{}, errors.Join(err, failErr)
	}
	if w.Artifacts == nil {
		err = ErrInvalidState
		_, failErr := w.failReplayRun(ctx, run, "artifact_store_unavailable", err)
		return ReplayRequest{}, errors.Join(err, failErr)
	}
	artifact, err := w.Artifacts.Resolve(ctx, cassette)
	if err != nil {
		_, failErr := w.failReplayRun(ctx, run, "cassette_resolve_failed", err)
		return ReplayRequest{}, errors.Join(err, failErr)
	}
	return ReplayRequest{Run: run, Artifact: artifact}, nil
}

// MarkReplayRunRunning records that an external runtime adapter accepted the
// prepared run. It exists alongside StartReplayRun because Tutti Desktop owns
// Electron launch while other consumers may provide an in-process
// ReplayRuntime.
func (w *Workflow) MarkReplayRunRunning(
	ctx context.Context,
	runID string,
) (ReplayRun, error) {
	if w.Store == nil {
		return ReplayRun{}, ErrInvalidState
	}
	run, err := w.Store.GetReplayRun(ctx, strings.TrimSpace(runID))
	if err != nil {
		return ReplayRun{}, err
	}
	if err := TransitionReplayRun(&run, ReplayRunTransition{
		Status:     ReplayRunStatusRunning,
		AtUnixMS:   w.now().UnixMilli(),
		Checkpoint: run.Checkpoint,
	}); err != nil {
		return ReplayRun{}, err
	}
	if err := w.Store.PutReplayRun(ctx, run); err != nil {
		return ReplayRun{}, err
	}
	return run, nil
}

func (w *Workflow) StartReplayRun(ctx context.Context, runID string) (ReplayRun, error) {
	if w.Store == nil || w.Artifacts == nil || w.Runtime == nil {
		return ReplayRun{}, ErrInvalidState
	}
	run, err := w.Store.GetReplayRun(ctx, strings.TrimSpace(runID))
	if err != nil {
		return ReplayRun{}, err
	}
	cassette, err := w.Store.GetCassette(ctx, run.CassetteID)
	if err != nil {
		return w.failReplayRun(ctx, run, "cassette_not_found", err)
	}
	artifact, err := w.Artifacts.Resolve(ctx, cassette)
	if err != nil {
		return w.failReplayRun(ctx, run, "cassette_resolve_failed", err)
	}
	run, err = w.MarkReplayRunRunning(ctx, run.ID)
	if err != nil {
		return ReplayRun{}, err
	}
	if err := w.Runtime.Start(ctx, ReplayRequest{Run: run, Artifact: artifact}); err != nil {
		return w.failReplayRun(ctx, run, "runtime_start_failed", err)
	}
	return run, nil
}

func (w *Workflow) CompleteReplayRun(
	ctx context.Context,
	runID string,
	checkpoint int64,
) (ReplayRun, error) {
	run, err := w.Store.GetReplayRun(ctx, strings.TrimSpace(runID))
	if err != nil {
		return ReplayRun{}, err
	}
	if err := TransitionReplayRun(&run, ReplayRunTransition{
		Status:     ReplayRunStatusComplete,
		AtUnixMS:   w.now().UnixMilli(),
		Checkpoint: checkpoint,
	}); err != nil {
		return ReplayRun{}, err
	}
	if err := w.Store.PutReplayRun(ctx, run); err != nil {
		return ReplayRun{}, err
	}
	return run, nil
}

// AdvanceReplayRunCheckpoint persists one newly reached stable checkpoint.
// Seeking backward creates a new ReplayRun instead of moving this cursor.
func (w *Workflow) AdvanceReplayRunCheckpoint(
	ctx context.Context,
	runID string,
	checkpoint int64,
) (ReplayRun, error) {
	if w.Store == nil {
		return ReplayRun{}, ErrInvalidState
	}
	run, err := w.Store.GetReplayRun(ctx, strings.TrimSpace(runID))
	if err != nil {
		return ReplayRun{}, err
	}
	if run.Status != ReplayRunStatusRunning {
		return ReplayRun{}, ErrInvalidState
	}
	if err := TransitionReplayRun(&run, ReplayRunTransition{
		Status:     ReplayRunStatusRunning,
		AtUnixMS:   w.now().UnixMilli(),
		Checkpoint: checkpoint,
	}); err != nil {
		return ReplayRun{}, err
	}
	if err := w.Store.PutReplayRun(ctx, run); err != nil {
		return ReplayRun{}, err
	}
	return run, nil
}

func (w *Workflow) FailReplayRun(
	ctx context.Context,
	runID string,
	checkpoint int64,
	code string,
	cause error,
) (ReplayRun, error) {
	run, err := w.Store.GetReplayRun(ctx, strings.TrimSpace(runID))
	if err != nil {
		return ReplayRun{}, err
	}
	if checkpoint < run.Checkpoint {
		return ReplayRun{}, ErrInvalidState
	}
	run.Checkpoint = checkpoint
	failed, failErr := w.failReplayRun(ctx, run, code, cause)
	if failed.Status == ReplayRunStatusFailed {
		return failed, nil
	}
	return ReplayRun{}, failErr
}

func (w *Workflow) GetReplayRun(ctx context.Context, runID string) (ReplayRun, error) {
	if w.Store == nil {
		return ReplayRun{}, ErrInvalidState
	}
	return w.Store.GetReplayRun(ctx, strings.TrimSpace(runID))
}

func (w *Workflow) ListReplayRuns(
	ctx context.Context,
	cassetteID string,
) ([]ReplayRun, error) {
	if w.Store == nil {
		return nil, ErrInvalidState
	}
	return w.Store.ListReplayRuns(ctx, strings.TrimSpace(cassetteID))
}

func (w *Workflow) GetCassette(ctx context.Context, cassetteID string) (Cassette, error) {
	if w.Store == nil {
		return Cassette{}, ErrInvalidState
	}
	return w.Store.GetCassette(ctx, strings.TrimSpace(cassetteID))
}

func (w *Workflow) CancelReplayRun(ctx context.Context, runID string) (ReplayRun, error) {
	run, err := w.Store.GetReplayRun(ctx, strings.TrimSpace(runID))
	if err != nil {
		return ReplayRun{}, err
	}
	if run.Status == ReplayRunStatusComplete ||
		run.Status == ReplayRunStatusFailed ||
		run.Status == ReplayRunStatusCanceled {
		return run, nil
	}
	if w.Runtime != nil {
		if err := w.Runtime.Cancel(ctx, run.ID); err != nil {
			return ReplayRun{}, err
		}
	}
	if err := TransitionReplayRun(&run, ReplayRunTransition{
		Status:     ReplayRunStatusCanceled,
		AtUnixMS:   w.now().UnixMilli(),
		Checkpoint: run.Checkpoint,
	}); err != nil {
		return ReplayRun{}, err
	}
	if err := w.Store.PutReplayRun(ctx, run); err != nil {
		return ReplayRun{}, err
	}
	return run, nil
}

func (w *Workflow) failReplayRun(
	ctx context.Context,
	run ReplayRun,
	code string,
	cause error,
) (ReplayRun, error) {
	if cause == nil {
		cause = errors.New("replay run failed")
	}
	if err := TransitionReplayRun(&run, ReplayRunTransition{
		Status:       ReplayRunStatusFailed,
		AtUnixMS:     w.now().UnixMilli(),
		Checkpoint:   run.Checkpoint,
		ErrorCode:    strings.TrimSpace(code),
		ErrorMessage: cause.Error(),
	}); err != nil {
		return ReplayRun{}, errors.Join(cause, err)
	}
	if err := w.Store.PutReplayRun(ctx, run); err != nil {
		return ReplayRun{}, errors.Join(cause, err)
	}
	return run, cause
}
