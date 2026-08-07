package browser

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
)

const browserReadinessTimeout = 5 * time.Second

// CheckReady validates the selected browser backend without starting an MCP
// session or launching Chrome. The probe is intentionally cheap because it is
// called while composing agent capabilities.
func (s *Service) CheckReady() error {
	if s == nil {
		return errors.New("browser service is unavailable")
	}
	ctx, cancel := context.WithTimeout(context.Background(), browserReadinessTimeout)
	defer cancel()

	if s.browserNode != nil {
		backend, ok := s.browserNode.(*browserNodeHTTPBackend)
		if !ok {
			return errors.New("BrowserNode readiness probe is unavailable")
		}
		return backend.CheckReady(ctx)
	}

	mode := resolveBrowserUseConnectionMode(ctx, s.preferences)
	if mode == "autoConnect" {
		preflight := s.autoConnectPreflight
		if preflight == nil {
			preflight = validateAutoConnectChromeReady
		}
		return preflight()
	}

	command := s.resolveCommand(ctx)
	if len(command) == 0 || strings.TrimSpace(command[0]) == "" {
		return errors.New("browser MCP command is not configured")
	}
	if _, err := exec.LookPath(command[0]); err != nil {
		return fmt.Errorf("browser MCP command %q is unavailable: %w", command[0], err)
	}
	if strings.TrimSpace(os.Getenv(browserMCPCommandOverrideEnv)) == "" {
		if entry := strings.TrimSpace(os.Getenv(browserMCPEntryPathEnv)); entry != "" {
			if info, err := os.Stat(entry); err != nil || info.IsDir() {
				if err == nil {
					err = errors.New("path is a directory")
				}
				return fmt.Errorf("browser MCP entry %q is unavailable: %w", entry, err)
			}
		}
	}
	return nil
}
