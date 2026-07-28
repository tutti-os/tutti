package reporter

import "context"

// NoopReporter accepts and drops events.
type NoopReporter struct{}

func (NoopReporter) Track(context.Context, ...Event) {}

func (NoopReporter) Close() error {
	return nil
}
