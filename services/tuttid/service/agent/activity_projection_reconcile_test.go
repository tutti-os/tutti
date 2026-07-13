package agent

import (
	"context"
	"errors"
	"testing"
)

func TestSettleStaleTurnsOnStartupReturnsRepositoryFailure(t *testing.T) {
	want := errors.New("settle stale turns failed")
	projection := NewActivityProjection(&activityProjectionRepoStub{settleStaleErr: want})
	if err := projection.SettleStaleTurnsOnStartup(context.Background()); !errors.Is(err, want) {
		t.Fatalf("SettleStaleTurnsOnStartup() error = %v, want %v", err, want)
	}
}
