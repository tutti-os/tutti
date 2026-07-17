// Package agenthost defines the provider-neutral application contract for
// canonical agent session and turn lifecycle orchestration.
//
// Host types deliberately contain no transport, room, device, HTTP, VM, E2B,
// Electron, or control-plane concerns. Products supply those capabilities
// through adapters for the narrow ports declared by this module.
package agenthost
