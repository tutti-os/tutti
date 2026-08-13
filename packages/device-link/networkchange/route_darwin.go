//go:build darwin && !ios

package networkchange

import (
	"context"
	"encoding/hex"
	"errors"
	"sort"
	"strconv"

	"golang.org/x/net/route"
	"golang.org/x/sys/unix"
)

func sampleDefaultRoutes(ctx context.Context) (defaultRouteSample, error) {
	if err := contextErr(ctx); err != nil {
		return defaultRouteSample{}, err
	}
	raw, err := route.FetchRIB(unix.AF_UNSPEC, route.RIBTypeRoute, 0)
	if err != nil {
		return defaultRouteSample{}, errors.New("default route sample failed")
	}
	messages, err := route.ParseRIB(route.RIBTypeRoute, raw)
	if err != nil {
		return defaultRouteSample{}, errors.New("default route sample failed")
	}
	entries := darwinDefaultRouteEntries(messages)
	sort.Strings(entries)
	return defaultRouteSample{entries: entries, supported: true}, nil
}

func darwinDefaultRouteEntries(messages []route.Message) []string {
	entries := make([]string, 0, 2)
	for _, message := range messages {
		routeMessage, ok := message.(*route.RouteMessage)
		if !ok || routeMessage.Flags&unix.RTF_UP == 0 || len(routeMessage.Addrs) < 2 {
			continue
		}
		family, destination, ok := darwinRouteAddress(routeMessage.Addrs[0])
		if !ok || !isZeroBytes(destination) {
			continue
		}
		if len(routeMessage.Addrs) > 2 && routeMessage.Addrs[2] != nil {
			maskFamily, mask, maskOK := darwinRouteAddress(routeMessage.Addrs[2])
			if !maskOK || maskFamily != family || !isZeroBytes(mask) {
				continue
			}
		}
		gatewayFamily, gateway, gatewayOK := darwinRouteAddress(routeMessage.Addrs[1])
		if !gatewayOK {
			continue
		}
		entries = append(entries, "default-route:"+family+"|"+
			strconv.Itoa(routeMessage.Index)+"|"+gatewayFamily+"|"+
			hex.EncodeToString(gateway)+"|"+strconv.Itoa(routeMessage.Flags))
	}
	return entries
}

func darwinRouteAddress(address route.Addr) (string, []byte, bool) {
	switch value := address.(type) {
	case *route.Inet4Addr:
		if value == nil {
			return "", nil, false
		}
		return "ipv4", value.IP[:], true
	case *route.Inet6Addr:
		if value == nil {
			return "", nil, false
		}
		return "ipv6", value.IP[:], true
	case *route.LinkAddr:
		if value == nil {
			return "", nil, false
		}
		encoded := append([]byte(strconv.Itoa(value.Index)+"\x00"+value.Name+"\x00"), value.Addr...)
		return "link", encoded, true
	default:
		return "", nil, false
	}
}
