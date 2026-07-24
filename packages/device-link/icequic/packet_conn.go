// Package icequic adapts an ICE-selected connection to the packet interface
// quic-go requires. It is the integration seam between pion/ice (candidate
// gathering, hole punching, path selection) and the device-link QUIC
// transport (proposal shared-agent-p2p-nat-traversal.md, milestone M2).
package icequic

import (
	"errors"
	"net"
	"time"
)

// SinglePeerPacketConn presents a connected, packet-boundary-preserving
// net.Conn — pion's ice.Conn — as a net.PacketConn for quic-go. Every write
// goes down the ICE-selected path regardless of the addr argument, and every
// read is attributed to the fixed remote, which is sound because an ICE
// session speaks to exactly one peer.
type SinglePeerPacketConn struct {
	conn   net.Conn
	remote net.Addr
}

func NewSinglePeerPacketConn(conn net.Conn) (*SinglePeerPacketConn, error) {
	if conn == nil {
		return nil, errors.New("icequic packet conn requires a selected ICE connection")
	}
	remote := conn.RemoteAddr()
	if remote == nil {
		return nil, errors.New("icequic packet conn requires a remote address")
	}
	return &SinglePeerPacketConn{conn: conn, remote: remote}, nil
}

func (c *SinglePeerPacketConn) ReadFrom(p []byte) (int, net.Addr, error) {
	n, err := c.conn.Read(p)
	return n, c.remote, err
}

func (c *SinglePeerPacketConn) WriteTo(p []byte, _ net.Addr) (int, error) {
	return c.conn.Write(p)
}

func (c *SinglePeerPacketConn) Close() error                       { return c.conn.Close() }
func (c *SinglePeerPacketConn) LocalAddr() net.Addr                { return c.conn.LocalAddr() }
func (c *SinglePeerPacketConn) RemoteAddr() net.Addr               { return c.remote }
func (c *SinglePeerPacketConn) SetDeadline(t time.Time) error      { return c.conn.SetDeadline(t) }
func (c *SinglePeerPacketConn) SetReadDeadline(t time.Time) error  { return c.conn.SetReadDeadline(t) }
func (c *SinglePeerPacketConn) SetWriteDeadline(t time.Time) error { return c.conn.SetWriteDeadline(t) }
