package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"testing"
	"time"

	tuttiapi "github.com/tutti-os/tutti/services/tuttid/api"
	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
	eventstreamservice "github.com/tutti-os/tutti/services/tuttid/service/eventstream"
	preferencesservice "github.com/tutti-os/tutti/services/tuttid/service/preferences"
)

type mobileRemotePreferencesStore struct {
	current preferencesbiz.DesktopPreferences
	getErr  error
}

func (s *mobileRemotePreferencesStore) GetDesktopPreferences(context.Context) (preferencesbiz.DesktopPreferences, error) {
	return s.current, s.getErr
}

func (s *mobileRemotePreferencesStore) PutDesktopPreferences(
	_ context.Context,
	preferences preferencesbiz.DesktopPreferences,
) (preferencesbiz.DesktopPreferences, error) {
	s.current = preferences
	return preferences, nil
}

type recordingMobileRemoteHost struct {
	starts  int
	closes  int
	handler http.Handler
}

func (h *recordingMobileRemoteHost) StartRemoteHost(handler http.Handler) {
	h.starts++
	h.handler = handler
}

func (h *recordingMobileRemoteHost) StopRemoteHost() {
	h.closes++
}

func TestStartMobileRemoteHostFollowsPersistedPreference(t *testing.T) {
	t.Parallel()

	for _, test := range []struct {
		name       string
		flags      map[string]bool
		getErr     error
		wantStarts int
		wantCloses int
	}{
		{name: "stored enabled value is ignored", flags: map[string]bool{preferencesbiz.FeatureFlagMobileRemoteAccess: true}, wantCloses: 1},
		{name: "disabled", wantCloses: 1},
		{name: "read failure fails closed", getErr: errors.New("read failed"), wantCloses: 1},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			preferences := &preferencesservice.Service{Store: &mobileRemotePreferencesStore{
				current: preferencesbiz.DesktopPreferences{FeatureFlags: test.flags},
				getErr:  test.getErr,
			}}
			host := &recordingMobileRemoteHost{}
			wiring := &tuttiWiring{
				api:              tuttiapi.DaemonAPI{PreferencesService: preferences},
				mobileRemoteHost: host,
			}

			wiring.startMobileRemoteHost(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))

			if host.starts != test.wantStarts || host.closes != test.wantCloses {
				t.Fatalf(
					"host lifecycle calls = start %d, close %d; want start %d, close %d",
					host.starts,
					host.closes,
					test.wantStarts,
					test.wantCloses,
				)
			}
			if test.wantStarts == 1 && host.handler == nil {
				t.Fatal("started remote host received a nil handler")
			}
		})
	}
}

func TestMobileRemoteHostRemainsDisabledWhenPreferenceChanges(t *testing.T) {
	store := &mobileRemotePreferencesStore{}
	preferences := &preferencesservice.Service{Store: store}
	host := &recordingMobileRemoteHost{}
	wiring := &tuttiWiring{
		api:              tuttiapi.DaemonAPI{PreferencesService: preferences},
		mobileRemoteHost: host,
	}
	wiring.observeDesktopPreferenceChanges(preferences)
	wiring.startMobileRemoteHost(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))

	if _, err := preferences.Put(context.Background(), preferencesservice.PutInput{
		FeatureFlags: map[string]bool{preferencesbiz.FeatureFlagMobileRemoteAccess: true},
	}); err != nil {
		t.Fatal(err)
	}
	if host.starts != 0 || host.closes != 1 {
		t.Fatalf("enabled lifecycle calls = start %d, close %d; want start 0, close 1", host.starts, host.closes)
	}

	if _, err := preferences.Put(context.Background(), preferencesservice.PutInput{}); err != nil {
		t.Fatal(err)
	}
	if host.starts != 0 || host.closes != 1 {
		t.Fatalf("disabled lifecycle calls = start %d, close %d; want start 0, close 1", host.starts, host.closes)
	}
}

func TestMobileAgentLiveEventSourceSubscribesBeforeReady(t *testing.T) {
	t.Parallel()

	events := eventstreamservice.NewService(eventstreamservice.DefaultCatalog(), nil)
	source := mobileAgentLiveEventSource{events: events}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)

	readyEntered := make(chan struct{})
	releaseReady := make(chan struct{})
	emitted := make(chan []byte, 1)
	done := make(chan error, 1)
	go func() {
		done <- source.StreamAgentActivity(
			ctx,
			"workspace-1",
			func() error {
				close(readyEntered)
				<-releaseReady
				return nil
			},
			func(payload []byte) error {
				emitted <- payload
				cancel()
				return nil
			},
		)
	}()

	select {
	case <-readyEntered:
	case <-time.After(time.Second):
		t.Fatal("event source did not report ready")
	}

	publisher := eventstreamservice.AgentActivityPublisher{Service: events}
	if err := publisher.PublishAgentActivityUpdatedJSON(
		context.Background(),
		"workspace-1",
		"session-1",
		"message_delta",
		json.RawMessage(`{
			"workspaceId":"workspace-1",
			"agentSessionId":"session-1",
			"messageId":"message-1",
			"turnId":"turn-1",
			"role":"assistant",
			"kind":"text",
			"occurredAtUnixMs":10,
			"content":{"operation":"set","value":"hello"}
		}`),
	); err != nil {
		t.Fatal(err)
	}
	close(releaseReady)

	select {
	case payload := <-emitted:
		if len(payload) == 0 {
			t.Fatal("event source emitted an empty payload")
		}
	case <-time.After(time.Second):
		t.Fatal("event published after subscribe but before ready was lost")
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("event source did not stop after cancellation")
	}
}
