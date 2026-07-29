package devicelink

import (
	"crypto/sha256"
	"encoding/hex"
	"net"
	"sort"
	"strings"
)

// LocalNetworkFingerprint hashes the physical-interface candidate address set
// into a short categorical token. Callers use it to notice that the local
// network environment changed (Wi-Fi switch, cable plugged, address renewal)
// without storing or comparing raw addresses. Virtual and tunnel interfaces
// are excluded through the same policy as candidate gathering, so VPN
// reconnect churn does not alter the fingerprint. An empty string means the
// sample failed and must not be treated as a distinct environment.
func LocalNetworkFingerprint() string {
	ifaces, err := net.Interfaces()
	if err != nil {
		return ""
	}
	parts := make([]string, 0, 8)
	for _, iface := range ifaces {
		if !usableInterface(iface) {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			ip, _, _, ok := candidateFromAddr(addr)
			if !ok {
				continue
			}
			parts = append(parts, iface.Name+"|"+ip.String())
		}
	}
	sort.Strings(parts)
	sum := sha256.Sum256([]byte(strings.Join(parts, "\n")))
	return hex.EncodeToString(sum[:8])
}
