//go:build darwin && !ios

package networkchange

import (
	"context"
	"strings"
	"testing"

	"golang.org/x/net/route"
	"golang.org/x/sys/unix"
)

func TestDarwinDefaultRouteSampleReadsNativeRIB(t *testing.T) {
	sample, err := sampleDefaultRoutes(context.Background())
	if err != nil {
		t.Fatalf("sampleDefaultRoutes() error = %v", err)
	}
	if !sample.supported {
		t.Fatal("Darwin default route sample reported unsupported")
	}
}

func TestDarwinDefaultRouteEntriesIncludeOnlyUsableDefaults(t *testing.T) {
	messages := []route.Message{
		&route.RouteMessage{
			Flags: unix.RTF_UP, Index: 4,
			Addrs: []route.Addr{
				&route.Inet4Addr{},
				&route.Inet4Addr{IP: [4]byte{192, 0, 2, 1}},
				&route.Inet4Addr{},
			},
		},
		&route.RouteMessage{
			Flags: unix.RTF_UP, Index: 5,
			Addrs: []route.Addr{
				&route.Inet4Addr{IP: [4]byte{10, 0, 0, 0}},
				&route.Inet4Addr{IP: [4]byte{192, 0, 2, 2}},
				&route.Inet4Addr{IP: [4]byte{255, 0, 0, 0}},
			},
		},
		&route.RouteMessage{
			Flags: 0, Index: 6,
			Addrs: []route.Addr{
				&route.Inet6Addr{},
				&route.Inet6Addr{IP: [16]byte{15: 1}},
				&route.Inet6Addr{},
			},
		},
	}

	entries := darwinDefaultRouteEntries(messages)
	if len(entries) != 1 || !strings.HasPrefix(entries[0], "default-route:ipv4|4|ipv4|") {
		t.Fatalf("Darwin default routes = %q, want one interface 4 route", entries)
	}
	if strings.Contains(entries[0], "192.0.2.1") {
		t.Fatalf("route entry exposed a raw gateway: %q", entries[0])
	}
}
