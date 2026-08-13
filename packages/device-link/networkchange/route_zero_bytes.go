//go:build (darwin && !ios) || windows

package networkchange

func isZeroBytes(value []byte) bool {
	for _, byteValue := range value {
		if byteValue != 0 {
			return false
		}
	}
	return true
}
