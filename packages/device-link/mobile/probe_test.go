package mobile

import "testing"

func TestRunLoopbackProbe(t *testing.T) {
	got, err := RunLoopbackProbe(30_000)
	if err != nil {
		t.Fatal(err)
	}
	if got != "tutti-device-link-android-probe" {
		t.Fatalf("probe result = %q", got)
	}
}

func TestProbeEpoch(t *testing.T) {
	if got := ProbeEpoch(); got != 1 {
		t.Fatalf("protocol epoch = %d, want 1", got)
	}
}
