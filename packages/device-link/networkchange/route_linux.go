//go:build linux && !android

package networkchange

import (
	"context"
	"errors"
	"os"
	"sort"
)

func sampleDefaultRoutes(ctx context.Context) (defaultRouteSample, error) {
	v4, v4Present, err := readRouteFile(ctx, "/proc/net/route")
	if err != nil {
		return defaultRouteSample{}, err
	}
	v6, v6Present, err := readRouteFile(ctx, "/proc/net/ipv6_route")
	if err != nil {
		return defaultRouteSample{}, err
	}
	if !v4Present && !v6Present {
		return defaultRouteSample{}, nil
	}
	entries := make([]string, 0, 2)
	if v4Present {
		parsed, err := parseLinuxIPv4Routes(v4)
		if err != nil {
			return defaultRouteSample{}, err
		}
		entries = append(entries, parsed...)
	}
	if v6Present {
		parsed, err := parseLinuxIPv6Routes(v6)
		if err != nil {
			return defaultRouteSample{}, err
		}
		entries = append(entries, parsed...)
	}
	sort.Strings(entries)
	return defaultRouteSample{entries: entries, supported: true}, nil
}

func readRouteFile(ctx context.Context, path string) ([]byte, bool, error) {
	if err := contextErr(ctx); err != nil {
		return nil, false, err
	}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, errors.New("default route sample failed")
	}
	if err := contextErr(ctx); err != nil {
		return nil, false, err
	}
	return data, true, nil
}
