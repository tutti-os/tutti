//go:build linux && !android

package networkchange

import (
	"strings"
	"testing"
)

func TestParseLinuxDefaultRoutesDoesNotExposeGateway(t *testing.T) {
	v4 := []byte("Iface Destination Gateway Flags RefCnt Use Metric Mask MTU Window IRTT\n" +
		"eth0 00000000 0102A8C0 0003 0 0 100 00000000 0 0 0\n")
	entries, err := parseLinuxIPv4Routes(v4)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("IPv4 default routes = %d, want 1", len(entries))
	}
	if entries[0] == "" || strings.Contains(entries[0], "192.168.2.1") {
		t.Fatalf("route entry exposed or omitted the opaque gateway summary: %q", entries[0])
	}
}

func TestParseLinuxIPv6DefaultRouteUsesKernelPrefixWidth(t *testing.T) {
	route := []byte("00000000000000000000000000000000 00 " +
		"00000000000000000000000000000000 00 " +
		"fe800000000000000000000000000001 00000064 00000000 00000000 00000003 eth0\n")
	entries, err := parseLinuxIPv6Routes(route)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || !strings.HasPrefix(entries[0], "default-route:ipv6|eth0|") {
		t.Fatalf("IPv6 default routes = %q, want one eth0 route", entries)
	}
}
