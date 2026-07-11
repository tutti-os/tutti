package agent

// runtimeLiveModelCatalogSource identifies model options advertised by a live
// provider runtime. It is transport-neutral: Claude Code uses the Agent SDK,
// while other providers may use different runtime protocols.
const runtimeLiveModelCatalogSource = "runtime-live-discovery"
