package devicelink

import (
	"context"
	"net"
	"net/netip"
	"strings"
	"time"
)

const (
	ALPN = "tutti-device-link/1"

	defaultHandshakeTimeout = 3 * time.Second
	defaultKeepAlive        = 20 * time.Second
	defaultIdleTimeout      = 2 * time.Minute
)

type CandidateType string

const (
	CandidateTypeLANIPv4    CandidateType = "lan_ipv4"
	CandidateTypeULAIPv6    CandidateType = "ula_ipv6"
	CandidateTypeGlobalIPv6 CandidateType = "global_ipv6"
)

const (
	CandidatePriorityLANIPv4    = 300
	CandidatePriorityULAIPv6    = 250
	CandidatePriorityGlobalIPv6 = 200
	MaxCandidates               = 4
)

// Candidate is a UDP endpoint that can be exchanged through the
// authenticated rendezvous service. Raw candidate values are sensitive and
// must not be written to ordinary logs or metrics.
type Candidate struct {
	CandidateID   string        `json:"candidateId"`
	Address       string        `json:"address"`
	CandidateType CandidateType `json:"candidateType"`
	Priority      int           `json:"priority"`

	// InterfaceName, InterfaceIndex, and InterfacePrefix are local-only
	// discovery metadata. They must not be required by peers or exchanged with
	// the rendezvous service.
	InterfaceName   string       `json:"-"`
	InterfaceIndex  int          `json:"-"`
	InterfacePrefix netip.Prefix `json:"-"`
}

func (c Candidate) ID() string {
	return strings.TrimSpace(c.CandidateID)
}

// BoundEndpoint owns the UDP socket used first for connectivity checking and
// then for QUIC. Reusing the socket is required so stateful firewalls observe
// the same local endpoint throughout the attempt.
type BoundEndpoint struct {
	Candidate Candidate
	Conn      *net.UDPConn
}

func (e *BoundEndpoint) Close() error {
	if e == nil || e.Conn == nil {
		return nil
	}
	return e.Conn.Close()
}

type StreamDialer interface {
	OpenStream(context.Context) (net.Conn, error)
}
