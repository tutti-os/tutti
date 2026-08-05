//go:build !darwin

package agentruntime

func platformConnectorProcessSandbox() connectorProcessSandbox { return nil }
