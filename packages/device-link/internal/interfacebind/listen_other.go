//go:build !darwin

package interfacebind

import (
	"context"
	"fmt"
	"net"
)

// ListenUDP keeps the shared interface explicit on non-Darwin builds. The
// first release only exposes direct physical routing on macOS; other platforms
// retain source-address binding until they grow a native interface option.
func ListenUDP(ctx context.Context, network string, addr *net.UDPAddr, _ int) (*net.UDPConn, error) {
	if addr == nil || addr.IP == nil || addr.IP.IsUnspecified() {
		return nil, fmt.Errorf("listen UDP on interface requires a concrete local address")
	}
	lc := net.ListenConfig{}
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
