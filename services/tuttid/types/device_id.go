package types

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/google/uuid"
)

// LoadOrCreateDeviceID returns the daemon-wide stable device identity shared by
// analytics and account-scoped device capabilities.
func LoadOrCreateDeviceID(stateDir string) (string, error) {
	path := filepath.Join(stateDir, "device_id")
	if content, err := os.ReadFile(path); err == nil {
		value := strings.TrimSpace(string(content))
		if value != "" {
			return value, nil
		}
	} else if !os.IsNotExist(err) {
		return "", fmt.Errorf("read daemon device id: %w", err)
	}

	if err := os.MkdirAll(stateDir, 0o755); err != nil {
		return "", fmt.Errorf("create daemon state dir: %w", err)
	}
	deviceID := uuid.NewString()
	if err := os.WriteFile(path, []byte(deviceID+"\n"), 0o600); err != nil {
		return "", fmt.Errorf("write daemon device id: %w", err)
	}
	return deviceID, nil
}
