//go:build !darwin || ios

package networkchange

import (
	"context"
	"time"
)

type systemSource struct{}

func (systemSource) Sample(ctx context.Context) (Fingerprint, error) {
	return sampleLocalNetwork(ctx)
}

func (systemSource) Watch(context.Context) (<-chan struct{}, error) {
	return nil, ErrWatcherUnavailable
}

const defaultSafetyRecheck time.Duration = 0
