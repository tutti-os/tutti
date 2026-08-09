package browser

import (
	"os"
	"testing"
)

func TestBrowserCheckReadyCommandOverrideIgnoresStaleEntryPath(t *testing.T) {
	t.Setenv(browserMCPCommandOverrideEnv, "go")
	t.Setenv(browserMCPEntryPathEnv, filepathThatDoesNotExist(t))

	if err := NewService().CheckReady(); err != nil {
		t.Fatalf("CheckReady() = %v, want command override to win", err)
	}
}

func filepathThatDoesNotExist(t *testing.T) string {
	t.Helper()
	return t.TempDir() + string(os.PathSeparator) + "missing-entry"
}
