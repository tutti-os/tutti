package conformance

import (
	"context"
	"errors"
	"fmt"
)

func WorkspaceRuntimeAdmissionScenarios() []WorkspaceRuntimeAdmissionScenario {
	return []WorkspaceRuntimeAdmissionScenario{
		{Name: "disconnect fence survives canceled drain wait", run: runDisconnectFenceSurvivesCanceledDrainWait},
		{Name: "joined disconnect owners release independently", run: runJoinedDisconnectOwnersReleaseIndependently},
		{Name: "admitted callback context is reentrant", run: runAdmittedCallbackContextIsReentrant},
		{Name: "admitted callback releases after panic", run: runAdmittedCallbackReleasesAfterPanic},
		{Name: "canceled callback does not enter", run: runCanceledCallbackDoesNotEnter},
		{Name: "release before wait is idempotent", run: runReleaseBeforeWaitIsIdempotent},
	}
}

func runDisconnectFenceSurvivesCanceledDrainWait(ctx context.Context, driver WorkspaceRuntimeAdmissionDriver) error {
	operationEntered := make(chan struct{})
	releaseOperation := make(chan struct{})
	operationDone := make(chan error, 1)
	go func() {
		operationDone <- driver.WithWorkspaceRuntimeOperation(ctx, "workspace-1", func(context.Context) error {
			close(operationEntered)
			<-releaseOperation
			return nil
		})
	}()
	<-operationEntered

	fence, err := driver.AcquireWorkspaceRuntimeDisconnectFence(ctx, "workspace-1")
	if err != nil {
		return fmt.Errorf("acquire disconnect fence: %w", err)
	}
	defer fence.Release()
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := fence.Wait(canceled); !errors.Is(err, context.Canceled) {
		return fmt.Errorf("canceled drain wait error=%v, want context canceled", err)
	}

	blockedEntered := make(chan struct{})
	blockedDone := make(chan error, 1)
	go func() {
		blockedDone <- driver.WithWorkspaceRuntimeOperation(ctx, "workspace-1", func(context.Context) error {
			close(blockedEntered)
			return nil
		})
	}()
	select {
	case <-blockedEntered:
		return errors.New("runtime operation entered after canceled fence wait")
	default:
	}
	close(releaseOperation)
	if err := <-operationDone; err != nil {
		return fmt.Errorf("release admitted operation: %w", err)
	}
	if _, err := fence.Wait(ctx); err != nil {
		return fmt.Errorf("retry drain wait: %w", err)
	}
	select {
	case <-blockedEntered:
		return errors.New("runtime operation entered while drained fence remained held")
	default:
	}
	fence.Release()
	if err := <-blockedDone; err != nil {
		return fmt.Errorf("blocked operation after release: %w", err)
	}
	return nil
}

func runJoinedDisconnectOwnersReleaseIndependently(ctx context.Context, driver WorkspaceRuntimeAdmissionDriver) error {
	first, err := driver.AcquireWorkspaceRuntimeDisconnectFence(ctx, "workspace-1")
	if err != nil {
		return err
	}
	defer first.Release()
	second, err := driver.AcquireWorkspaceRuntimeDisconnectFence(ctx, "workspace-1")
	if err != nil {
		return err
	}
	defer second.Release()
	if _, err := first.Wait(ctx); err != nil {
		return err
	}
	first.Release()

	entered := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- driver.WithWorkspaceRuntimeOperation(ctx, "workspace-1", func(context.Context) error {
			close(entered)
			return nil
		})
	}()
	select {
	case <-entered:
		return errors.New("one joined owner reopened admission")
	default:
	}
	if _, err := second.Wait(ctx); err != nil {
		return err
	}
	second.Release()
	return <-done
}

func runAdmittedCallbackContextIsReentrant(ctx context.Context, driver WorkspaceRuntimeAdmissionDriver) error {
	return driver.WithWorkspaceRuntimeOperation(ctx, "workspace-1", func(admittedCtx context.Context) error {
		return driver.WithWorkspaceRuntimeOperation(admittedCtx, "workspace-1", func(context.Context) error {
			return nil
		})
	})
}

func runAdmittedCallbackReleasesAfterPanic(ctx context.Context, driver WorkspaceRuntimeAdmissionDriver) (err error) {
	func() {
		defer func() {
			if recovered := recover(); recovered == nil {
				err = errors.New("admitted callback panic was swallowed")
			}
		}()
		_ = driver.WithWorkspaceRuntimeOperation(ctx, "workspace-1", func(context.Context) error {
			panic("expected admission cleanup panic")
		})
	}()
	if err != nil {
		return err
	}
	fence, err := driver.AcquireWorkspaceRuntimeDisconnectFence(ctx, "workspace-1")
	if err != nil {
		return err
	}
	defer fence.Release()
	if _, err := fence.Wait(ctx); err != nil {
		return fmt.Errorf("panic leaked admitted operation: %w", err)
	}
	return nil
}

func runCanceledCallbackDoesNotEnter(ctx context.Context, driver WorkspaceRuntimeAdmissionDriver) error {
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	entered := false
	err := driver.WithWorkspaceRuntimeOperation(canceled, "workspace-1", func(context.Context) error {
		entered = true
		return nil
	})
	if !errors.Is(err, context.Canceled) {
		return fmt.Errorf("canceled callback error=%v, want context canceled", err)
	}
	if entered {
		return errors.New("canceled callback entered runtime mutation")
	}
	return nil
}

func runReleaseBeforeWaitIsIdempotent(ctx context.Context, driver WorkspaceRuntimeAdmissionDriver) error {
	fence, err := driver.AcquireWorkspaceRuntimeDisconnectFence(ctx, "workspace-1")
	if err != nil {
		return err
	}
	fence.Release()
	fence.Release()
	if _, err := fence.Wait(ctx); err == nil {
		return errors.New("released fence granted an exclusive context")
	}
	return driver.WithWorkspaceRuntimeOperation(ctx, "workspace-1", func(context.Context) error {
		return nil
	})
}
