//go:build windows

package networkchange

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"sort"
	"unsafe"

	"golang.org/x/sys/windows"
)

func sampleDefaultRoutes(ctx context.Context) (defaultRouteSample, error) {
	if err := contextErr(ctx); err != nil {
		return defaultRouteSample{}, err
	}
	var table *windows.MibIpForwardTable2
	if err := windows.GetIpForwardTable2(windows.AF_UNSPEC, &table); err != nil {
		return defaultRouteSample{}, errors.New("default route sample failed")
	}
	if table == nil {
		return defaultRouteSample{}, errors.New("default route sample failed")
	}
	defer windows.FreeMibTable(unsafe.Pointer(table))
	entries := make([]string, 0, 2)
	for _, row := range table.Rows() {
		if err := contextErr(ctx); err != nil {
			return defaultRouteSample{}, err
		}
		if row.DestinationPrefix.PrefixLength != 0 {
			continue
		}
		family, destination, err := windowsRouteAddress(row.DestinationPrefix.Prefix)
		if err != nil || !isZeroBytes(destination) {
			continue
		}
		_, nextHop, err := windowsRouteAddress(row.NextHop)
		if err != nil {
			return defaultRouteSample{}, errors.New("default route sample failed")
		}
		entries = append(entries, fmt.Sprintf(
			"default-route:%s|%d|%s|%d|%d|%d",
			family, row.InterfaceIndex, hex.EncodeToString(nextHop), row.Metric, row.Protocol, row.Origin,
		))
	}
	sort.Strings(entries)
	return defaultRouteSample{entries: entries, supported: true}, nil
}

func windowsRouteAddress(value windows.RawSockaddrInet) (string, []byte, error) {
	switch value.Family {
	case windows.AF_INET:
		address := (*windows.RawSockaddrInet4)(unsafe.Pointer(&value))
		return "ipv4", append([]byte(nil), address.Addr[:]...), nil
	case windows.AF_INET6:
		address := (*windows.RawSockaddrInet6)(unsafe.Pointer(&value))
		return "ipv6", append([]byte(nil), address.Addr[:]...), nil
	default:
		return "", nil, errors.New("unsupported route address family")
	}
}
