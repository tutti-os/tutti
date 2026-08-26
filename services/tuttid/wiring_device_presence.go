package main

import (
	"fmt"
	"net/http"
	"os"
	"runtime"
	"strings"

	accountservice "github.com/tutti-os/tutti/services/tuttid/service/account"
	devicepresenceservice "github.com/tutti-os/tutti/services/tuttid/service/devicepresence"
	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
)

func buildDevicePresenceService(stateDir string, account *accountservice.Service) (*devicepresenceservice.Service, error) {
	deviceID, err := tuttitypes.LoadOrCreateDeviceID(stateDir)
	if err != nil {
		return nil, fmt.Errorf("resolve device presence identity: %w", err)
	}
	reportedName, err := os.Hostname()
	if err != nil || strings.TrimSpace(reportedName) == "" {
		reportedName = "Tutti Desktop"
	}
	baseURL := strings.TrimSpace(os.Getenv("TUTTI_DESKTOP_CONTROL_PLANE_BASE_URL"))
	if baseURL == "" {
		baseURL = strings.TrimSpace(os.Getenv("TUTTI_MOBILE_CONTROL_PLANE_BASE_URL"))
	}
	headers := make(http.Header)
	if lane := strings.TrimSpace(os.Getenv("TUTTI_PPE_LANE")); lane != "" {
		headers.Set("x-zk-ppe-lane", lane)
	}
	return devicepresenceservice.NewService(account, &devicepresenceservice.HTTPControlPlane{
		BaseURL: baseURL, Headers: headers,
	}, devicepresenceservice.DeviceMetadata{
		DeviceID: deviceID, ReportedName: reportedName, Platform: runtime.GOOS,
		Arch: runtime.GOARCH, ClientVersion: tuttitypes.ResolveAppVersion(),
	}), nil
}
