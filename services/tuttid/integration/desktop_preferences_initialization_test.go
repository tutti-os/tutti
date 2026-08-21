package integration_test

import (
	"net/http"
	"testing"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
)

const standaloneAgentModeFeatureFlag = "workspace.standaloneAgentMode"

func TestDesktopPreferencesInitializeIfAbsentAppliesDaemonFreshModeDefault(t *testing.T) {
	testCases := []struct {
		featureFlags tuttigenerated.DesktopFeatureFlags
		name         string
	}{
		{name: "missing mode flag", featureFlags: tuttigenerated.DesktopFeatureFlags{}},
		{name: "explicit false mode flag", featureFlags: tuttigenerated.DesktopFeatureFlags{standaloneAgentModeFeatureFlag: false}},
	}

	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			daemon := startTestDaemon(t)
			initial := mustRequestJSON[tuttigenerated.DesktopPreferencesStateResponse](
				t,
				daemon,
				http.MethodGet,
				"/v1/preferences/desktop",
				nil,
				http.StatusOK,
			)
			if initial.Initialized {
				t.Fatal("initial desktop preferences initialized = true, want false")
			}

			initial.Preferences.FeatureFlags = testCase.featureFlags
			writeMode := tuttigenerated.DesktopPreferencesWriteModeInitializeIfAbsent
			initialized := mustRequestJSON[tuttigenerated.DesktopPreferencesStateResponse](
				t,
				daemon,
				http.MethodPut,
				"/v1/preferences/desktop",
				tuttigenerated.PutDesktopPreferencesRequest{
					Preferences: initial.Preferences,
					WriteMode:   &writeMode,
				},
				http.StatusOK,
			)
			if !initialized.Initialized {
				t.Fatal("initialized desktop preferences initialized = false, want true")
			}
			if !initialized.Preferences.FeatureFlags[standaloneAgentModeFeatureFlag] {
				t.Fatalf("initialized feature flags = %#v, want Agent mode", initialized.Preferences.FeatureFlags)
			}

			stored := mustRequestJSON[tuttigenerated.DesktopPreferencesStateResponse](
				t,
				daemon,
				http.MethodGet,
				"/v1/preferences/desktop",
				nil,
				http.StatusOK,
			)
			if !stored.Preferences.FeatureFlags[standaloneAgentModeFeatureFlag] {
				t.Fatalf("stored feature flags = %#v, want Agent mode", stored.Preferences.FeatureFlags)
			}
		})
	}
}

func TestDesktopPreferencesInitializeIfAbsentPreservesExistingOSMode(t *testing.T) {
	daemon := startTestDaemon(t)
	initial := mustRequestJSON[tuttigenerated.DesktopPreferencesStateResponse](
		t,
		daemon,
		http.MethodGet,
		"/v1/preferences/desktop",
		nil,
		http.StatusOK,
	)
	initial.Preferences.FeatureFlags = tuttigenerated.DesktopFeatureFlags{
		standaloneAgentModeFeatureFlag: false,
	}
	mustRequestJSON[tuttigenerated.DesktopPreferencesStateResponse](
		t,
		daemon,
		http.MethodPut,
		"/v1/preferences/desktop",
		tuttigenerated.PutDesktopPreferencesRequest{Preferences: initial.Preferences},
		http.StatusOK,
	)

	candidate := initial.Preferences
	candidate.FeatureFlags = tuttigenerated.DesktopFeatureFlags{
		standaloneAgentModeFeatureFlag: true,
	}
	writeMode := tuttigenerated.DesktopPreferencesWriteModeInitializeIfAbsent
	stored := mustRequestJSON[tuttigenerated.DesktopPreferencesStateResponse](
		t,
		daemon,
		http.MethodPut,
		"/v1/preferences/desktop",
		tuttigenerated.PutDesktopPreferencesRequest{
			Preferences: candidate,
			WriteMode:   &writeMode,
		},
		http.StatusOK,
	)
	if stored.Preferences.FeatureFlags[standaloneAgentModeFeatureFlag] {
		t.Fatalf("stored feature flags = %#v, want existing OS mode", stored.Preferences.FeatureFlags)
	}
}
