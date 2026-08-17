//go:build linux && !android

package networkchange

import (
	"encoding/hex"
	"errors"
	"strconv"
	"strings"
)

func parseLinuxIPv4Routes(data []byte) ([]string, error) {
	entries := make([]string, 0, 1)
	for lineNumber, line := range strings.Split(string(data), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 0 || (lineNumber == 0 && fields[0] == "Iface") {
			continue
		}
		if len(fields) < 8 {
			return nil, errors.New("default route sample failed")
		}
		destination, gateway, flags, metric, mask := fields[1], fields[2], fields[3], fields[6], fields[7]
		if !isHex(destination, 8) || !isHex(mask, 8) {
			return nil, errors.New("default route sample failed")
		}
		if !isHexZero(destination, 8) || !isHexZero(mask, 8) {
			continue
		}
		if !isHexUint32(flags) || !isHex(gateway, 8) || !isDecimal(metric) {
			return nil, errors.New("default route sample failed")
		}
		if !hasHexFlag(flags, 1) {
			continue
		}
		entries = append(entries, "default-route:ipv4|"+fields[0]+"|"+strings.ToUpper(gateway)+"|"+metric+"|"+strings.ToUpper(flags))
	}
	return entries, nil
}

func parseLinuxIPv6Routes(data []byte) ([]string, error) {
	entries := make([]string, 0, 1)
	for _, line := range strings.Split(string(data), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		if len(fields) < 10 {
			return nil, errors.New("default route sample failed")
		}
		destination, prefix, nextHop := fields[0], fields[1], fields[4]
		if !isHex(destination, 32) || !isHex(prefix, 2) {
			return nil, errors.New("default route sample failed")
		}
		if !isHexZero(destination, 32) || !isHexZero(prefix, 2) {
			continue
		}
		metric, flags := fields[5], fields[8]
		if !isHex(nextHop, 32) || !isHex(metric, 8) || !isHex(flags, 8) {
			return nil, errors.New("default route sample failed")
		}
		if !hasHexFlag(flags, 1) {
			continue
		}
		entries = append(entries, "default-route:ipv6|"+fields[9]+"|"+strings.ToUpper(nextHop)+"|"+strings.ToUpper(metric)+"|"+strings.ToUpper(flags))
	}
	return entries, nil
}

func isHex(value string, length int) bool {
	if len(value) != length {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}

func isHexZero(value string, length int) bool {
	return isHex(value, length) && strings.Trim(value, "0") == ""
}

func hasHexFlag(value string, flag byte) bool {
	parsed, err := strconv.ParseUint(value, 16, 32)
	return err == nil && parsed&uint64(flag) != 0
}

func isHexUint32(value string) bool {
	_, err := strconv.ParseUint(value, 16, 32)
	return err == nil
}

func isDecimal(value string) bool {
	_, err := strconv.ParseUint(value, 10, 32)
	return err == nil
}
