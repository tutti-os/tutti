package cli

import (
	"context"
	"errors"
)

// CompositeDynamicCommandRegistry lets app and connector command authorities
// coexist without teaching the stable daemon CLI registry either domain.
type CompositeDynamicCommandRegistry struct {
	Registries []DynamicCommandRegistry
}

func (composite CompositeDynamicCommandRegistry) Capabilities(ctx context.Context, invokeContext InvokeContext) []Capability {
	result := []Capability{}
	seen := map[string]struct{}{}
	for _, registry := range composite.Registries {
		if registry == nil {
			continue
		}
		for _, capability := range registry.Capabilities(ctx, invokeContext) {
			if _, duplicate := seen[capability.ID]; duplicate {
				continue
			}
			seen[capability.ID] = struct{}{}
			result = append(result, capability)
		}
	}
	return result
}

func (composite CompositeDynamicCommandRegistry) Invoke(ctx context.Context, request InvokeRequest) (CommandOutput, error) {
	for _, registry := range composite.Registries {
		if registry == nil {
			continue
		}
		output, err := registry.Invoke(ctx, request)
		if err == nil {
			return output, nil
		}
		if !errors.Is(err, ErrCommandNotFound) {
			return CommandOutput{}, err
		}
	}
	return CommandOutput{}, ErrCommandNotFound
}
