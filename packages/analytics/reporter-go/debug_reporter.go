package reporter

import "context"

// DebugReporter publishes final analytics payloads only to the debug sink.
type DebugReporter struct {
	common reporterCommon
	debug  DebugPublisher
}

func newDebugReporter(config Config) (*DebugReporter, error) {
	common, err := newReporterCommon(config)
	if err != nil {
		return nil, err
	}
	return &DebugReporter{
		common: common,
		debug:  config.DebugPublisher,
	}, nil
}

func (r *DebugReporter) Track(ctx context.Context, events ...Event) {
	if r.debug == nil || len(events) == 0 {
		return
	}

	common, _ := r.common.snapshot()
	header := r.common.teaHeader()
	normalized := normalizeEvents(events, common, header)
	if len(normalized) == 0 {
		return
	}
	debugEvents := make([]DebugEvent, 0, len(normalized))
	for _, event := range normalized {
		params := copyParams(event.Params)
		if params == nil {
			params = map[string]any{}
		}
		for key, value := range common {
			params[key] = value
		}
		for key, value := range header.presetParams() {
			params[key] = value
		}
		debugEvents = append(debugEvents, DebugEvent{
			Name:     event.Name,
			ClientTS: event.ClientTS,
			Params:   params,
		})
	}
	r.debug.PublishAnalyticsDebugEvents(ctx, debugEvents)
}

func (*DebugReporter) Close() error {
	return nil
}
