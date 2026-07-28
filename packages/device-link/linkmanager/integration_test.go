package linkmanager_test

import (
	"github.com/tutti-os/tutti/packages/device-link/authenticated"
	"github.com/tutti-os/tutti/packages/device-link/linkmanager"
)

var _ linkmanager.Link = (*authenticated.Link)(nil)
