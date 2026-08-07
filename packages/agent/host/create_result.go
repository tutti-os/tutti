package agenthost

import (
	"errors"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

func createSessionFailureResult(input CreateSessionInput, err error) (CreateSessionResult, error) {
	initialGoalStatus := CreateSessionInitialGoalStatusNotRequested
	if input.InitialGoalControl != nil {
		initialGoalStatus = CreateSessionInitialGoalStatusUnknown
	} else if _, typedGoal := ParseTypedGoalControl(input.InitialContent, false); typedGoal {
		initialGoalStatus = CreateSessionInitialGoalStatusUnknown
	}
	sessionStatus := CreateSessionStatusNotCreated
	if errors.Is(err, ErrSubmitDeliveryUnknown) {
		sessionStatus = CreateSessionStatusUnknown
	}
	return CreateSessionResult{
		SessionStatus:     sessionStatus,
		InitialGoalStatus: initialGoalStatus,
	}, err
}

func createSessionCreatedErrorResult(
	input CreateSessionInput,
	session ProviderRuntimeSession,
	canonical storesqlite.Session,
	err error,
) (CreateSessionResult, error) {
	initialGoalStatus := CreateSessionInitialGoalStatusNotRequested
	if input.InitialGoalControl != nil {
		initialGoalStatus = CreateSessionInitialGoalStatusUnknown
	} else if _, typedGoal := ParseTypedGoalControl(input.InitialContent, false); typedGoal {
		initialGoalStatus = CreateSessionInitialGoalStatusUnknown
	}
	return CreateSessionResult{
		Session:           session,
		Canonical:         canonical,
		SessionStatus:     CreateSessionStatusCreated,
		InitialGoalStatus: initialGoalStatus,
	}, err
}
