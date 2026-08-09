//go:build windows

package computer

import (
	"context"
	"os"
	"testing"
	"time"
)

// TestWindowsComputerDriverE2E is opt-in because it starts the installed
// cua-driver daemon and exercises the real MCP transport. CI keeps the test
// skipped unless a driver path and an interactive Windows session are present.
func TestWindowsComputerDriverE2E(t *testing.T) {
	if os.Getenv("TUTTI_COMPUTER_E2E") != "1" {
		t.Skip("set TUTTI_COMPUTER_E2E=1 to run the Windows cua-driver MCP smoke test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	service := NewService()
	defer service.Close()
	if err := service.CheckReady(ctx); err != nil {
		t.Fatalf("computer readiness: %v", err)
	}
	catalog, err := service.ListTools(ctx, "windows-e2e", "")
	if err != nil {
		t.Fatalf("computer MCP tools/list: %v", err)
	}
	if len(catalog.Tools) == 0 {
		t.Fatal("computer MCP tools/list returned no tools")
	}
	result, err := service.CallNativeTool(ctx, "windows-e2e", "", "get_screen_size", nil)
	if err != nil {
		t.Fatalf("computer MCP get_screen_size: %v", err)
	}
	if result.Text == "" && len(result.StructuredContent) == 0 {
		t.Fatal("computer MCP get_screen_size returned no content")
	}
}
