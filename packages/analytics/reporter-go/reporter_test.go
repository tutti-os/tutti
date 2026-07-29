package reporter

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type fakeDebugPublisher struct {
	events []DebugEvent
}

func (f *fakeDebugPublisher) PublishAnalyticsDebugEvents(_ context.Context, events []DebugEvent) {
	f.events = append(f.events, events...)
}

type fakeTeaSDK struct {
	initConfig teaSDKConfig
	sends      []fakeTeaSend
	closed     bool
}

type fakeTeaSend struct {
	appID  int64
	uuid   string
	events []teaSDKEvent
	common map[string]any
}

func (f *fakeTeaSDK) Init(config teaSDKConfig) error {
	f.initConfig = config
	return nil
}

func (f *fakeTeaSDK) Send(appID int64, uuid string, events []teaSDKEvent, common map[string]any) error {
	f.sends = append(f.sends, fakeTeaSend{
		appID:  appID,
		uuid:   uuid,
		events: events,
		common: common,
	})
	return nil
}

func (f *fakeTeaSDK) Close() error {
	f.closed = true
	return nil
}

func TestNewSelectsNoopReporter(t *testing.T) {
	tests := []AnalyticsConfig{
		{Disabled: true},
		{AppKey: "key", ChannelDomain: "https://example.test"},
		{AppID: -1, AppKey: "key", ChannelDomain: "https://example.test"},
		{AppID: 1, ChannelDomain: "https://example.test"},
		{AppID: 1, AppKey: "  ", ChannelDomain: "https://example.test"},
		{AppID: 1, AppKey: "key"},
		{AppID: 1, AppKey: "key", ChannelDomain: "  "},
	}
	for _, analytics := range tests {
		got, err := New(Config{Analytics: analytics, StateDir: t.TempDir()})
		if err != nil {
			t.Fatalf("New() error = %v", err)
		}
		if _, ok := got.(*NoopReporter); !ok {
			t.Fatalf("reporter = %T, want *NoopReporter", got)
		}
	}
}

func TestDebugReporterUsesProvidedDeviceIDAndProtectsCommonParams(t *testing.T) {
	publisher := &fakeDebugPublisher{}
	got, err := New(Config{
		Analytics: AnalyticsConfig{
			Debug:      true,
			AppVersion: "1.2.3",
		},
		DebugPublisher: publisher,
		DeviceID:       "host-device",
		CommonParams: map[string]any{
			"product_variant": "tsh",
		},
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}

	got.Track(context.Background(), Event{
		Name: "workspace.opened",
		Params: map[string]any{
			"source":          "dashboard",
			"device_id":       "spoofed",
			"product_variant": "spoofed",
		},
	})

	if len(publisher.events) != 1 {
		t.Fatalf("debug events = %d, want 1", len(publisher.events))
	}
	event := publisher.events[0]
	if event.ClientTS == 0 {
		t.Fatal("client timestamp was not defaulted")
	}
	if event.Params["device_id"] != "host-device" {
		t.Fatalf("device_id = %v, want host-device", event.Params["device_id"])
	}
	if event.Params["product_variant"] != "tsh" {
		t.Fatalf("product_variant = %v, want tsh", event.Params["product_variant"])
	}
	if event.Params["source"] != "dashboard" {
		t.Fatalf("source = %v, want dashboard", event.Params["source"])
	}
}

func TestTeaReporterPersistsIdentityAndSendsSanitizedEvents(t *testing.T) {
	sdk := &fakeTeaSDK{}
	publisher := &fakeDebugPublisher{}
	stateDir := t.TempDir()
	reporter, err := newTeaReporterWithSDK(Config{
		Analytics: AnalyticsConfig{
			AppID:         20004092,
			AppKey:        "app-key",
			ChannelDomain: "https://example.test",
			AppVersion:    "0.0.0",
		},
		DebugPublisher: publisher,
		StateDir:       stateDir,
		CommonParams: map[string]any{
			"product_variant": "tutti",
		},
	}, sdk)
	if err != nil {
		t.Fatalf("newTeaReporterWithSDK() error = %v", err)
	}

	before := time.Now().UnixMilli()
	reporter.Track(context.Background(),
		Event{},
		Event{
			Name:     "workspace.opened",
			ClientTS: -1,
			Params: map[string]any{
				"source":          "dashboard",
				"session_id":      "spoofed",
				"product_variant": "spoofed",
			},
		},
	)
	after := time.Now().UnixMilli()

	if len(sdk.sends) != 1 {
		t.Fatalf("send calls = %d, want 1", len(sdk.sends))
	}
	send := sdk.sends[0]
	if send.appID != 20004092 {
		t.Fatalf("app ID = %d, want 20004092", send.appID)
	}
	if len(send.events) != 1 {
		t.Fatalf("events = %d, want 1", len(send.events))
	}
	if sdk.initConfig.LogDir != filepath.Join(stateDir, "analytics", "sdk-logs") {
		t.Fatalf("SDK log directory = %q, want default beneath state directory", sdk.initConfig.LogDir)
	}
	if send.events[0].ClientTS < before || send.events[0].ClientTS > after {
		t.Fatalf("client timestamp = %d, want between %d and %d", send.events[0].ClientTS, before, after)
	}
	for _, key := range []string{"device_id", "session_id", "app_version", "os", "product_variant"} {
		if _, exists := send.events[0].Params[key]; exists {
			t.Fatalf("event params contains common key %q", key)
		}
	}
	if send.common["product_variant"] != "tutti" {
		t.Fatalf("product_variant = %v, want tutti", send.common["product_variant"])
	}
	if send.uuid == "" || send.common["device_id"] != send.uuid {
		t.Fatalf("device ID common=%v uuid=%q", send.common["device_id"], send.uuid)
	}
	if len(publisher.events) != 1 {
		t.Fatalf("debug events = %d, want 1", len(publisher.events))
	}
	if publisher.events[0].Params["session_id"] != send.common["session_id"] {
		t.Fatalf("debug session ID = %v, want final common value", publisher.events[0].Params["session_id"])
	}
	if publisher.events[0].Params["source"] != "dashboard" {
		t.Fatalf("debug source = %v, want dashboard", publisher.events[0].Params["source"])
	}
	content, err := os.ReadFile(filepath.Join(stateDir, "device_id"))
	if err != nil {
		t.Fatalf("read device ID: %v", err)
	}
	if strings.TrimSpace(string(content)) != send.uuid {
		t.Fatalf("persisted device ID = %q, want %q", strings.TrimSpace(string(content)), send.uuid)
	}
	if err := reporter.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}
	if !sdk.closed {
		t.Fatal("Close did not delegate to SDK")
	}
}

