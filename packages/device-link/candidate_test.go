package devicelink

import (
	"encoding/json"
	"net"
	"net/netip"
	"strings"
	"testing"
)

func TestCandidateFromAddr(t *testing.T) {
	tests := []struct {
		name     string
		address  string
		wantType CandidateType
		wantOK   bool
	}{
		{name: "lan IPv4 10", address: "10.2.3.4/8", wantType: CandidateTypeLANIPv4, wantOK: true},
		{name: "lan IPv4 172", address: "172.20.3.4/16", wantType: CandidateTypeLANIPv4, wantOK: true},
		{name: "lan IPv4 192", address: "192.168.3.4/24", wantType: CandidateTypeLANIPv4, wantOK: true},
		{name: "ULA IPv6", address: "fd12:3456::4/64", wantType: CandidateTypeULAIPv6, wantOK: true},
		{name: "global IPv6", address: "2001:db8::4/64", wantType: CandidateTypeGlobalIPv6, wantOK: true},
		{name: "public IPv4 excluded", address: "192.0.2.4/24", wantOK: false},
		{name: "carrier NAT IPv4 excluded", address: "100.64.1.4/10", wantOK: false},
		{name: "IPv4 link local excluded", address: "169.254.1.4/16", wantOK: false},
		{name: "IPv6 link local excluded", address: "fe80::4%en0/64", wantOK: false},
		{name: "loopback excluded", address: "::1/128", wantOK: false},
		{name: "multicast excluded", address: "ff02::1/128", wantOK: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, gotType, _, gotOK := candidateFromAddr(testAddr(tt.address))
			if gotOK != tt.wantOK || gotType != tt.wantType {
				t.Fatalf("candidateFromAddr(%q) = (%q, %v), want (%q, %v)", tt.address, gotType, gotOK, tt.wantType, tt.wantOK)
			}
		})
	}
}

func TestPrefixFromAddr(t *testing.T) {
	tests := []struct {
		address string
		want    netip.Prefix
		ok      bool
	}{
		{address: "192.168.3.4/24", want: netip.MustParsePrefix("192.168.3.0/24"), ok: true},
		{address: "fd12:3456::4/64", want: netip.MustParsePrefix("fd12:3456::/64"), ok: true},
		{address: "fe80::4%en0/64", want: netip.MustParsePrefix("fe80::/64"), ok: true},
		{address: "192.168.3.4", ok: false},
	}
	for _, tt := range tests {
		got, ok := prefixFromAddr(testAddr(tt.address))
		if ok != tt.ok || got != tt.want {
			t.Fatalf("prefixFromAddr(%q) = (%q, %v), want (%q, %v)", tt.address, got, ok, tt.want, tt.ok)
		}
	}
}

func TestDiscoveredAddressKeepsCandidateWithoutPrefix(t *testing.T) {
	item, ok := discoveredAddressFromAddr(
		net.Interface{Name: "en0", Index: 1},
		testAddr("192.168.3.4"),
	)
	if !ok || item.candidateType != CandidateTypeLANIPv4 || item.prefix.IsValid() {
		t.Fatalf("discovered address = %#v, ok=%v", item, ok)
	}
}

func TestCandidateJSONExcludesLocalInterfaceMetadata(t *testing.T) {
	candidate := Candidate{
		CandidateID: "candidate-1", Address: "192.168.3.4:41000",
		CandidateType: CandidateTypeLANIPv4, Priority: CandidatePriorityLANIPv4,
		InterfaceName: "en0", InterfaceIndex: 1,
		InterfacePrefix: netip.MustParsePrefix("192.168.3.0/24"),
	}
	payload, err := json.Marshal(candidate)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"en0", "interface", "192.168.3.0/24"} {
		if strings.Contains(string(payload), forbidden) {
			t.Fatalf("candidate JSON contains local metadata %q: %s", forbidden, payload)
		}
	}
}

func TestUsableInterfaceExcludesVirtualAndTunnelNames(t *testing.T) {
	for _, name := range []string{
		"utun4", "tun0", "tap0", "lo0", "bridge100", "awdl0", "llw0",
		"vmenet0", "vmnet8", "docker0", "veth123", "virbr0", "ppp0",
		"ipsec0", "wg0", "tailscale0", "ztabc", "ham0", "br-123",
	} {
		if usableInterface(net.Interface{Name: name, Flags: net.FlagUp}) {
			t.Fatalf("usableInterface(%q) = true, want false", name)
		}
	}
	if !usableInterface(net.Interface{Name: "en0", Flags: net.FlagUp}) {
		t.Fatal("usableInterface(en0) = false, want true")
	}
	if usableInterface(net.Interface{Name: "en0"}) {
		t.Fatal("usableInterface(down en0) = true, want false")
	}
}
