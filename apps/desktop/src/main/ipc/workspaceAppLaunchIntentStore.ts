import type { TuttiExternalWorkspaceOpenRouteIntent } from "@tutti-os/workspace-external-core/contracts";

export interface WorkspaceAppLaunchIntentIdentity {
  appID: string;
  ownerWebContentsId: number;
  workspaceID: string;
}

export class WorkspaceAppLaunchIntentStore {
  readonly #intents = new Map<string, TuttiExternalWorkspaceOpenRouteIntent>();

  forgetOwner(ownerWebContentsId: number): void {
    const prefix = `${ownerWebContentsId}:`;
    for (const key of this.#intents.keys()) {
      if (key.startsWith(prefix)) {
        this.#intents.delete(key);
      }
    }
  }

  set(
    identity: WorkspaceAppLaunchIntentIdentity,
    intent: TuttiExternalWorkspaceOpenRouteIntent
  ): void {
    this.#intents.set(workspaceAppLaunchIntentKey(identity), intent);
  }

  take(
    identity: WorkspaceAppLaunchIntentIdentity
  ): TuttiExternalWorkspaceOpenRouteIntent | null {
    const key = workspaceAppLaunchIntentKey(identity);
    const intent = this.#intents.get(key) ?? null;
    this.#intents.delete(key);
    return intent;
  }
}

function workspaceAppLaunchIntentKey(
  input: WorkspaceAppLaunchIntentIdentity
): string {
  return [
    String(input.ownerWebContentsId),
    encodeURIComponent(input.workspaceID),
    encodeURIComponent(input.appID)
  ].join(":");
}
