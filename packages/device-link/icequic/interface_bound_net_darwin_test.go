//go:build darwin

package icequic

import (
	"context"
	"net"
	"strconv"
	"testing"
	"time"

	"github.com/pion/stun/v3"
	"golang.org/x/sys/unix"
)

func TestInterfaceBoundNetPinsDarwinUDPSocket(t *testing.T) {
	transportNet, err := newInterfaceBoundNet(true)
	if err != nil {
		t.Fatal(err)
	}
	conn, err := transportNet.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	udpConn, ok := conn.(*net.UDPConn)
	if !ok {
		t.Fatalf("ListenUDP returned %T, want *net.UDPConn", conn)
	}
	raw, err := udpConn.SyscallConn()
	if err != nil {
		t.Fatal(err)
	}
	var boundIndex int
	var socketErr error
	if err := raw.Control(func(fd uintptr) {
		boundIndex, socketErr = unix.GetsockoptInt(int(fd), unix.IPPROTO_IP, unix.IP_BOUND_IF)
	}); err != nil {
		t.Fatal(err)
	}
	if socketErr != nil {
		t.Fatal(socketErr)
	}
	loopback, err := net.InterfaceByName("lo0")
	if err != nil {
		t.Fatal(err)
	}
	if boundIndex != loopback.Index {
		t.Fatalf("IP_BOUND_IF = %d, want lo0 index %d", boundIndex, loopback.Index)
	}
}

func TestDirectAgentGathersSrflxThroughBoundSocket(t *testing.T) {
	stunConn, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	defer stunConn.Close()
	go serveTestSTUN(stunConn)

	agent, err := NewAgent(AgentConfig{
		STUNEndpoints:         []string{"stun:127.0.0.1:" + strconv.Itoa(stunConn.LocalAddr().(*net.UDPAddr).Port)},
		STUNGatherTimeout:     2 * time.Second,
		IncludeLoopback:       true,
		ExcludeHostCandidates: true,
		NetworkPolicy:         NetworkPolicyDirect,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer agent.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	params, err := agent.LocalParams(ctx)
	if err != nil {
		t.Fatalf("gather direct srflx candidate: %v", err)
	}
	if len(params.Candidates) == 0 {
		t.Fatal("direct bound socket gathered no srflx candidates")
	}
}

func serveTestSTUN(conn *net.UDPConn) {
	buffer := make([]byte, 1500)
	for {
		n, addr, err := conn.ReadFromUDP(buffer)
		if err != nil {
			return
		}
		request := &stun.Message{Raw: append([]byte(nil), buffer[:n]...)}
		if err := request.Decode(); err != nil || request.Type != stun.BindingRequest {
			continue
		}
		response, err := stun.Build(request, stun.BindingSuccess,
			&stun.XORMappedAddress{IP: addr.IP, Port: addr.Port}, stun.Fingerprint)
		if err == nil {
			_, _ = conn.WriteToUDP(response.Raw, addr)
		}
	}
}
