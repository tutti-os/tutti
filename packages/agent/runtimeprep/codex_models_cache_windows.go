//go:build windows

package runtimeprep

import "os"

// A missing target cannot be represented by a hard link. Materialize an empty
// shared cache first so ordinary-user Windows sessions still get a writable
// CODEX_HOME path and subsequent writes remain shared when NTFS hard links are
// available.
func initializeCodexModelsCacheForWindows(source, target string) error {
	if err := os.WriteFile(source, nil, 0o600); err != nil {
		return err
	}
	if err := exposeCodexFile(source, target, 0o600); err != nil {
		return err
	}
	return nil
}
