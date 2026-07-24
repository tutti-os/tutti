package icequic

import "github.com/pion/ice/v4"

// ICECandidateTypes returns the pion candidate types the device-link ICE agent
// should gather for the shared host-candidate policy.
//
// When excludeHostCandidates is true, directly-bound host candidates (LAN
// IPv4, ULA IPv6, and global-IPv6 host) are dropped and only server-reflexive
// (srflx) candidates are gathered, so the agent still reflects off the STUN
// endpoint to hole punch — reliance shifts onto srflx/relay rather than the
// LAN. When false, both host and srflx candidates are gathered.
func ICECandidateTypes(excludeHostCandidates bool) []ice.CandidateType {
	if excludeHostCandidates {
		return []ice.CandidateType{ice.CandidateTypeServerReflexive}
	}
	return []ice.CandidateType{ice.CandidateTypeHost, ice.CandidateTypeServerReflexive}
}