func TestReporterRequiresIdentitySourceWhenEnabled(t *testing.T) {
	_, err := New(Config{
		Analytics: AnalyticsConfig{
			Debug: true,
		},
	})
	if err == nil || !strings.Contains(err.Error(), "state directory") {
		t.Fatalf("New() error = %v, want missing state directory", err)
	}
}

func TestTeaReporterRequiresStateDirectoryForSDKLogs(t *testing.T) {
	_, err := newTeaReporterWithSDK(Config{
		Analytics: AnalyticsConfig{
			AppID:         20004092,
			AppKey:        "app-key",
			ChannelDomain: "https://example.test",
		},
		DeviceID: "host-device",
	}, &fakeTeaSDK{})
	if err == nil || !strings.Contains(err.Error(), "SDK logs") {
		t.Fatalf("newTeaReporterWithSDK() error = %v, want missing SDK log directory", err)
	}
}

func TestTeaReporterAcceptsHostSDKLogDirectory(t *testing.T) {
	sdk := &fakeTeaSDK{}
	logDir := filepath.Join(t.TempDir(), "existing", "sdk-logs")
	_, err := newTeaReporterWithSDK(Config{
		Analytics: AnalyticsConfig{
			AppID:         20004092,
			AppKey:        "app-key",
			ChannelDomain: "https://example.test",
		},
		DeviceID:  "host-device",
		SDKLogDir: logDir,
	}, sdk)
	if err != nil {
		t.Fatalf("newTeaReporterWithSDK() error = %v", err)
	}
	if sdk.initConfig.LogDir != logDir {
		t.Fatalf("SDK log directory = %q, want %q", sdk.initConfig.LogDir, logDir)
	}
}

func TestLoadOrCreateDeviceIDIsStableUnderConcurrentCreation(t *testing.T) {
	stateDir := t.TempDir()
	const callers = 16
	results := make(chan string, callers)
	errors := make(chan error, callers)
	var group sync.WaitGroup

	for range callers {
		group.Add(1)
		go func() {
			defer group.Done()
			deviceID, err := loadOrCreateDeviceID(stateDir)
			if err != nil {
				errors <- err
				return
			}
			results <- deviceID
		}()
	}
	group.Wait()
	close(results)
	close(errors)

	for err := range errors {
		t.Fatalf("loadOrCreateDeviceID() error = %v", err)
	}
	var first string
	for deviceID := range results {
		if first == "" {
			first = deviceID
		}
		if deviceID != first {
			t.Fatalf("device ID = %q, want stable %q", deviceID, first)
		}
	}
}

func TestLoadOrCreateDeviceIDRepairsEmptyIdentityFile(t *testing.T) {
	stateDir := t.TempDir()
	path := filepath.Join(stateDir, "device_id")
	if err := os.WriteFile(path, []byte(" \n"), 0o600); err != nil {
		t.Fatalf("write empty device ID: %v", err)
	}

	deviceID, err := loadOrCreateDeviceID(stateDir)
	if err != nil {
		t.Fatalf("loadOrCreateDeviceID() error = %v", err)
	}
	if strings.TrimSpace(deviceID) == "" {
		t.Fatal("loadOrCreateDeviceID() returned an empty identity")
	}
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read repaired device ID: %v", err)
	}
	if persisted := strings.TrimSpace(string(content)); persisted != deviceID {
		t.Fatalf("persisted device ID = %q, want %q", persisted, deviceID)
	}
}
