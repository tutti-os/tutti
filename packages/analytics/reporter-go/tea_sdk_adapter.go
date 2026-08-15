package reporter

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	sdk "github.com/volcengine/datarangers-sdk-go"
)

type teaSDK interface {
	Init(teaSDKConfig) error
	Send(appID int64, uuid string, events []teaSDKEvent, common map[string]any, header teaSDKHeader) error
	Close() error
}

type teaSDKConfig struct {
	AppID         int64
	AppKey        string
	ChannelDomain string
	LogDir        string
}

type teaSDKEvent struct {
	Name     string
	ClientTS int64
	EventID  string
	Params   map[string]any
}

type teaSDKHeader struct {
	AppVersion      string
	AppVersionMinor string
	OSName          string
	OSVersion       string
	CPUABI          string
}

func (h teaSDKHeader) presetParams() map[string]any {
	params := map[string]any{}
	for key, value := range map[string]string{
		"app_version":       h.AppVersion,
		"app_version_minor": h.AppVersionMinor,
		"os_name":           h.OSName,
		"os_version":        h.OSVersion,
		"cpu_abi":           h.CPUABI,
	} {
		if value = strings.TrimSpace(value); value != "" {
			params[key] = value
		}
	}
	return params
}

type defaultTeaSDK struct {
	sendEventsWithHeader func(sdk.AppType, int64, *sdk.Header, []*sdk.EventV3) error
}

func (defaultTeaSDK) Init(config teaSDKConfig) error {
	logDir, err := ensureTeaSDKLogDir(config.LogDir)
	if err != nil {
		return err
	}
	config.LogDir = logDir
	return defaultTeaSDKInitialization.init(config, func() error {
		return sdk.InitBySysConf(newTeaSDKSysConf(config, logDir))
	})
}

func ensureTeaSDKLogDir(logDir string) (string, error) {
	if err := os.MkdirAll(logDir, 0o700); err != nil {
		return "", fmt.Errorf("create analytics sdk log dir: %w", err)
	}
	if err := os.Chmod(logDir, 0o700); err != nil {
		return "", fmt.Errorf("secure analytics sdk log dir: %w", err)
	}
	return logDir, nil
}

type teaSDKInitializationGuard struct {
	mu          sync.Mutex
	initialized bool
	config      teaSDKConfig
}

var defaultTeaSDKInitialization teaSDKInitializationGuard

func (g *teaSDKInitializationGuard) init(config teaSDKConfig, initialize func() error) error {
	g.mu.Lock()
	defer g.mu.Unlock()

	if g.initialized {
		if g.config != config {
			return fmt.Errorf("DataFinder SDK is already initialized with different analytics configuration")
		}
		return nil
	}
	if err := initialize(); err != nil {
		return err
	}
	g.config = config
	g.initialized = true
	return nil
}

func newTeaSDKSysConf(config teaSDKConfig, logDir string) *sdk.SysConf {
	return &sdk.SysConf{
		SdkConfig: sdk.SdkConfig{
			Mode:     sdk.MODE_HTTP,
			Env:      sdk.ENV_SAAS_NATIVE,
			LogLevel: "ERROR",
		},
		FileConfig: sdk.FileConfig{
			Path:      filepath.Join(logDir, "datarangers.log"),
			ErrPath:   filepath.Join(logDir, "error-datarangers.log"),
			MaxSize:   5,
			MaxBackup: 2,
			MaxAge:    7,
		},
		HttpConfig: sdk.HttpConfig{
			HttpAddr: config.ChannelDomain,
		},
		AppKeys: map[int64]string{
			config.AppID: config.AppKey,
		},
		BatchConfig: sdk.BatchConfig{
			Enable: false,
		},
		AsynConfig: sdk.AsynConfig{
			Routine:     1,
			WaitTimeout: 50,
		},
		ErrHandler: func([]interface{}, error) error {
			return nil
		},
	}
}

func (d defaultTeaSDK) Send(
	appID int64,
	uuid string,
	events []teaSDKEvent,
	common map[string]any,
	header teaSDKHeader,
) error {
	sdkEvents := make([]*sdk.EventV3, 0, len(events))
	for _, event := range events {
		clientTS := event.ClientTS
		sdkEvent := &sdk.EventV3{
			Event:       event.Name,
			LocalTimeMs: &clientTS,
			Params:      event.Params,
		}
		if event.EventID != "" {
			sdkEvent.EventId = sdk.PtrString(event.EventID)
		}
		sdkEvents = append(sdkEvents, sdkEvent)
	}
	sdkHeader := &sdk.Header{
		Aid:             &appID,
		Custom:          common,
		UserUniqueId:    &uuid,
		AppVersion:      optionalTeaString(header.AppVersion),
		AppVersionMinor: optionalTeaString(header.AppVersionMinor),
		OsName:          optionalTeaString(header.OSName),
		OsVersion:       optionalTeaString(header.OSVersion),
		CpuAbi:          optionalTeaString(header.CPUABI),
	}
	sendEventsWithHeader := d.sendEventsWithHeader
	if sendEventsWithHeader == nil {
		sendEventsWithHeader = sdk.SendEventsWithHeader
	}
	return sendEventsWithHeader(sdk.APP, appID, sdkHeader, sdkEvents)
}

func optionalTeaString(value string) *string {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return &value
}

func (defaultTeaSDK) Close() error {
	return nil
}
