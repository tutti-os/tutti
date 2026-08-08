//go:build !windows

package agentstatus

func newUserPathAdapter() UserPathAdapter {
	// Unix/macOS installation already follows the existing ~/.local/bin
	// contract. Do not edit shell profiles from the daemon.
	return nil
}
