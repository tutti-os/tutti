//go:build windows

package agentstatus

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"

	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
)

var codexWindowsAppsMaterializeMu sync.Mutex

// materializeCodexWindowsAppsLauncher makes a protected AppX executable
// launchable by tuttid. Windows permits the packaged Codex app to execute its
// own resources, but a child process spawned by a non-AppX Tutti process gets
// ERROR_ACCESS_DENIED for the same path. Copying the standalone CLI binary to
// Tutti's writable runtime cache preserves the user's installed version while
// giving CreateProcess a normal filesystem path.
func materializeCodexWindowsAppsLauncher(path string) string {
	cacheRoot, err := tuttitypes.DefaultAgentRuntimeDir()
	if err != nil {
		return path
	}
	return materializeCodexWindowsAppsLauncherAt(path, cacheRoot)
}

func materializeCodexWindowsAppsLauncherAt(path string, cacheRoot string) string {
	path = filepath.Clean(strings.TrimSpace(path))
	if !isCodexWindowsAppsExecutable(path) {
		return path
	}

	sourceInfo, err := os.Stat(path)
	if err != nil || sourceInfo.IsDir() {
		return path
	}

	identity := sha256.Sum256([]byte(fmt.Sprintf("%s\x00%d\x00%d", strings.ToLower(path), sourceInfo.Size(), sourceInfo.ModTime().UnixNano())))
	destinationDir := filepath.Join(cacheRoot, "codex-windows-appx", hex.EncodeToString(identity[:8]))
	destination := filepath.Join(destinationDir, "codex.exe")

	codexWindowsAppsMaterializeMu.Lock()
	defer codexWindowsAppsMaterializeMu.Unlock()

	if destinationInfo, statErr := os.Stat(destination); statErr == nil && destinationInfo.Size() == sourceInfo.Size() {
		return destination
	}
	if err := os.MkdirAll(destinationDir, 0o755); err != nil {
		slog.Warn("codex AppX launcher cache directory unavailable",
			"event", "tutti.codex.appx_launcher.materialize_failed",
			"source", path,
			"destination", destination,
			"error", err,
		)
		return path
	}

	source, err := os.Open(path)
	if err != nil {
		return path
	}
	defer source.Close()

	temporary, err := os.CreateTemp(destinationDir, "codex-*.tmp")
	if err != nil {
		return path
	}
	temporaryPath := temporary.Name()
	defer func() {
		_ = os.Remove(temporaryPath)
	}()

	if _, err := io.Copy(temporary, source); err != nil {
		_ = temporary.Close()
		return path
	}
	if err := temporary.Close(); err != nil {
		return path
	}
	if err := os.Chmod(temporaryPath, 0o755); err != nil {
		return path
	}
	if err := os.Rename(temporaryPath, destination); err != nil {
		return path
	}

	slog.Info("codex AppX launcher materialized",
		"event", "tutti.codex.appx_launcher.materialized",
		"source", path,
		"destination", destination,
		"sizeBytes", sourceInfo.Size(),
	)
	return destination
}

func isCodexWindowsAppsExecutable(path string) bool {
	slashed := strings.ToLower(filepath.ToSlash(filepath.Clean(path)))
	return strings.HasSuffix(slashed, "/codex.exe") && strings.Contains(slashed, "/program files/windowsapps/")
}
