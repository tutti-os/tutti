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
	if err := driver.Recover(ctx); !errors.Is(err, sweepErr) {
		return fmt.Errorf("recover worktree sweep error=%v, want %v", err, sweepErr)
	}
	steps := driver.Metrics().RecoverySteps
	want := []string{"runtime_requeue", "goal_requeue", "goal_inbox_requeue", "stale_settle", "worktree_sweep"}
	if len(steps) != len(want) {
		return fmt.Errorf("failed recovery steps=%v, want %v", steps, want)
	}
	for index := range want {
		if steps[index] != want[index] {
			return fmt.Errorf("failed recovery steps=%v, want %v", steps, want)
		}
	}
	return nil
}
