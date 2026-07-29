package netfilter

import (
	"net"
	"net/netip"
	"strings"
)

var excludedInterfacePrefixes = []string{
	"utun", "tun", "tap", "lo", "awdl", "llw", "bridge", "br-",
	"vmenet", "vmnet", "docker", "veth", "virbr", "ppp", "ipsec",
	"wg", "tailscale", "zt", "ham",
}

var (
	globalIPv6UnicastPrefix = netip.MustParsePrefix("2000::/3")
	// Reject every IANA special-purpose allocation, including entries that are
	// technically globally reachable anycast services. Device-link STUN must
	// target an ordinary public server, never infrastructure with another
	// protocol-defined purpose.
	specialPurposePrefixes = []netip.Prefix{
		netip.MustParsePrefix("0.0.0.0/8"),
		netip.MustParsePrefix("10.0.0.0/8"),
		netip.MustParsePrefix("100.64.0.0/10"),
		netip.MustParsePrefix("127.0.0.0/8"),
		netip.MustParsePrefix("169.254.0.0/16"),
		netip.MustParsePrefix("172.16.0.0/12"),
		netip.MustParsePrefix("192.0.0.0/24"),
		netip.MustParsePrefix("192.0.2.0/24"),
		netip.MustParsePrefix("192.31.196.0/24"),
		netip.MustParsePrefix("192.52.193.0/24"),
		netip.MustParsePrefix("192.88.99.0/24"),
		netip.MustParsePrefix("192.168.0.0/16"),
		netip.MustParsePrefix("192.175.48.0/24"),
		netip.MustParsePrefix("198.18.0.0/15"),
		netip.MustParsePrefix("198.51.100.0/24"),
		netip.MustParsePrefix("203.0.113.0/24"),
		netip.MustParsePrefix("240.0.0.0/4"),
		netip.MustParsePrefix("2001::/23"),
		netip.MustParsePrefix("2001:db8::/32"),
		netip.MustParsePrefix("2002::/16"),
		netip.MustParsePrefix("2620:4f:8000::/48"),
		netip.MustParsePrefix("3fff::/20"),
	}
)

// InterfaceNameAllowed reports whether an interface is eligible for
// device-link candidate gathering. The list deliberately excludes virtual,
// tunnel, and peer-to-peer interfaces so candidates stay pinned to physical
// network interfaces.
func InterfaceNameAllowed(name string, includeLoopback bool) bool {
	name = strings.ToLower(strings.TrimSpace(name))
	if includeLoopback && strings.HasPrefix(name, "lo") {
		return true
	}
	for _, prefix := range excludedInterfacePrefixes {
		if strings.HasPrefix(name, prefix) {
			return false
		}
	}
	return true
}

// IPAllowed reports whether an interface address is eligible for device-link
// candidate gathering. includeLoopback is a test-only escape hatch used by
// interface-less CI and must remain false in production.
func IPAllowed(ip net.IP, includeLoopback bool) bool {
	return ip != nil && !ip.IsUnspecified() && !ip.IsMulticast() &&
		!ip.IsLinkLocalUnicast() && (includeLoopback || !ip.IsLoopback())
}

// PublicInternetIPAllowed reports whether an address is an ordinary public
// Internet unicast address suitable for a server-delivered STUN destination.
// IPv6 fails closed outside IANA's currently allocated 2000::/3 global-unicast
// space. The special-purpose tables are maintained from the IANA IPv4 and IPv6
// registries.
func PublicInternetIPAllowed(ip netip.Addr) bool {
	if !ip.IsValid() || ip.Zone() != "" {
		return false
	}
	ip = ip.Unmap()
	if !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
		return false
	}
	if ip.Is6() && !globalIPv6UnicastPrefix.Contains(ip) {
		return false
	}
	for _, prefix := range specialPurposePrefixes {
		if prefix.Contains(ip) {
			return false
		}
	}
	return true
}
