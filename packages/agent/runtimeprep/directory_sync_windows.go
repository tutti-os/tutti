//go:build windows

package runtimeprep

func syncDirectory(string) error {
	// Windows does not expose a portable directory fsync through os.File.
	// The rollout file itself is synced before the atomic rename.
	return nil
}
