import type { WorkspaceAgentStatusPetMood } from "../services/workspaceAgentStatusPetMood";

const AGENT_STATUS_PET_SOURCES = {
  failed: new URL(
    "../../../assets/agent-status-pet/failed.gif",
    import.meta.url
  ).href,
  idle: new URL("../../../assets/agent-status-pet/idle.gif", import.meta.url)
    .href,
  review: new URL(
    "../../../assets/agent-status-pet/review.gif",
    import.meta.url
  ).href,
  running: new URL(
    "../../../assets/agent-status-pet/running.gif",
    import.meta.url
  ).href,
  waiting: new URL(
    "../../../assets/agent-status-pet/waiting.gif",
    import.meta.url
  ).href,
  waving: new URL(
    "../../../assets/agent-status-pet/waving.gif",
    import.meta.url
  ).href
} as const;

type AgentStatusPetMood = WorkspaceAgentStatusPetMood &
  keyof typeof AGENT_STATUS_PET_SOURCES;

export function AgentStatusPetIcon({ mood }: { mood: AgentStatusPetMood }) {
  return (
    <span
      aria-hidden="true"
      className="relative -my-1 grid size-7 shrink-0 place-items-center overflow-visible"
      data-agent-status-pet-mood={mood}
    >
      <img
        alt=""
        className="size-7 object-contain"
        draggable={false}
        src={AGENT_STATUS_PET_SOURCES[mood]}
      />
    </span>
  );
}
