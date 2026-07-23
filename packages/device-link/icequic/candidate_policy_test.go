package icequic

import (
	"testing"

	"github.com/pion/ice/v4"
)

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
