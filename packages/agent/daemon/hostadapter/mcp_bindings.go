package hostadapter

import (
	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
	host "github.com/tutti-os/tutti/packages/agent/host"
)

func runtimeMCPServerBindings(input []host.MCPServerBinding) []agentruntime.MCPServerBinding {
	if len(input) == 0 {
		return nil
	}
	result := make([]agentruntime.MCPServerBinding, 0, len(input))
	for _, binding := range input {
		headers := make(map[string]string, len(binding.Headers))
		for key, value := range binding.Headers {
			headers[key] = value
		}
		result = append(result, agentruntime.MCPServerBinding{Name: binding.Name, Type: binding.Type, URL: binding.URL, Headers: headers})
	}
	return result
}

func hostMCPServerBindings(input []agentruntime.MCPServerBinding) []host.MCPServerBinding {
	if len(input) == 0 {
		return nil
	}
	result := make([]host.MCPServerBinding, 0, len(input))
	for _, binding := range input {
		headers := make(map[string]string, len(binding.Headers))
		for key, value := range binding.Headers {
			headers[key] = value
		}
		result = append(result, host.MCPServerBinding{Name: binding.Name, Type: binding.Type, URL: binding.URL, Headers: headers})
	}
	return result
}
