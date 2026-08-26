package main

import "testing"

func TestResolveAccountRealtimeURL(t *testing.T) {
	tests := []struct {
		name      string
		canonical string
		mobile    string
		connector string
		want      string
		wantError bool
	}{
		{name: "canonical overrides legacy values", canonical: "wss://canonical.example/ws", mobile: "wss://mobile.example/ws", connector: "wss://connector.example/ws", want: "wss://canonical.example/ws"},
		{name: "matching legacy values", mobile: "wss://legacy.example/ws", connector: "wss://legacy.example/ws", want: "wss://legacy.example/ws"},
		{name: "mobile legacy value", mobile: "wss://mobile.example/ws", want: "wss://mobile.example/ws"},
		{name: "connector legacy value", connector: "wss://connector.example/ws", want: "wss://connector.example/ws"},
		{name: "default selected downstream", want: ""},
		{name: "conflicting legacy values", mobile: "wss://mobile.example/ws", connector: "wss://connector.example/ws", wantError: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Setenv("TUTTI_ACCOUNT_REALTIME_URL", test.canonical)
			t.Setenv("TUTTI_MOBILE_REALTIME_URL", test.mobile)
			t.Setenv("TUTTI_CONNECTOR_REALTIME_URL", test.connector)
			got, err := resolveAccountRealtimeURL()
			if (err != nil) != test.wantError {
				t.Fatalf("resolveAccountRealtimeURL() error = %v, wantError %v", err, test.wantError)
			}
			if got != test.want {
				t.Fatalf("resolveAccountRealtimeURL() = %q, want %q", got, test.want)
			}
		})
	}
}
