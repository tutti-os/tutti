//go:build (!darwin || ios) && !linux && !android && !windows

package networkchange

import "context"

func sampleDefaultRoutes(context.Context) (defaultRouteSample, error) {
	return defaultRouteSample{}, nil
}
