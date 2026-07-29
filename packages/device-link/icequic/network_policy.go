package icequic

import "fmt"

// NetworkPolicy controls which OS path owns ICE UDP sockets. System leaves
// routing to the OS (including any active TUN); Direct binds every socket to a
// physical interface and is currently implemented on macOS only.
type NetworkPolicy string

const (
	NetworkPolicySystem NetworkPolicy = "system"
	NetworkPolicyDirect NetworkPolicy = "direct"
)

func normalizeNetworkPolicy(policy NetworkPolicy) (NetworkPolicy, error) {
	if policy == "" {
		return NetworkPolicySystem, nil
	}
	switch policy {
	case NetworkPolicySystem, NetworkPolicyDirect:
		return policy, nil
	default:
		return "", fmt.Errorf("unsupported device-link network policy %q", policy)
	}
}
