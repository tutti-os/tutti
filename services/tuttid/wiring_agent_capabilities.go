package main

import (
	"context"

	runtimeprep "github.com/tutti-os/tutti/packages/agent/runtimeprep"
	browsersvc "github.com/tutti-os/tutti/services/tuttid/service/browser"
	computersvc "github.com/tutti-os/tutti/services/tuttid/service/computer"
)

func configureAgentRuntimeAvailability(
	preparer *runtimeprep.DefaultPreparer,
	browserService *browsersvc.Service,
	computerService *computersvc.Service,
) {
	preparer.ComputerUseAvailable = func() bool {
		return runtimeprep.ComputerUseDefaultEnabled() && computerService != nil && computerService.CheckReady(context.Background()) == nil
	}
	preparer.BrowserUseAvailable = func() bool {
		return runtimeprep.BrowserUseDefaultEnabled() && browserService != nil && browserService.CheckReady() == nil
	}
}
