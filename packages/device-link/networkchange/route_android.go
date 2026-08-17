//go:build android

package networkchange

import "context"

// Android 10 and newer deny ordinary applications access to /proc/net. Route
// changes are therefore represented by the interface/address fingerprint
// until an Android-owned ConnectivityManager source is provided.
func sampleDefaultRoutes(ctx context.Context) (defaultRouteSample, error) {
	if err := contextErr(ctx); err != nil {
		return defaultRouteSample{}, err
	}
	return defaultRouteSample{}, nil
}
