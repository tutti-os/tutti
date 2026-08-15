package host

import "strings"

// NormalizeOperationOwnership upgrades legacy operation payloads into the
// canonical ownership model. Operations without a provable owner remain
// recoverable internally but are never public.
func NormalizeOperationOwnership(operation Operation) Operation {
	operation.Scope.AccountID = strings.TrimSpace(operation.Scope.AccountID)
	operation.OwnerAccountID = strings.TrimSpace(operation.OwnerAccountID)
	if operation.OwnerAccountID == "" {
		operation.OwnerAccountID = operation.Scope.AccountID
	}
	if operation.Scope.AccountID == "" && operation.OwnerAccountID != "" {
		operation.Scope.AccountID = operation.OwnerAccountID
	}

	switch {
	case operation.Kind == OperationKindReconcileRuntime:
		operation.Visibility = OperationVisibilitySystemPrivate
	case operation.Visibility == OperationVisibilityAccount && operation.OwnerAccountID != "":
		// Preserve an explicit public account operation.
	case operation.Visibility == OperationVisibilitySystemPrivate:
		// Preserve an explicit private operation.
	case operation.OwnerAccountID != "":
		operation.Visibility = OperationVisibilityAccount
	default:
		operation.Visibility = OperationVisibilitySystemPrivate
	}
	return operation
}

// OperationVisibleToScope is the single public projection rule for durable
// operations. Callers receive not-found rather than an ownership oracle.
func OperationVisibleToScope(operation Operation, scope OperationScope) bool {
	operation = NormalizeOperationOwnership(operation)
	accountID := strings.TrimSpace(scope.AccountID)
	return accountID != "" &&
		operation.Visibility == OperationVisibilityAccount &&
		operation.OwnerAccountID == accountID
}
