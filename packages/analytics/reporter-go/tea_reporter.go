package reporter

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
)

// TeaReporter reports events through the DataFinder SDK.
type TeaReporter struct {
	appID  int64
	common reporterCommon
	sdk    teaSDK
	debug  DebugPublisher
}

func newTeaReporter(config Config) (*TeaReporter, error) {
	return newTeaReporterWithSDK(config, defaultTeaSDK{})
}

func newTeaReporterWithSDK(config Config, sdk teaSDK) (*TeaReporter, error) {
	sdkLogDir := strings.TrimSpace(config.SDKLogDir)
	if sdkLogDir == "" {
		stateDir := strings.TrimSpace(config.StateDir)
		if stateDir == "" {
			return nil, fmt.Errorf("analytics state directory or SDK log directory is required for DataFinder SDK logs")
		}
		sdkLogDir = filepath.Join(stateDir, "analytics", "sdk-logs")
	}
	common, err := newReporterCommon(config)
	if err != nil {
		return nil, err
	}
	if err := sdk.Init(teaSDKConfig{
		AppID:         config.Analytics.AppID,
		AppKey:        config.Analytics.AppKey,
		ChannelDomain: config.Analytics.ChannelDomain,
		LogDir:        sdkLogDir,
	}); err != nil {
		return nil, err
	}
	return &TeaReporter{
		appID:  config.Analytics.AppID,
		common: common,
		sdk:    sdk,
		debug:  config.DebugPublisher,
	}, nil
}

func (r *TeaReporter) Track(ctx context.Context, events ...Event) {
	if len(events) == 0 {
		return
	}

	common := r.common.params()
	sendEvents := normalizeEvents(events, common)
	if len(sendEvents) == 0 {
		return
	}

	r.publishDebugEvents(ctx, sendEvents, common)
	_ = r.sdk.Send(r.appID, r.common.deviceID, sendEvents, common)
}

func (r *TeaReporter) Close() error {
	return r.sdk.Close()
}

func (r *TeaReporter) publishDebugEvents(ctx context.Context, events []teaSDKEvent, common map[string]any) {
	if r.debug == nil || len(events) == 0 {
		return
	}
	debugEvents := make([]DebugEvent, 0, len(events))
	for _, event := range events {
		params := copyParams(event.Params)
		if params == nil {
			params = map[string]any{}
		}
		for key, value := range common {
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
