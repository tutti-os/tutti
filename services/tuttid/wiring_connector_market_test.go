package main

import (
	"context"
	"errors"
	"testing"

	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
)

type connectorModulePreferencesReader struct {
	preferences preferencesbiz.DesktopPreferences
	err         error
}

func (reader connectorModulePreferencesReader) GetDesktopPreferences(context.Context) (preferencesbiz.DesktopPreferences, error) {
	return reader.preferences, reader.err
}

func TestConnectorMarketDefaultUsesDesktopGateway(t *testing.T) {
	const expected = "https://api.tutti.sh/api/desktop"
	if connectorMarketDefaultBaseURL != expected {
		t.Fatalf("connector market base URL = %q, want %q", connectorMarketDefaultBaseURL, expected)
	}
}

func TestConnectorMCPDefaultUsesDesktopGateway(t *testing.T) {
	const expected = "https://tutti.sh/api/desktop"
	if connectorMCPDefaultBaseURL != expected {
		t.Fatalf("connector MCP base URL = %q, want %q", connectorMCPDefaultBaseURL, expected)
	}
}

func TestConnectorModuleActivationFollowsPersistedLabFlag(t *testing.T) {
	for _, test := range []struct {
		name  string
		flags map[string]bool
		want  bool
	}{
		{name: "absent defaults off", flags: nil, want: false},
		{name: "explicitly off", flags: map[string]bool{preferencesbiz.LabFlagConnectors: false}, want: false},
		{name: "explicitly on", flags: map[string]bool{preferencesbiz.LabFlagConnectors: true}, want: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			enabled, err := connectorModuleEnabled(t.Context(), connectorModulePreferencesReader{
				preferences: preferencesbiz.DesktopPreferences{FeatureFlags: test.flags},
			})
			if err != nil {
				t.Fatal(err)
			}
			if enabled != test.want {
				t.Fatalf("connectorModuleEnabled() = %v, want %v", enabled, test.want)
			}
		})
	}
}

func TestConnectorModuleActivationFailsClosedWhenPreferencesCannotBeRead(t *testing.T) {
	readErr := errors.New("preferences unavailable")
	enabled, err := connectorModuleEnabled(t.Context(), connectorModulePreferencesReader{err: readErr})
	if enabled {
		t.Fatal("connectorModuleEnabled() = true after preference read failure")
	}
	if !errors.Is(err, readErr) {
		t.Fatalf("connectorModuleEnabled() error = %v, want %v", err, readErr)
	}
}
