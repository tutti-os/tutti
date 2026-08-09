package main

import (
	"testing"
)

func TestConnectorMarketDefaultUsesDesktopGateway(t *testing.T) {
	const expected = "https://api.tutti.sh/api/desktop"
	if connectorMarketDefaultBaseURL != expected {
		t.Fatalf("connector market base URL = %q, want %q", connectorMarketDefaultBaseURL, expected)
	}
}
