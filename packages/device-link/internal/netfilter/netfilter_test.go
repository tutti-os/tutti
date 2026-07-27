package netfilter

import (
	"net/netip"
	"testing"
)

func TestInterfaceNameAllowed(t *testing.T) {
	tests := []struct {
		name string
		want bool
	}{
		{name: "utun4"},
		{name: "tun0"},
		{name: "tap0"},
		{name: "lo0"},
		{name: "bridge100"},
		{name: "awdl0"},
		{name: "llw0"},
		{name: "en0", want: true},
		{name: "eth0", want: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := InterfaceNameAllowed(tt.name, false); got != tt.want {
				t.Fatalf("InterfaceNameAllowed(%q, false) = %v, want %v", tt.name, got, tt.want)
			}
		})
	}
}

func TestInterfaceNameAllowedIncludesOnlyLoopbackEscapeHatch(t *testing.T) {
	for _, name := range []string{"lo", "lo0"} {
		if !InterfaceNameAllowed(name, true) {
			t.Fatalf("InterfaceNameAllowed(%q, true) = false, want true", name)
		}
	}
	for _, name := range []string{"utun4", "tun0", "tap0", "bridge100"} {
		if InterfaceNameAllowed(name, true) {
			t.Fatalf("InterfaceNameAllowed(%q, true) = true, want false", name)
		}
	}
}

func TestPublicInternetIPAllowed(t *testing.T) {
	tests := []struct {
		address string
		want    bool
	}{
		{address: "1.1.1.1", want: true},
		{address: "8.8.8.8", want: true},
		{address: "2606:4700:4700::1111", want: true},
		{address: "::ffff:8.8.8.8", want: true},
		{address: "127.0.0.1"},
		{address: "10.0.0.1"},
		{address: "100.64.0.1"},
		{address: "169.254.1.1"},
		{address: "192.0.0.9"},
		{address: "192.31.196.1"},
		{address: "198.18.0.1"},
		{address: "203.0.113.1"},
		{address: "64:ff9b::808:808"},
		{address: "100::1"},
		{address: "2001:1::1"},
		{address: "2001:2::1"},
		{address: "2001:db8::1"},
		{address: "2002::1"},
		{address: "3fff::1"},
		{address: "5f00::1"},
		{address: "fc00::1"},
		{address: "fe80::1"},
	}
	for _, tt := range tests {
		t.Run(tt.address, func(t *testing.T) {
			if got := PublicInternetIPAllowed(netip.MustParseAddr(tt.address)); got != tt.want {
				t.Fatalf("PublicInternetIPAllowed(%q) = %v, want %v", tt.address, got, tt.want)
			}
		})
	}
}
