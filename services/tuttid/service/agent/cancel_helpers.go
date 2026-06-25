package agent

func cancelReasonFromRuntimeResult(result RuntimeCancelResult) CancelReason {
	if result.Canceled {
		return CancelReasonActiveTurnCanceled
	}
	return CancelReasonNoActiveTurn
}
