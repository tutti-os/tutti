package icequic

import (
	"net/netip"
	"strconv"
	"strings"

	"github.com/pion/ice/v4"
)

const publicHostLocalPreference = 16384

// prioritizeHostCandidate lowers the local preference of global-unicast host
// candidates while keeping private/ULA hosts at Pion's default maximum. The
// candidate type remains host, so a public host is still preferred over srflx
// when it is the only direct path; it simply loses to a usable private host.
// Candidate signaling carries this priority to the peer, which is the only
// safe place available without forking Pion's local candidate gatherer.
func prioritizeHostCandidate(raw string) string {
	candidate, err := ice.UnmarshalCandidate(raw)
	if err != nil || candidate.Type() != ice.CandidateTypeHost {
		return raw
	}
	address, err := netip.ParseAddr(candidate.Address())
	if err != nil || address.IsPrivate() || address.IsLoopback() || !address.IsGlobalUnicast() {
		return raw
	}
	fields := strings.Fields(raw)
	if len(fields) < 6 {
		return raw
	}
	fields[3] = strconv.FormatUint(uint64(candidatePriority(candidate, publicHostLocalPreference)), 10)
	return strings.Join(fields, " ")
}

func candidatePriority(candidate ice.Candidate, localPreference uint16) uint32 {
	componentPreference := uint32(0)
	if candidate.Component() < 256 {
		componentPreference = 256 - uint32(candidate.Component())
	}
	return (1<<24)*uint32(candidate.Type().Preference()) +
		(1<<8)*uint32(localPreference) + componentPreference
}

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
