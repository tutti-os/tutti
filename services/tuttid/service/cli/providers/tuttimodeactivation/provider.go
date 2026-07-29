// Package tuttimodeactivation exposes the durable Tutti Mode activation as an
// Agent-facing CLI capability. It lets an Agent enable or disable Tutti Mode
// for its own session; the mutation flows through the activation service Set
// path, so the durable state and the live GUI toggle stay authoritative.
package tuttimodeactivation

import (
	"context"

	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
	tuttimodeactivationservice "github.com/tutti-os/tutti/services/tuttid/service/tuttimodeactivation"
)

const appID = "tutti-mode"

// Activations is the exact activation-service surface the command needs. Set
// publishes the update event on a durable change, giving the GUI toggle a live
// reflection for free.
type Activations interface {
	Set(context.Context, tuttimodeactivationservice.SetInput) (tuttimodeactivationservice.SetResult, error)
}

type Provider struct {
	activations Activations
}

func NewProvider(activations Activations) Provider {
	return Provider{activations: activations}
}

func (Provider) AppID() string {
	return appID
}

func (p Provider) Commands() []cliservice.Command {
	return []cliservice.Command{p.newModeSetCommand()}
}

func (p Provider) requireActivations() error {
	if p.activations == nil {
		return cliservice.ServiceUnavailableError("Tutti Mode activation service is unavailable", nil)
	}
	return nil
}
