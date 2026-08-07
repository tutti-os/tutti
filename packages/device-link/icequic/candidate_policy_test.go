package icequic

import (
	"testing"

	"github.com/pion/ice/v4"
)

func TestPrioritizeHostCandidatePrefersPrivateAddresses(t *testing.T) {
	privateRaw := "1 1 udp 2130706431 192.168.1.83 41000 typ host"
	publicRaw := "2 1 udp 2130706431 2001:4860:4860::8888 41000 typ host"

	private, err := ice.UnmarshalCandidate(prioritizeHostCandidate(privateRaw))
	if err != nil {
		t.Fatalf("unmarshal private candidate: %v", err)
	}
	public, err := ice.UnmarshalCandidate(prioritizeHostCandidate(publicRaw))
	if err != nil {
		t.Fatalf("unmarshal public candidate: %v", err)
	}
	if private.Priority() <= public.Priority() {
		t.Fatalf("private host priority = %d, public host priority = %d; want private first", private.Priority(), public.Priority())
	}
	if got, want := public.Priority(), candidatePriority(public, publicHostLocalPreference); got != want {
		t.Fatalf("public host priority = %d, want %d", got, want)
	}
}

func TestPrioritizeHostCandidateLeavesSrflxUnchanged(t *testing.T) {
	const raw = "3 1 udp 16777215 203.0.113.1 41000 typ srflx raddr 192.168.1.83 rport 41000"
	got := prioritizeHostCandidate(raw)
	if got != raw {
		t.Fatalf("srflx candidate changed from %q to %q", raw, got)
	}
}

func TestICECandidateTypesExcludesHostButKeepsSrflx(t *testing.T) {
	types := ICECandidateTypes(true)
	if len(types) != 1 || types[0] != ice.CandidateTypeServerReflexive {
		t.Fatalf("excluded host policy must gather srflx only, got %v", types)
	}
	for _, candidateType := range types {
		if candidateType == ice.CandidateTypeHost {
			t.Fatalf("host candidates must not be gathered when excluded: %v", types)
		}
	}
}

func TestICECandidateTypesDefaultGathersHostAndSrflx(t *testing.T) {
	types := ICECandidateTypes(false)
	var host, srflx bool
	for _, candidateType := range types {
		switch candidateType {
		case ice.CandidateTypeHost:
			host = true
		case ice.CandidateTypeServerReflexive:
			srflx = true
		}
	}
	if !host || !srflx {
		t.Fatalf("default policy must gather host and srflx, got %v", types)
	}
}
