package conformance

import (
	"context"
	"errors"
	"fmt"
)

func runWorktreeSweepFailure(ctx context.Context, driver Driver) error {
	sweepErr := errors.New("conformance worktree sweep failure")
	fixture := liveSessionFixture("session-recovery-worktree-failure", "")
	fixture.WorktreeGCSweepErr = sweepErr
	if err := driver.Reset(ctx, fixture); err != nil {
		return err
	}
	if err := driver.RecoverCore(ctx); err != nil {
		return fmt.Errorf("recover core error=%v", err)
	}
	if err := driver.RecoverPostListener(ctx); err != nil {
		return fmt.Errorf("post-listener worktree sweep must degrade locally, got %v", err)
	}
	steps := driver.Metrics().RecoverySteps
	if len(steps) < 5 || !recoveryStepAppearsAfter(steps, 3, "stale_settle") {
		return fmt.Errorf("failed recovery steps=%v, want post-listener stale recovery", steps)
	}
	worktreeAttempts := 0
	for _, step := range steps[3:] {
		if step == "worktree_sweep" {
			worktreeAttempts++
		}
	}
	if worktreeAttempts != 3 {
		return fmt.Errorf("worktree recovery attempts=%d, want bounded 3; steps=%v", worktreeAttempts, steps)
	}
	return nil
}
