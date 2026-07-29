//go:build !darwin

package devicelink

import (
	"context"
	"fmt"
	"net"
	"net/netip"

	"github.com/tutti-os/tutti/packages/device-link/internal/interfacebind"
)

func listenUDPOnInterface(ctx context.Context, ip netip.Addr, iface net.Interface) (*net.UDPConn, error) {
	network := "udp6"
	if ip.Is4() {
		network = "udp4"
	}
	conn, err := interfacebind.ListenUDP(ctx, network, &net.UDPAddr{IP: net.IP(ip.AsSlice())}, iface.Index)
	if err != nil {
		return nil, fmt.Errorf("listen %s on interface %s: %w", network, iface.Name, err)
	}
	return conn, nil
}
