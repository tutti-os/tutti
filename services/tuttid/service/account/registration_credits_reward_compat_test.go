package account

import (
	"encoding/json"
	"testing"

	"github.com/tutti-os/tutti/packages/commerce"
)

func TestRegistrationCreditsRewardStateReadsLegacyPendingReceipt(t *testing.T) {
	var state commerce.RewardReceiptState
	err := json.Unmarshal([]byte(`{
		"pending": {
			"ID": "registrationCreditsToastShown:user-1:grant-1",
			"UserID": "user-1",
			"GrantNo": "grant-1",
			"Credits": 500,
			"CreatedAt": "2026-07-22T00:00:00Z"
		},
		"attempted": {"user-1": 1784678400000}
	}`), &state)
	if err != nil {
		t.Fatal(err)
	}
	if state.Pending == nil ||
		state.Pending.UserID != "user-1" ||
		state.Pending.GrantNo != "grant-1" ||
		state.Pending.Credits != 500 {
		t.Fatalf("legacy pending receipt = %#v", state.Pending)
	}
}
