const GOAL_MODE_SLASH_COMMAND = "/goal";

export const AGENT_COMPOSER_PASTED_TEXT_FILE_PREFIX = "pasted-text";
export const AGENT_COMPOSER_PASTED_TEXT_MIME = "text/plain";

export function agentComposerTextByteLength(text: string): number {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(text).byteLength;
  }
  return text.length;
}

export function agentComposerTextToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

export function goalDraftObjectiveFromPrompt(prompt: string): string | null {
  const match = /^\s*\/goal(?:\s+([\s\S]*))?\s*$/u.exec(prompt);
  return match ? (match[1] ?? "") : null;
}

export function buildGoalModePrompt(objective: string): string {
  return objective.trim() === ""
    ? GOAL_MODE_SLASH_COMMAND
    : `${GOAL_MODE_SLASH_COMMAND} ${objective}`;
}
