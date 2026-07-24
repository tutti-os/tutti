package devicelink

import "testing"

func TestLocalNetworkFingerprintDeterministic(t *testing.T) {
	first := LocalNetworkFingerprint()
	second := LocalNetworkFingerprint()
	if first != second {
		t.Fatalf("LocalNetworkFingerprint() unstable across calls: %q vs %q", first, second)
	}
	// Empty means the interface sample failed; any successful sample — even
	// of an empty usable-interface set — must be a stable 16-hex token so
	// "no interfaces" remains distinguishable from "could not sample".
	if first != "" && len(first) != 16 {
		t.Fatalf("LocalNetworkFingerprint() = %q, want a 16-character hash token", first)
	}
}
