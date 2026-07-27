//go:build darwin

package icequic

import (
	"context"
	"fmt"
	"net"
	"strings"

	"github.com/pion/transport/v4"
	"github.com/pion/transport/v4/stdnet"

	"github.com/tutti-os/tutti/packages/device-link/internal/interfacebind"
	"github.com/tutti-os/tutti/packages/device-link/internal/netfilter"
)

type interfaceBoundNet struct {
	transport.Net
	interfaceIndexByIP map[string]int
}

func newInterfaceBoundNet(includeLoopback bool) (transport.Net, error) {
	base, err := stdnet.NewNet()
	if err != nil {
		return nil, fmt.Errorf("create standard ICE network: %w", err)
	}
	interfaces, err := net.Interfaces()
	if err != nil {
		return nil, fmt.Errorf("list interfaces for direct ICE: %w", err)
	}
	indexes := make(map[string]int)
	for _, iface := range interfaces {
		if iface.Flags&net.FlagUp == 0 || !netfilter.InterfaceNameAllowed(iface.Name, includeLoopback) {
			continue
		}
		addresses, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, address := range addresses {
			raw := address.String()
			if slash := strings.LastIndexByte(raw, '/'); slash >= 0 {
				raw = raw[:slash]
			}
			if zone := strings.LastIndexByte(raw, '%'); zone >= 0 {
				raw = raw[:zone]
			}
			ip := net.ParseIP(raw)
			if !netfilter.IPAllowed(ip, includeLoopback) {
				continue
			}
			indexes[ip.String()] = iface.Index
		}
	}
	if len(indexes) == 0 {
		return nil, fmt.Errorf("no physical interface addresses available for direct ICE")
	}
	return &interfaceBoundNet{Net: base, interfaceIndexByIP: indexes}, nil
}

func (n *interfaceBoundNet) ListenUDP(network string, localAddr *net.UDPAddr) (transport.UDPConn, error) {
	if localAddr == nil || localAddr.IP == nil || localAddr.IP.IsUnspecified() {
		return nil, fmt.Errorf("direct ICE requires a concrete local UDP address")
	}
	interfaceIndex, ok := n.interfaceIndexByIP[localAddr.IP.String()]
	if !ok {
		return nil, fmt.Errorf("direct ICE local address is not owned by an eligible physical interface")
	}
	conn, err := interfacebind.ListenUDP(context.Background(), network, localAddr, interfaceIndex)
	if err != nil {
		return nil, fmt.Errorf("bind direct ICE UDP socket: %w", err)
	}
	return conn, nil
}
