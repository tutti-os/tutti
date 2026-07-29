//go:build !windows

package tuttiagent

import "os"

func replaceTuttiAgentAuthFile(source, destination string) error {
	return os.Rename(source, destination)
}
