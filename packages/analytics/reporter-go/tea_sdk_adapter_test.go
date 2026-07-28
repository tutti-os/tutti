package reporter

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	sdk "github.com/volcengine/datarangers-sdk-go"
)

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
