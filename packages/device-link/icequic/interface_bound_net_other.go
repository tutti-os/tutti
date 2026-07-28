//go:build !darwin

package icequic

import (
	"fmt"

	"github.com/pion/transport/v4"
)

func newInterfaceBoundNet(bool) (transport.Net, error) {
	return nil, fmt.Errorf("direct physical ICE routing is supported on macOS only")
}
