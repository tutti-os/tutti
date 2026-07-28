package workspace

import (
	"reflect"
	"testing"
)

func TestTuttiManagedExecutionHasNoLegacyCompletionNotifierAuthority(t *testing.T) {
	if _, exists := reflect.TypeOf(IssueManagerService{}).FieldByName("CompletionNotifier"); exists {
		t.Fatal("IssueManagerService.CompletionNotifier keeps legacy in-memory Tutti wake authority wired")
	}
}
