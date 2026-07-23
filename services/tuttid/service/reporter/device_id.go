package reporter

import (
	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
)

func loadOrCreateDeviceID(stateDir string) (string, error) {
	return tuttitypes.LoadOrCreateDeviceID(stateDir)
}
