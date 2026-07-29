package reporter

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"

	sdk "github.com/volcengine/datarangers-sdk-go"
)

type teaSDK interface {
	Init(teaSDKConfig) error
	Send(appID int64, uuid string, events []teaSDKEvent, common map[string]any) error
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
	Params   map[string]any
}

type defaultTeaSDK struct{}

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

func (defaultTeaSDK) Send(appID int64, uuid string, events []teaSDKEvent, common map[string]any) error {
	sdkEvents := make([]*sdk.EventV3, 0, len(events))
	for _, event := range events {
		clientTS := event.ClientTS
		sdkEvents = append(sdkEvents, &sdk.EventV3{
			Event:       event.Name,
			LocalTimeMs: &clientTS,
			Params:      event.Params,
		})
	}
	return sdk.SendEventInfos(sdk.APP, appID, uuid, sdkEvents, common)
}

func (defaultTeaSDK) Close() error {
	return nil
}
