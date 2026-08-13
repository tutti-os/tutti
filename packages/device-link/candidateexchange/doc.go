// Package candidateexchange owns the product-neutral Trickle ICE coordination
// that sits between an authenticated Participant and a consumer's rendezvous
// adapter.
//
// Consumers keep account, room, pairing, authorization, and wire DTOs. This
// package owns candidate-change coalescing, final-snapshot delivery, publish
// retry timing, and the push-with-poll-fallback loop used to feed remote
// candidates into an in-progress authenticated connection. ActionPump exposes
// the same Go-owned workers to callback-free consumers through an action
// protocol with at most one outstanding action per worker.
package candidateexchange
