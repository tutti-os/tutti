package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"

	deviceidentitydata "github.com/tutti-os/tutti/services/tuttid/data/deviceidentity"
	accountservice "github.com/tutti-os/tutti/services/tuttid/service/account"
	eventstreamservice "github.com/tutti-os/tutti/services/tuttid/service/eventstream"
	mobileremoteservice "github.com/tutti-os/tutti/services/tuttid/service/mobileremote"
	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
)

func buildMobileRemoteService(
	stateDir string,
	account *accountservice.Service,
	events *eventstreamservice.Service,
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
		Account:         account,
		AgentLiveEvents: mobileAgentLiveEventSource{events: events},
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

type mobileAgentLiveEventSource struct {
	events *eventstreamservice.Service
}

func (s mobileAgentLiveEventSource) StreamAgentActivity(
	ctx context.Context,
	workspaceID string,
	ready func() error,
	emit func([]byte) error,
) error {
	if s.events == nil {
		return fmt.Errorf("agent live event stream is unavailable")
	}
	session := s.events.OpenSession()
	defer s.events.CloseSession(session)
	if err := s.events.Subscribe(
		session,
		[]string{eventstreamservice.TopicAgentActivityUpdated},
		eventstreamservice.EventScope{WorkspaceID: workspaceID},
	); err != nil {
		return err
	}
	if err := ready(); err != nil {
		return err
	}
	for {
		select {
		case <-ctx.Done():
			return nil
		case event, ok := <-s.events.Events(session):
			if !ok {
				return fmt.Errorf("agent live event session closed")
			}
			if err := emit(append([]byte(nil), event.Payload...)); err != nil {
				return err
			}
		}
	}
}
