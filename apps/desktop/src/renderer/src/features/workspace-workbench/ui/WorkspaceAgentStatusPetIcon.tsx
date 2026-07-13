import type { WorkspaceAgentStatusPetMood } from "../services/workspaceAgentStatusPetMood.ts";

const sources = {
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

type Mood = WorkspaceAgentStatusPetMood & keyof typeof sources;

export function WorkspaceAgentStatusPetIcon({ mood }: { mood: Mood }) {
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
        src={sources[mood]}
      />
    </span>
  );
}
