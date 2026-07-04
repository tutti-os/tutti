package computer

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestAdaptToolCallIntegration(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("macOS only")
	}
	if _, err := exec.LookPath("cua-driver"); err != nil {
		t.Skip("cua-driver not installed")
	}

	svc := NewService()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	result, err := svc.CallTool(ctx, "integration-test", "", "screenshot", nil)
	if err != nil {
		if errors.Is(err, ErrPermissionsMissing) {
			t.Skipf("cua-driver permissions not granted: %v", err)
		}
		t.Fatalf("CallTool screenshot: %v", err)
	}
	if !strings.Contains(result.Text, "Screenshot saved to ") {
		t.Fatalf("unexpected screenshot text: %q", result.Text)
	}
	path := strings.TrimPrefix(result.Text, "Screenshot saved to ")
	path = strings.TrimSpace(path)
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("screenshot file missing: %v", err)
	}
	t.Cleanup(func() { _ = os.Remove(path) })

	if _, err := svc.CallTool(ctx, "integration-test", "", "press_key", map[string]any{"key": "escape"}); err != nil {
		t.Fatalf("CallTool press_key: %v", err)
	}
}
