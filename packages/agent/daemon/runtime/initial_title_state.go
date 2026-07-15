package agentruntime

import "strings"

const initialTitleEstablishedRuntimeContextKey = "tuttiInitialTitleEstablished"

func initialTitleEstablishedFromRuntimeContext(
	runtimeContext map[string]any,
	title string,
) bool {
	if strings.TrimSpace(title) != "" {
		return true
	}
	if established, ok := runtimeContext[initialTitleEstablishedRuntimeContextKey].(bool); ok {
		return established
	}
	// Sessions created before this marker existed are fail-closed. Their title
	// must not be replaced by a later submit after restart.
	return true
}

func runtimeContextWithInitialTitleEstablished(
	runtimeContext map[string]any,
	established bool,
) map[string]any {
	next := clonePayload(runtimeContext)
	if next == nil {
		next = map[string]any{}
	}
	next[initialTitleEstablishedRuntimeContextKey] = established
	return next
}

func markInitialTitleEstablished(session Session) Session {
	session.InitialTitleEstablished = true
	session.RuntimeContext = runtimeContextWithInitialTitleEstablished(
		session.RuntimeContext,
		true,
	)
	return session
}
