package reporter

import "testing"

func TestOSReleaseVersion(t *testing.T) {
	for _, content := range []string{
		"NAME=Ubuntu\nVERSION_ID=\"24.04\"\n",
		"NAME=Ubuntu\nVERSION_ID='24.04'\n",
		"NAME=Ubuntu\nVERSION_ID=24.04\n",
	} {
		if got := osReleaseVersion(content); got != "24.04" {
			t.Fatalf("osReleaseVersion(%q) = %q, want 24.04", content, got)
		}
	}
}
