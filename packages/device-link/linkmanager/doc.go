// Package linkmanager owns product-neutral DeviceLink connection lifecycle
// mechanics above an authenticated stream link.
//
// It provides generation-fenced admission, per-peer establishment
// serialization, authenticated link reuse with idle retirement, deterministic
// collision handling, two-path connection racing, and an annealed probe cache.
// Consumers inject opaque peer keys, metadata, dial functions, and path policy;
// this package does not know about accounts, rooms, rendezvous, Relay
// credentials, or application stream protocols.
package linkmanager
