package artifact

import (
	"fmt"
	"os"
)

// Windows does not expose a portable directory fsync operation. Opening and
// validating the directory preserves error reporting without calling
// os.File.Sync, which returns ERROR_ACCESS_DENIED for directory handles.
func syncDirectory(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return err
	}
	info, statErr := directory.Stat()
	closeErr := directory.Close()
	if statErr != nil {
		return statErr
	}
	if !info.IsDir() {
		return fmt.Errorf("sync connector artifact directory: %s is not a directory", path)
	}
	return closeErr
}
