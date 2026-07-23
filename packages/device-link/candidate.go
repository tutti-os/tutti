package devicelink

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"sort"
	"strconv"
	"strings"

	"github.com/tutti-os/tutti/packages/device-link/internal/netfilter"
)

var (
	ErrNoCandidate           = errors.New("no usable device-link candidate")
	ErrNoGlobalIPv6Candidate = errors.New("no usable global IPv6 candidate")
)

type discoveredAddress struct {
	iface         net.Interface
	ip            netip.Addr
	prefix        netip.Prefix
	candidateType CandidateType
	priority      int
}

// ListenCandidates opens at most MaxCandidates interface-pinned UDP sockets
// across LAN IPv4, ULA IPv6, and global IPv6 addresses. Virtual/tunnel
// interfaces are excluded before any socket is opened.
func ListenCandidates(ctx context.Context) ([]*BoundEndpoint, error) {
	endpoints, err := listenCandidates(ctx, nil, MaxCandidates)
	if err != nil {
		return nil, err
	}
	if len(endpoints) == 0 {
		return nil, ErrNoCandidate
	}
	return endpoints, nil
}

// ListenGlobalIPv6 preserves the diagnostics discovery API while using the
// same physical-interface filtering and bounded candidate model.
func ListenGlobalIPv6(ctx context.Context) ([]*BoundEndpoint, error) {
	onlyGlobal := CandidateTypeGlobalIPv6
	endpoints, err := listenCandidates(ctx, &onlyGlobal, MaxCandidates)
	if err != nil {
		return nil, err
	}
	if len(endpoints) == 0 {
		return nil, ErrNoGlobalIPv6Candidate
	}
	return endpoints, nil
}

func listenCandidates(ctx context.Context, onlyType *CandidateType, limit int) ([]*BoundEndpoint, error) {
	interfaces, err := net.Interfaces()
	if err != nil {
		return nil, fmt.Errorf("list network interfaces: %w", err)
	}
	sort.SliceStable(interfaces, func(i, j int) bool {
		return interfaces[i].Index < interfaces[j].Index
	})

	var discovered []discoveredAddress
	for _, iface := range interfaces {
		if !usableInterface(iface) {
			continue
		}
		addresses, err := iface.Addrs()
		if err != nil {
			continue
		}
		seenType := make(map[CandidateType]bool)
		for _, address := range addresses {
			item, ok := discoveredAddressFromAddr(iface, address)
			if !ok || seenType[item.candidateType] || (onlyType != nil && item.candidateType != *onlyType) {
				continue
			}
			seenType[item.candidateType] = true
			discovered = append(discovered, item)
		}
	}
	sort.SliceStable(discovered, func(i, j int) bool {
		if discovered[i].priority != discovered[j].priority {
			return discovered[i].priority > discovered[j].priority
		}
		return discovered[i].iface.Index < discovered[j].iface.Index
	})
	if limit <= 0 || limit > MaxCandidates {
		limit = MaxCandidates
	}

	endpoints := make([]*BoundEndpoint, 0, min(limit, len(discovered)))
	for _, item := range discovered {
		if len(endpoints) == limit {
			break
		}
		conn, err := listenUDPOnInterface(ctx, item.ip, item.iface)
		if err != nil {
			continue
		}
		endpoints = append(endpoints, &BoundEndpoint{
			Candidate: Candidate{
				CandidateID:     fmt.Sprintf("c%d", len(endpoints)+1),
				Address:         conn.LocalAddr().String(),
				CandidateType:   item.candidateType,
				Priority:        item.priority,
				InterfaceName:   item.iface.Name,
				InterfaceIndex:  item.iface.Index,
				InterfacePrefix: item.prefix,
			},
			Conn: conn,
		})
	}
	return endpoints, nil
}

func discoveredAddressFromAddr(iface net.Interface, address net.Addr) (discoveredAddress, bool) {
	ip, candidateType, priority, ok := candidateFromAddr(address)
	if !ok {
		return discoveredAddress{}, false
	}
	// Prefix metadata improves diagnostics but must never gate a usable data
	// path. Unknown address implementations degrade to conservative scope.
	prefix, _ := prefixFromAddr(address)
	return discoveredAddress{
		iface: iface, ip: ip, prefix: prefix, candidateType: candidateType, priority: priority,
	}, true
}

func usableInterface(iface net.Interface) bool {
	if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
		return false
	}
	return netfilter.InterfaceNameAllowed(iface.Name, false)
}

func candidateFromAddr(address net.Addr) (netip.Addr, CandidateType, int, bool) {
	ip, ok := ipFromAddr(address)
	if !ok || ip.IsUnspecified() || ip.IsLoopback() || ip.IsMulticast() || ip.IsLinkLocalUnicast() {
		return netip.Addr{}, "", 0, false
	}
	switch {
	case ip.Is4() && ip.IsPrivate():
		return ip, CandidateTypeLANIPv4, CandidatePriorityLANIPv4, true
	case ip.Is6() && !ip.Is4In6() && ip.IsPrivate():
		return ip, CandidateTypeULAIPv6, CandidatePriorityULAIPv6, true
	case ip.Is6() && !ip.Is4In6() && ip.IsGlobalUnicast() && !ip.IsPrivate():
		return ip, CandidateTypeGlobalIPv6, CandidatePriorityGlobalIPv6, true
	default:
		return netip.Addr{}, "", 0, false
	}
}

func ipFromAddr(address net.Addr) (netip.Addr, bool) {
	if address == nil {
		return netip.Addr{}, false
	}
	raw := strings.TrimSpace(address.String())
	if i := strings.LastIndex(raw, "/"); i >= 0 {
		raw = raw[:i]
	}
	if i := strings.LastIndex(raw, "%"); i >= 0 {
		raw = raw[:i]
	}
	ip, err := netip.ParseAddr(raw)
	return ip, err == nil
}

func prefixFromAddr(address net.Addr) (netip.Prefix, bool) {
	if address == nil {
		return netip.Prefix{}, false
	}
	raw := strings.TrimSpace(address.String())
	slash := strings.LastIndex(raw, "/")
	if slash < 0 {
		return netip.Prefix{}, false
	}
	addressPart := raw[:slash]
	if zone := strings.LastIndex(addressPart, "%"); zone >= 0 {
		addressPart = addressPart[:zone]
	}
	ip, err := netip.ParseAddr(addressPart)
	if err != nil {
		return netip.Prefix{}, false
	}
	bits, err := strconv.Atoi(raw[slash+1:])
	if err != nil || bits < 0 || bits > ip.BitLen() {
		return netip.Prefix{}, false
	}
	return netip.PrefixFrom(ip, bits).Masked(), true
}

func globalIPv6FromAddr(address net.Addr) (netip.Addr, bool) {
	ip, candidateType, _, ok := candidateFromAddr(address)
	return ip, ok && candidateType == CandidateTypeGlobalIPv6
}
