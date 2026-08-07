package sessionreplay

import (
	"errors"
	"fmt"
)

var ErrUnsupportedReplaySemanticDomain = errors.New(
	"replay state requires an unsupported semantic domain",
)

type SemanticProfile struct {
	Agent     bool
	TuttiMode bool
	Workflows bool
	Issues    bool
}

func TuttiSemanticProfile() SemanticProfile {
	return SemanticProfile{
		Agent: true, TuttiMode: true, Workflows: true, Issues: true,
	}
}

func AgentSemanticProfile() SemanticProfile {
	return SemanticProfile{Agent: true}
}

type UnsupportedReplaySemanticDomainError struct {
	Domain string
	Path   string
}

func (e *UnsupportedReplaySemanticDomainError) Error() string {
	return fmt.Sprintf(
		"%s: %s at %s",
		ErrUnsupportedReplaySemanticDomain,
		e.Domain,
		e.Path,
	)
}

func (*UnsupportedReplaySemanticDomainError) Unwrap() error {
	return ErrUnsupportedReplaySemanticDomain
}

func ValidateTuttiReplayStateForProfile(
	state TuttiReplayState,
	profile SemanticProfile,
) error {
	if err := validateSemanticProfile(profile); err != nil {
		return err
	}
	if err := ValidateTuttiReplayState(state); err != nil {
		return err
	}
	if !profile.TuttiMode {
		if len(state.TuttiMode.Activations) != 0 {
			return unsupportedReplaySemanticDomain("tuttiMode", "$.tuttiMode.activations")
		}
		for _, snapshot := range state.TuttiMode.TurnSnapshots {
			if !isUnconfiguredTuttiModeTurnSnapshot(snapshot) {
				return unsupportedReplaySemanticDomain("tuttiMode", "$.tuttiMode.turnSnapshots")
			}
		}
	}
	if !profile.Workflows && len(state.Workflows) != 0 {
		return unsupportedReplaySemanticDomain("workflows", "$.workflows")
	}
	if !profile.Issues {
		if len(state.Issues) != 0 {
			return unsupportedReplaySemanticDomain("issues", "$.issues")
		}
		for index, workflow := range state.Workflows {
			if len(workflow.IssueIDs) != 0 {
				return unsupportedReplaySemanticDomain(
					"issues",
					fmt.Sprintf("$.workflows[%d].issueIds", index),
				)
			}
		}
	}
	return nil
}

func MergeTuttiReplayStatesForProfile(
	states []TuttiReplayState,
	profile SemanticProfile,
) (TuttiReplayMergedState, error) {
	if err := validateSemanticProfile(profile); err != nil {
		return TuttiReplayMergedState{}, err
	}
	profileStates := make([]TuttiReplayState, len(states))
	for index, state := range states {
		if err := ValidateTuttiReplayStateForProfile(state, profile); err != nil {
			return TuttiReplayMergedState{}, err
		}
		profileStates[index] = projectTuttiReplayStateForProfile(state, profile)
	}
	return mergeTuttiReplayStatesValidated(profileStates)
}

func CompareTuttiReplayStateForProfile(
	expected TuttiReplayState,
	actual TuttiReplayState,
	profile SemanticProfile,
) error {
	if err := ValidateTuttiReplayStateForProfile(expected, profile); err != nil {
		return fmt.Errorf("invalid expected Tutti Replay State: %w", err)
	}
	if err := ValidateTuttiReplayStateForProfile(actual, profile); err != nil {
		return fmt.Errorf("invalid actual Tutti Replay State: %w", err)
	}
	return compareTuttiReplayStateValidated(
		projectTuttiReplayStateForProfile(expected, profile),
		projectTuttiReplayStateForProfile(actual, profile),
	)
}

func projectTuttiReplayStateForProfile(
	state TuttiReplayState,
	profile SemanticProfile,
) TuttiReplayState {
	if profile.TuttiMode {
		return state
	}
	state.TuttiMode.TurnSnapshots = []TuttiReplayTurnSnapshot{}
	return state
}

// Tutti records one turn snapshot before dispatch even when Tutti Mode is not
// configured for the Session. That row only proves the absence of Tutti Mode;
// it does not require a consumer to own Tutti Mode product state.
func isUnconfiguredTuttiModeTurnSnapshot(
	snapshot TuttiReplayTurnSnapshot,
) bool {
	return snapshot.ActivationID == "" &&
		snapshot.RevisionID == "" &&
		snapshot.Revision == 0 &&
		snapshot.State == "inactive" &&
		snapshot.Source == "" &&
		snapshot.PreferenceVersion == 0 &&
		snapshot.Effect == 0 &&
		snapshot.Speed == 0
}

func validateSemanticProfile(profile SemanticProfile) error {
	if !profile.Agent {
		return errors.New("replay semantic profile must support the Agent domain")
	}
	return nil
}

func unsupportedReplaySemanticDomain(
	domain string,
	path string,
) error {
	return &UnsupportedReplaySemanticDomainError{Domain: domain, Path: path}
}
