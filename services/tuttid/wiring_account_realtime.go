package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	tuttiapi "github.com/tutti-os/tutti/services/tuttid/api"
	accountservice "github.com/tutti-os/tutti/services/tuttid/service/account"
	accountrealtimeservice "github.com/tutti-os/tutti/services/tuttid/service/accountrealtime"
	eventstreamservice "github.com/tutti-os/tutti/services/tuttid/service/eventstream"
	mobileremoteservice "github.com/tutti-os/tutti/services/tuttid/service/mobileremote"
	userpresenceservice "github.com/tutti-os/tutti/services/tuttid/service/userpresence"
	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
)

func (w *tuttiWiring) configureAccountRealtime(api *tuttiapi.DaemonAPI, account *accountservice.Service) error {
	accountRealtime, userPresence, err := buildAccountRealtime(tuttitypes.DefaultStateDir(), account)
	if err != nil {
		return err
	}
	w.accountRealtime = accountRealtime
	w.userPresence = userPresence
	api.UserPresenceService = userPresence
	accountEvents, eventsOK := api.EventStreamService.(*eventstreamservice.Service)
	if !eventsOK || accountEvents == nil {
		return errors.New("user presence event stream adapter is unavailable")
	}
	userPresence.Publisher = eventstreamservice.UserPresencePublisher{Service: accountEvents}
	accountRealtime.OnPresenceReplayACK(userPresence.ReconcileCurrentRoom)
	devicePresence, err := buildDevicePresenceService(tuttitypes.DefaultStateDir(), account)
	if err != nil {
		return fmt.Errorf("configure device presence: %w", err)
	}
	w.devicePresence = devicePresence
	if mobileRemote, ok := api.MobileRemoteService.(*mobileremoteservice.Service); ok && mobileRemote != nil {
		mobileRemote.AttemptEvents = accountrealtimeservice.MobileAttemptEventSource{Realtime: accountRealtime}
	} else {
		return errors.New("mobile remote account realtime adapter is unavailable")
	}
	existingAccountLoginCompleted := account.OnLoginCompleted
	account.OnLoginCompleted = func(loginContext context.Context) {
		if existingAccountLoginCompleted != nil {
			existingAccountLoginCompleted(loginContext)
		}
		userPresence.Reset()
		accountRealtime.NotifySessionChanged()
		devicePresence.Start()
	}
	existingAccountLogoutStarting := account.OnLogoutStarting
	account.OnLogoutStarting = func(logoutContext context.Context) {
		if existingAccountLogoutStarting != nil {
			existingAccountLogoutStarting(logoutContext)
		}
		stopContext, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		devicePresence.Stop(stopContext)
		cancel()
	}
	existingAccountLogoutCompleted := account.OnLogoutCompleted
	account.OnLogoutCompleted = func(logoutContext context.Context) {
		if existingAccountLogoutCompleted != nil {
			existingAccountLogoutCompleted(logoutContext)
		}
		userPresence.Reset()
		accountRealtime.NotifySessionChanged()
	}
	startExistingListenerWork := api.OnListenerReady
	api.OnListenerReady = func() {
		if startExistingListenerWork != nil {
			startExistingListenerWork()
		}
		accountRealtime.Start()
		userPresence.Start()
		devicePresence.Start()
		presenceEventsContext, cancel := context.WithCancel(context.Background())
		w.userPresenceEventsCancel = cancel
		go func() {
			if eventsErr := accountRealtime.RunUserPresenceEvents(presenceEventsContext, userPresence); eventsErr != nil && presenceEventsContext.Err() == nil {
				slog.Warn("user presence realtime listener stopped", "error", eventsErr)
			}
		}()
	}
	return nil
}

func (w *tuttiWiring) stopAccountRealtime() {
	if w.devicePresence != nil {
		stopContext, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		w.devicePresence.Stop(stopContext)
		cancel()
	}
	if w.userPresenceEventsCancel != nil {
		w.userPresenceEventsCancel()
	}
	if w.userPresence != nil {
		stopContext, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		w.userPresence.Stop(stopContext)
		cancel()
	}
	if w.accountRealtime != nil {
		stopContext, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		w.accountRealtime.Stop(stopContext)
		cancel()
	}
}

func buildAccountRealtime(
	stateDir string,
	account *accountservice.Service,
) (*accountrealtimeservice.Service, *userpresenceservice.Service, error) {
	deviceID, err := tuttitypes.LoadOrCreateDeviceID(stateDir)
	if err != nil {
		return nil, nil, fmt.Errorf("resolve account realtime device identity: %w", err)
	}
	realtimeURL, err := resolveAccountRealtimeURL()
	if err != nil {
		return nil, nil, err
	}
	headers := make(http.Header)
	if lane := strings.TrimSpace(os.Getenv("TUTTI_PPE_LANE")); lane != "" {
		headers.Set("x-zk-ppe-lane", lane)
	}
	realtime, err := accountrealtimeservice.New(accountrealtimeservice.Config{
		URL: realtimeURL, DeviceID: deviceID, Headers: headers, Account: account,
	})
	if err != nil {
		return nil, nil, fmt.Errorf("configure account realtime: %w", err)
	}
	controlPlaneURL := strings.TrimSpace(os.Getenv("TUTTI_DESKTOP_CONTROL_PLANE_BASE_URL"))
	if controlPlaneURL == "" {
		controlPlaneURL = strings.TrimSpace(os.Getenv("TUTTI_MOBILE_CONTROL_PLANE_BASE_URL"))
	}
	presence := userpresenceservice.NewService(realtime, &userpresenceservice.HTTPControlPlane{
		BaseURL: controlPlaneURL, Headers: headers, Account: account,
	}, realtime)
	return realtime, presence, nil
}

func resolveAccountRealtimeURL() (string, error) {
	if canonical := strings.TrimSpace(os.Getenv("TUTTI_ACCOUNT_REALTIME_URL")); canonical != "" {
		return canonical, nil
	}
	mobile := strings.TrimSpace(os.Getenv("TUTTI_MOBILE_REALTIME_URL"))
	connector := strings.TrimSpace(os.Getenv("TUTTI_CONNECTOR_REALTIME_URL"))
	if mobile != "" && connector != "" && mobile != connector {
		return "", errors.New("legacy mobile and connector realtime URLs differ; set TUTTI_ACCOUNT_REALTIME_URL to select the shared account socket")
	}
	if mobile != "" {
		return mobile, nil
	}
	return connector, nil
}
