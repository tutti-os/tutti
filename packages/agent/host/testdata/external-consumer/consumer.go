package consumer

import agenthost "github.com/tutti-os/tutti/packages/agent/host"

var (
	_ = agenthost.New
	_ = (*agenthost.Host).CreateSession
	_ = (*agenthost.Host).SendInput
	_ = (*agenthost.Host).GetSession
	_ = (*agenthost.Host).UpdateSettings
	_ = (*agenthost.Host).UpdatePin
	_ = (*agenthost.Host).DeleteSession
	_ = (*agenthost.Host).GetTurn
	_ = (*agenthost.Host).ListSessionTurns
	_ = (*agenthost.Host).FindTurnByClientSubmitID
	_ = (*agenthost.Host).ListSessionMessages
	_ = (*agenthost.Host).GetSessionInteractionSnapshot
	_ = (*agenthost.Host).CancelTurn
	_ = (*agenthost.Host).SubmitInteractive
	_ = (*agenthost.Host).SubmitPlanDecision
	_ = (*agenthost.Host).GoalControl
	_ = (*agenthost.Host).GetGoalState
	_ = (*agenthost.Host).ReconcileGoal
	_ = (*agenthost.Host).Recover
	_ = (*agenthost.Host).Run
)
