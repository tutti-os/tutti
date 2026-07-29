package liveprotocol

import "testing"

func TestSubscriberAcceptsTypedRejectionAcrossProtocolRevisionMismatch(t *testing.T) {
	t.Parallel()

	frame := Frame{
		ProtocolRevision: "sha256:older",
		StreamID:         "stream-1",
		BindingID:        "binding-1",
		Epoch:            1,
		Deliveries: []Delivery{{
			Seq:  1,
			Kind: DeliveryKindRejected,
			Rejected: &Rejected{
				Reason:           RejectionProtocolRevisionMismatch,
				ExpectedRevision: ProtocolRevision,
				ReceivedRevision: "sha256:older",
			},
		}},
	}
	encoded, err := EncodeFrame(frame)
	if err != nil {
		t.Fatal(err)
	}
	subscriber, err := NewSubscriber(SubscriberConfig{})
	if err != nil {
		t.Fatal(err)
	}
	result, err := DecodeAndApply(subscriber, encoded)
	if err != nil {
		t.Fatal(err)
	}
	if result.ReconcileRequired || len(result.Accepted) != 1 ||
		result.Accepted[0].Kind != DeliveryKindRejected {
		t.Fatalf("typed revision rejection was not accepted: %#v", result)
	}
}
