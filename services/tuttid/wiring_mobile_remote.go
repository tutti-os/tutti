package main

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"

	deviceidentitydata "github.com/tutti-os/tutti/services/tuttid/data/deviceidentity"
	accountservice "github.com/tutti-os/tutti/services/tuttid/service/account"
	mobileremoteservice "github.com/tutti-os/tutti/services/tuttid/service/mobileremote"
	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
)

func buildMobileRemoteService(
	stateDir string,
	account *accountservice.Service,
) (*mobileremoteservice.Service, error) {
	deviceID, err := tuttitypes.LoadOrCreateDeviceID(stateDir)
	if err != nil {
		return nil, fmt.Errorf("resolve daemon device id: %w", err)
	}
	reportedName, err := os.Hostname()
	if err != nil {
		reportedName = "Tutti Desktop"
	}
	return &mobileremoteservice.Service{
		Account: account,
		Identities: deviceidentitydata.NewFileStore(
			filepath.Join(stateDir, "mobile-remote", "device-identity.json"),
			deviceID,
		),
		ControlPlane: &mobileremoteservice.HTTPControlPlane{
			BaseURL: os.Getenv("TUTTI_MOBILE_CONTROL_PLANE_BASE_URL"),
		},
		Metadata: mobileremoteservice.DeviceMetadata{
			ReportedName:  reportedName,
			Platform:      runtime.GOOS,
			Arch:          runtime.GOARCH,
			ClientVersion: tuttitypes.ResolveAppVersion(),
		},
	}, nil
}
