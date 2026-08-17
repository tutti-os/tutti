// Package networkchange provides a process-local network environment monitor.
//
// The monitor publishes only monotonically increasing generations. It keeps
// the sampled environment private by hashing interface state, addresses, and
// supported-platform default-route identity; subscribers never receive an
// address, gateway, route, or other raw network value.
package networkchange
