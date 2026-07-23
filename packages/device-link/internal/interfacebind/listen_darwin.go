//go:build darwin

package interfacebind

import (
	"context"
	"fmt"
	"net"
	"syscall"

	"golang.org/x/sys/unix"
)

// ListenUDP opens a UDP socket pinned to one Darwin interface. Binding the
// source address alone is insufficient when a utun route owns the destination;
// IP_BOUND_IF keeps STUN, ICE checks, and application packets on the selected
// physical path.
func ListenUDP(ctx context.Context, network string, addr *net.UDPAddr, interfaceIndex int) (*net.UDPConn, error) {
	if addr == nil || addr.IP == nil || addr.IP.IsUnspecified() {
		return nil, fmt.Errorf("listen UDP on interface requires a concrete local address")
	}
	if interfaceIndex <= 0 {
		return nil, fmt.Errorf("listen UDP on interface requires a positive interface index")
	}
	level := unix.IPPROTO_IPV6
	option := unix.IPV6_BOUND_IF
	if addr.IP.To4() != nil {
		level = unix.IPPROTO_IP
		option = unix.IP_BOUND_IF
	}
	var socketErr error
	lc := net.ListenConfig{
		Control: func(_, _ string, raw syscall.RawConn) error {
			if err := raw.Control(func(fd uintptr) {
				socketErr = unix.SetsockoptInt(int(fd), level, option, interfaceIndex)
			}); err != nil {
				return err
			}
			return socketErr
		},
	}
	packetConn, err := lc.ListenPacket(ctx, network, addr.String())
	if err != nil {
		return nil, err
	}
	conn, ok := packetConn.(*net.UDPConn)
	if !ok {
		_ = packetConn.Close()
		return nil, fmt.Errorf("listen UDP returned %T", packetConn)
	}
	return conn, nil
}
