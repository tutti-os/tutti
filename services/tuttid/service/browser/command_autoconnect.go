package browser

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

const autoConnectSetupHint = "Open Chrome and enable remote debugging at chrome://inspect/#remote-debugging, then try again."

func browserMCPSubprocessEnv() []string {
	return []string{
		"NO_PROXY=127.0.0.1,localhost,::1",
		"no_proxy=127.0.0.1,localhost,::1",
	}
}

func resolveAutoConnectMCPConnectionArgs() []string {
	if endpoint, ok := stableChromeDevToolsWebSocketEndpoint(); ok {
		return []string{"--wsEndpoint", endpoint, "--no-usage-statistics"}
	}
	return []string{"--autoConnect", "--channel", "stable", "--no-usage-statistics"}
}

func validateAutoConnectChromeReady() error {
	if _, err := readStableChromeDevToolsActivePort(); err != nil {
		return fmt.Errorf("could not connect to Chrome for reuse mode: %w. %s", err, autoConnectSetupHint)
	}
	return nil
}

func stableChromeDevToolsWebSocketEndpoint() (endpoint string, ok bool) {
	activePort, err := readStableChromeDevToolsActivePort()
	if err != nil {
		return "", false
	}
	return fmt.Sprintf("ws://127.0.0.1:%d%s", activePort.port, activePort.path), true
}

func readStableChromeDevToolsActivePort() (devToolsActivePort, error) {
	portPath := stableChromeDevToolsActivePortPath()
	if portPath == "" {
		return devToolsActivePort{}, errors.New("stable Chrome profile path is unavailable on this platform")
	}
	content, err := os.ReadFile(portPath)
	if err != nil {
		if os.IsNotExist(err) {
			return devToolsActivePort{}, fmt.Errorf("DevToolsActivePort not found at %s", portPath)
		}
		return devToolsActivePort{}, fmt.Errorf("read DevToolsActivePort: %w", err)
	}
	activePort, ok := parseDevToolsActivePort(string(content))
	if !ok {
		return devToolsActivePort{}, fmt.Errorf("invalid DevToolsActivePort at %s", portPath)
	}
	return activePort, nil
}

func stableChromeDevToolsActivePortPath() string {
	home, err := os.UserHomeDir()
	if err != nil || strings.TrimSpace(home) == "" {
		return ""
	}
	switch runtime.GOOS {
	case "darwin":
		return filepath.Join(home, "Library", "Application Support", "Google", "Chrome", "DevToolsActivePort")
	case "linux":
		return filepath.Join(home, ".config", "google-chrome", "DevToolsActivePort")
	case "windows":
		return filepath.Join(home, "AppData", "Local", "Google", "Chrome", "User Data", "DevToolsActivePort")
	default:
		return ""
	}
}

func parseDevToolsActivePort(content string) (devToolsActivePort, bool) {
	lines := make([]string, 0, 2)
	for _, line := range strings.Split(content, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed != "" {
			lines = append(lines, trimmed)
		}
	}
	if len(lines) < 2 {
		return devToolsActivePort{}, false
	}
	port, err := strconv.Atoi(lines[0])
	if err != nil || port <= 0 || port > 65535 {
		return devToolsActivePort{}, false
	}
	path := lines[1]
	if !strings.HasPrefix(path, "/") {
		return devToolsActivePort{}, false
	}
	return devToolsActivePort{port: port, path: path}, true
}

type devToolsActivePort struct {
	port int
	path string
}
