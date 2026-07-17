package agent

import (
	"context"
	"errors"
	"time"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
)

const runtimeOperationLeaseDuration = 30 * time.Second

type RuntimeOperationStore interface {
	agenthost.RuntimeOperationStore
	FindTurnByClientSubmitID(context.Context, string, string, string) (string, bool, error)
}
type RuntimeOperationEventPublisher = agenthost.RuntimeOperationEventPublisher

var ErrRuntimeOperationInProgress = agenthost.ErrRuntimeOperationInProgress
var ErrRuntimeOperationFailed = agenthost.ErrRuntimeOperationFailed

func isRetryableRuntimeOperationError(err error) bool {
	return err != nil && (errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) || errors.Is(err, ErrSessionNotFound) || errors.Is(err, ErrRuntimeSessionDisconnected))
}

func runtimeOperationNextAttemptAt(now time.Time, attempt int, failed bool) int64 {
	if failed {
		return 0
	}
	if attempt < 1 {
		attempt = 1
	}
	shift := attempt - 1
	if shift > 8 {
		shift = 8
	}
	return now.Add(time.Second * time.Duration(1<<shift)).UnixMilli()
}

func (s *Service) StepRuntimeOperationWorker(ctx context.Context, recovering bool) error {
	return s.applicationHost(serviceHostPreparation{service: s}).StepRuntimeOperationWorker(ctx, recovering)
}

func (s *Service) RecoverRuntimeOperations(ctx context.Context) error {
	return s.applicationHost(serviceHostPreparation{service: s}).RecoverRuntimeOperations(ctx)
}

func (s *Service) Recover(ctx context.Context) error {
	return s.applicationHost(serviceHostPreparation{service: s}).Recover(ctx)
}

func (s *Service) RunRuntimeOperationWorker(ctx context.Context) {
	s.applicationHost(serviceHostPreparation{service: s}).RunRuntimeOperationWorker(ctx)
}
