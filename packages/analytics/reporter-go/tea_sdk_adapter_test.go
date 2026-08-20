package reporter

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	sdk "github.com/volcengine/datarangers-sdk-go"
)

func TestTeaSDKPayloadUsesPresetHeaderAndEventID(t *testing.T) {
	var payload []byte
	adapter := defaultTeaSDK{
		sendEventsWithHeader: func(_ sdk.AppType, appID int64, header *sdk.Header, events []*sdk.EventV3) error {
			var err error
			payload, err = json.Marshal(&sdk.ServerSdkEventMessage{
				AppId:   &appID,
				Header:  header,
				EventV3: events,
			})
			return err
		},
	}
	eventID := "event-1"
	err := adapter.Send(
		20004092,
		"user-1",
		[]teaSDKEvent{{
			Name:     "workspace.opened",
			ClientTS: 1749124800000,
			EventID:  eventID,
			Params:   map[string]any{"event_id": eventID},
		}},
		map[string]any{"os": "darwin", "app_version": "1.2.3-rc.4"},
		teaSDKHeader{
			AppVersion:      "1.2.3-rc.4",
			AppVersionMinor: "1.2.3-rc.4",
			OSName:          "darwin",
			OSVersion:       "15.6",
			CPUABI:          "arm64",
		},
	)
	if err != nil {
		t.Fatalf("Send() error = %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(payload, &decoded); err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	decodedHeader := decoded["header"].(map[string]any)
	for key, want := range map[string]string{
		"app_version":       "1.2.3-rc.4",
		"app_version_minor": "1.2.3-rc.4",
		"os_name":           "darwin",
		"os_version":        "15.6",
		"cpu_abi":           "arm64",
	} {
		if got := decodedHeader[key]; got != want {
			t.Fatalf("header[%q] = %v, want %q; payload=%s", key, got, want, payload)
		}
	}
	decodedEvent := decoded["event_v3"].([]any)[0].(map[string]any)
	if got := decodedEvent["event_id"]; got != eventID {
		t.Fatalf("event_id = %v, want %q; payload=%s", got, eventID, payload)
	}
}

func TestEnsureTeaSDKLogDirSecuresExistingDirectory(t *testing.T) {
	logDir := filepath.Join(t.TempDir(), "sdk-logs")
	if err := os.MkdirAll(logDir, 0o755); err != nil {
		t.Fatalf("create test log directory: %v", err)
	}
	if err := os.Chmod(logDir, 0o755); err != nil {
		t.Fatalf("set test log directory permissions: %v", err)
	}

	got, err := ensureTeaSDKLogDir(logDir)
	if err != nil {
		t.Fatalf("ensureTeaSDKLogDir() error = %v", err)
	}
	if got != logDir {
		t.Fatalf("log directory = %q, want %q", got, logDir)
	}
	info, err := os.Stat(logDir)
	if err != nil {
		t.Fatalf("stat log directory: %v", err)
	}
	if permissions := info.Mode().Perm(); permissions != 0o700 {
		t.Fatalf("log directory permissions = %o, want 700", permissions)
	}
}

func TestTeaSDKInitializationGuardRejectsConflictingConfiguration(t *testing.T) {
	var guard teaSDKInitializationGuard
	config := teaSDKConfig{
		AppID:         1,
		AppKey:        "key",
		ChannelDomain: "https://example.test",
		LogDir:        "/tmp/analytics",
	}
	initCalls := 0
	initialize := func() error {
		initCalls++
		return nil
	}

	if err := guard.init(config, initialize); err != nil {
		t.Fatalf("first init error = %v", err)
	}
	if err := guard.init(config, initialize); err != nil {
		t.Fatalf("equivalent init error = %v", err)
	}
	conflicting := config
	conflicting.AppID = 2
	if err := guard.init(conflicting, initialize); err == nil {
		t.Fatal("conflicting init error = nil, want conflict")
	}
	if initCalls != 1 {
		t.Fatalf("initialize calls = %d, want 1", initCalls)
	}
}

func TestTeaSDKInitializationGuardRetriesFailedInitialization(t *testing.T) {
	var guard teaSDKInitializationGuard
	config := teaSDKConfig{AppID: 1}
	initCalls := 0

	if err := guard.init(config, func() error {
		initCalls++
		return errors.New("temporary failure")
	}); err == nil {
		t.Fatal("first init error = nil, want failure")
	}
	if err := guard.init(config, func() error {
		initCalls++
		return nil
	}); err != nil {
		t.Fatalf("retry init error = %v", err)
	}
	if initCalls != 2 {
		t.Fatalf("initialize calls = %d, want 2", initCalls)
	}
}

func TestNewTeaSDKSysConfKeepsBoundedHTTPSettings(t *testing.T) {
	config := teaSDKConfig{
		AppID:         1,
		AppKey:        "key",
		ChannelDomain: "https://example.test",
	}
	logDir := filepath.Join(t.TempDir(), "sdk-logs")

	got := newTeaSDKSysConf(config, logDir)

	if got.SdkConfig.Mode != sdk.MODE_HTTP || got.SdkConfig.LogLevel != "ERROR" {
		t.Fatalf("SDK config = %#v, want HTTP ERROR mode", got.SdkConfig)
	}
	if got.FileConfig.Path != filepath.Join(logDir, "datarangers.log") ||
		got.FileConfig.ErrPath != filepath.Join(logDir, "error-datarangers.log") {
		t.Fatalf("file config = %#v, want files beneath %q", got.FileConfig, logDir)
	}
	if got.FileConfig.MaxSize != 5 || got.FileConfig.MaxBackup != 2 || got.FileConfig.MaxAge != 7 {
		t.Fatalf("file rotation = %#v, want bounded defaults", got.FileConfig)
	}
	if got.AsynConfig.Routine != 1 || got.AsynConfig.WaitTimeout != 50 {
		t.Fatalf("async config = %#v, want one routine and 50ms wait", got.AsynConfig)
	}
	if got.BatchConfig.Enable {
		t.Fatal("batch mode enabled, want disabled")
	}
	if err := got.ErrHandler(nil, errors.New("transport")); err != nil {
		t.Fatalf("error handler returned %v, want nil", err)
	}
}
