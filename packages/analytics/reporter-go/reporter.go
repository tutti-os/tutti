// Package reporter provides the product-neutral analytics transport used by
// Tutti daemons. Product code owns event names and event-specific parameters.
package reporter

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/gofrs/flock"
	"github.com/google/uuid"
)

// Event is the daemon-side representation of one analytics event.
type Event struct {
	Name     string
	ClientTS int64
	Params   map[string]any
}

// DebugEvent contains the final event payload after daemon-owned common
// parameters have been applied.
type DebugEvent struct {
	Name     string
	ClientTS int64
	Params   map[string]any
}

// DebugPublisher receives best-effort debug copies of analytics events.
type DebugPublisher interface {
	PublishAnalyticsDebugEvents(context.Context, []DebugEvent)
}

// Reporter accepts analytics events without exposing the vendor SDK.
type Reporter interface {
	Track(ctx context.Context, events ...Event)
	Close() error
}

// AnalyticsConfig contains vendor transport configuration.
type AnalyticsConfig struct {
	Disabled      bool
	Debug         bool
	AppID         int64
	AppKey        string
	Channel       string
	ChannelDomain string
	AppVersion    string
}

// Config configures a reporter instance.
//
// DeviceID should be supplied when the host already owns a stable installation
// identity. Otherwise the reporter persists one under StateDir. SDKLogDir lets
// hosts preserve an existing log location; when omitted it defaults beneath
// StateDir.
type Config struct {
	Analytics      AnalyticsConfig
	DebugPublisher DebugPublisher
	StateDir       string
	SDKLogDir      string
	DeviceID       string
	CommonParams   map[string]any
}

// New selects a disabled, debug-only, or DataFinder-backed reporter.
func New(config Config) (Reporter, error) {
	if config.Analytics.Disabled {
		return &NoopReporter{}, nil
	}
	if config.Analytics.Debug {
		return newDebugReporter(config)
	}
	if shouldUseNoop(config.Analytics) {
		return &NoopReporter{}, nil
	}
	return newTeaReporter(config)
}

func shouldUseNoop(config AnalyticsConfig) bool {
	return config.AppID <= 0 ||
		strings.TrimSpace(config.AppKey) == "" ||
		strings.TrimSpace(config.ChannelDomain) == ""
}

func resolveDeviceID(config Config) (string, error) {
	if deviceID := strings.TrimSpace(config.DeviceID); deviceID != "" {
		return deviceID, nil
	}
	if strings.TrimSpace(config.StateDir) == "" {
		return "", fmt.Errorf("analytics state directory is required when device ID is not supplied")
	}
	return loadOrCreateDeviceID(config.StateDir)
}

func loadOrCreateDeviceID(stateDir string) (string, error) {
	path := filepath.Join(stateDir, "device_id")
	if value, exists, err := readDeviceID(path); err != nil {
		return "", err
	} else if exists {
		return value, nil
	}

	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		return "", fmt.Errorf("create analytics state dir: %w", err)
	}

	deviceIDCreationMu.Lock()
	defer deviceIDCreationMu.Unlock()

	identityLock := flock.New(path + ".lock")
	if err := identityLock.Lock(); err != nil {
		return "", fmt.Errorf("lock analytics device id: %w", err)
	}
	defer func() {
		_ = identityLock.Unlock()
	}()

	if value, exists, err := readDeviceID(path); err != nil {
		return "", err
	} else if exists {
		return value, nil
	}

	deviceID := uuid.NewString()
	file, err := os.CreateTemp(stateDir, ".device_id-*")
	if err != nil {
		return "", fmt.Errorf("create analytics device id temp file: %w", err)
	}
	tempPath := file.Name()
	defer func() {
		_ = os.Remove(tempPath)
	}()
	if err := file.Chmod(0o600); err != nil {
		_ = file.Close()
		return "", fmt.Errorf("secure analytics device id temp file: %w", err)
	}
	if _, err := file.WriteString(deviceID + "\n"); err != nil {
		_ = file.Close()
		return "", fmt.Errorf("write analytics device id: %w", err)
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return "", fmt.Errorf("sync analytics device id: %w", err)
	}
	if err := file.Close(); err != nil {
		return "", fmt.Errorf("close analytics device id: %w", err)
	}
	if err := os.Rename(tempPath, path); err != nil {
		return "", fmt.Errorf("replace analytics device id: %w", err)
	}
	return deviceID, nil
}

var deviceIDCreationMu sync.Mutex

func readDeviceID(path string) (value string, exists bool, err error) {
	content, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return "", false, nil
	}
	if err != nil {
		return "", false, fmt.Errorf("read analytics device id: %w", err)
	}
	value = strings.TrimSpace(string(content))
	return value, value != "", nil
}

type reporterCommon struct {
	deviceID   string
	sessionID  string
	appVersion string
	osName     string
	additional map[string]any
}

func newReporterCommon(config Config) (reporterCommon, error) {
	deviceID, err := resolveDeviceID(config)
	if err != nil {
		return reporterCommon{}, err
	}
	return reporterCommon{
		deviceID:   deviceID,
		sessionID:  uuid.NewString(),
		appVersion: config.Analytics.AppVersion,
		osName:     runtime.GOOS,
		additional: copyParams(config.CommonParams),
	}, nil
}

func (c reporterCommon) params() map[string]any {
	params := copyParams(c.additional)
	if params == nil {
		params = map[string]any{}
	}
	params["device_id"] = c.deviceID
	params["session_id"] = c.sessionID
	params["app_version"] = c.appVersion
	params["os"] = c.osName
	return params
}

func normalizeEvents(events []Event, common map[string]any) []teaSDKEvent {
	normalized := make([]teaSDKEvent, 0, len(events))
	for _, event := range events {
		if event.Name == "" {
			continue
		}
		clientTS := event.ClientTS
		if clientTS <= 0 {
			clientTS = time.Now().UnixMilli()
		}
		params := copyParams(event.Params)
		for key := range common {
			delete(params, key)
		}
		normalized = append(normalized, teaSDKEvent{
			Name:     event.Name,
			ClientTS: clientTS,
			Params:   params,
		})
	}
	return normalized
}

func copyParams(params map[string]any) map[string]any {
	if params == nil {
		return nil
	}
	copied := make(map[string]any, len(params))
	for key, value := range params {
		copied[key] = value
	}
	return copied
}
