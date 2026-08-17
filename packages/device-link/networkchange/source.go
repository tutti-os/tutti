package networkchange

import (
	"context"
	"crypto/sha256"
	"errors"
	"net"
	"net/netip"
	"sort"
	"strconv"
	"strings"
)

type defaultRouteSample struct {
	entries   []string
	supported bool
}

func sampleLocalNetwork(ctx context.Context) (Fingerprint, error) {
	if err := contextErr(ctx); err != nil {
		return Fingerprint{}, err
	}
	interfaces, err := net.Interfaces()
	if err != nil {
		return Fingerprint{}, errors.New("network interface sample failed")
	}
	parts := make([]string, 0, len(interfaces)*3)
	for _, iface := range interfaces {
		if err := contextErr(ctx); err != nil {
			return Fingerprint{}, err
		}
		// Interface names and addresses are input to the digest only. They
		// never leave this function or appear in an error/event.
		parts = append(parts, iface.Name+"\x00"+strconv.Itoa(iface.Index)+"\x00"+strconv.FormatUint(uint64(iface.Flags), 10))
		addresses, err := iface.Addrs()
		if err != nil {
			return Fingerprint{}, errors.New("network address sample failed")
		}
		for _, address := range addresses {
			canonical, ok := canonicalAddress(address)
			if !ok {
				return Fingerprint{}, errors.New("network address sample failed")
			}
			parts = append(parts, iface.Name+"\x00"+canonical)
		}
	}
	routes, err := sampleDefaultRoutes(ctx)
	if err != nil {
		return Fingerprint{}, err
	}
	if routes.supported {
		if len(routes.entries) == 0 {
			parts = append(parts, "default-route:none")
		} else {
			parts = append(parts, routes.entries...)
		}
	} else {
		parts = append(parts, "default-route:unsupported")
	}
	sort.Strings(parts)
	return sha256.Sum256([]byte(strings.Join(parts, "\n"))), nil
}

func canonicalAddress(address net.Addr) (string, bool) {
	if address == nil {
		return "", false
	}
	raw := strings.TrimSpace(address.String())
	if raw == "" {
		return "", false
	}
	slash := strings.LastIndexByte(raw, '/')
	addressPart := raw
	prefixLength := ""
	if slash >= 0 {
		addressPart = raw[:slash]
		prefixLength = raw[slash+1:]
		if _, err := strconv.Atoi(prefixLength); err != nil {
			return "", false
		}
	}
	if zone := strings.LastIndexByte(addressPart, '%'); zone >= 0 {
		addressPart = addressPart[:zone]
	}
	ip, err := netip.ParseAddr(addressPart)
	if err != nil {
		return "", false
	}
	if prefixLength == "" {
		return ip.String(), true
	}
	return ip.String() + "/" + prefixLength, true
}

func contextErr(ctx context.Context) error {
	if ctx == nil {
		return nil
	}
	return ctx.Err()
}
