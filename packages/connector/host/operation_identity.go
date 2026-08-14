package host

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
)

func OperationRequestDigest(kind OperationKind, scope OperationScope, connectorKey string, target *OperationTarget) string {
	// External VM/runtime fence facts are resolved by the Host and are not part
	// of the caller's idempotency identity. They remain frozen on Operation.Scope.
	requestScope := OperationScope{AccountID: scope.AccountID, DeviceID: scope.DeviceID}
	payload, _ := json.Marshal(struct {
		Kind         OperationKind    `json:"kind"`
		Scope        OperationScope   `json:"scope"`
		ConnectorKey string           `json:"connectorKey"`
		Target       *OperationTarget `json:"target,omitempty"`
	}{Kind: kind, Scope: requestScope, ConnectorKey: connectorKey, Target: target})
	sum := sha256.Sum256(payload)
	return "sha256:" + hex.EncodeToString(sum[:])
}
