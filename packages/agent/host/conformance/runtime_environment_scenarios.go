package conformance

import (
	"encoding/json"
	"fmt"
	"strings"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
)

func environmentValue(env []string, key string) (string, bool) {
	prefix := key + "="
	for _, entry := range env {
		if strings.HasPrefix(entry, prefix) {
			return strings.TrimPrefix(entry, prefix), true
		}
	}
	return "", false
}

func requireRuntimeRailPlacement(env []string, want agenthost.RailPlacement) error {
	runtimePlacementValue, found := environmentValue(env, agenthost.AgentRailPlacementEnvironmentVariable)
	if !found {
		return fmt.Errorf("env=%#v, want %s", env, agenthost.AgentRailPlacementEnvironmentVariable)
	}
	var placement agenthost.RailPlacement
	if err := json.Unmarshal([]byte(runtimePlacementValue), &placement); err != nil {
		return fmt.Errorf("decode rail placement %q: %w", runtimePlacementValue, err)
	}
	if placement != want {
		return fmt.Errorf("rail placement=%#v, want %#v", placement, want)
	}
	return nil
}
