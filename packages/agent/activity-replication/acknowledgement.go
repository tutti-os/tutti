package activityreplication

import (
	"errors"
	"fmt"
)

type AcknowledgementDisposition string

const (
	AcknowledgementApplied   AcknowledgementDisposition = "applied"
	AcknowledgementDuplicate AcknowledgementDisposition = "duplicate"
	AcknowledgementStale     AcknowledgementDisposition = "stale"
)

// MutationAcknowledgement is a sink-side decision used by the shared
// conformance suite. Duplicate and stale are accepted outcomes, not errors.
type MutationAcknowledgement struct {
	MutationID    string                     `json:"mutationId"`
	TransactionID string                     `json:"transactionId"`
	Disposition   AcknowledgementDisposition `json:"disposition"`
	Cursor        uint64                     `json:"cursor"`
}

func AcknowledgeApplied(mutation Mutation, cursor uint64) MutationAcknowledgement {
	return newAcknowledgement(mutation, AcknowledgementApplied, cursor)
}

// AcknowledgeDuplicate preserves the cursor assigned by the original commit.
func AcknowledgeDuplicate(mutation Mutation, originalCursor uint64) MutationAcknowledgement {
	return newAcknowledgement(mutation, AcknowledgementDuplicate, originalCursor)
}

// AcknowledgeStale accepts an obsolete snapshot without writing or assigning a
// cursor, allowing an ordered worker to continue with later mutations.
func AcknowledgeStale(mutation Mutation) MutationAcknowledgement {
	return newAcknowledgement(mutation, AcknowledgementStale, 0)
}

func newAcknowledgement(mutation Mutation, disposition AcknowledgementDisposition, cursor uint64) MutationAcknowledgement {
	return MutationAcknowledgement{
		MutationID:    mutation.MutationID,
		TransactionID: mutation.TransactionID,
		Disposition:   disposition,
		Cursor:        cursor,
	}
}

// SummarizeAcknowledgements produces the wire response for an accepted batch.
func SummarizeAcknowledgements(acknowledgements []MutationAcknowledgement) (ApplyResult, error) {
	result := ApplyResult{}
	for _, acknowledgement := range acknowledgements {
		switch acknowledgement.Disposition {
		case AcknowledgementApplied, AcknowledgementDuplicate, AcknowledgementStale:
		default:
			return ApplyResult{}, fmt.Errorf("unknown activity replication acknowledgement disposition %q", acknowledgement.Disposition)
		}
		result.AcceptedCount++
		if acknowledgement.Cursor > result.Cursor {
			result.Cursor = acknowledgement.Cursor
		}
	}
	return result, nil
}

type RejectionKind string

const (
	RejectionSchema     RejectionKind = "schema"
	RejectionIdentity   RejectionKind = "identity"
	RejectionPermission RejectionKind = "permission"
)

// PermanentRejection identifies a mutation that must be removed or repaired;
// retrying it unchanged cannot succeed.
type PermanentRejection struct {
	Kind          RejectionKind `json:"kind"`
	MutationID    string        `json:"mutationId"`
	TransactionID string        `json:"transactionId"`
	Err           error         `json:"-"`
}

func (e *PermanentRejection) Error() string {
	return fmt.Sprintf("activity replication %s rejection for mutation %q in transaction %q: %v", e.Kind, e.MutationID, e.TransactionID, e.Err)
}

func (e *PermanentRejection) Unwrap() error {
	return e.Err
}

func NewPermanentRejection(kind RejectionKind, mutation Mutation, err error) error {
	if err == nil {
		err = errors.New("activity replication mutation was rejected")
	}
	return &PermanentRejection{
		Kind:          kind,
		MutationID:    mutation.MutationID,
		TransactionID: mutation.TransactionID,
		Err:           err,
	}
}
