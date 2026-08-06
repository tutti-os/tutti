//go:build windows

package workspace

import "testing"

func TestNormalizeWindowsTerminalInputExpandsBareCarriageReturns(t *testing.T) {
	got := string(normalizeWindowsTerminalInput([]byte("first\rsecond\r\n")))
	if got != "first\rsecond\r" {
		t.Fatalf("normalizeWindowsTerminalInput() = %q", got)
	}
}
