import type { AgentGUIAgent } from "@tutti-os/agent-gui";

export class AgentGuiAgentsLoader {
  private cached: Promise<readonly AgentGUIAgent[]> | null = null;
  private readonly loadAgents: () => Promise<readonly AgentGUIAgent[]>;

  constructor(loadAgents: () => Promise<readonly AgentGUIAgent[]>) {
    this.loadAgents = loadAgents;
  }

  load(): Promise<readonly AgentGUIAgent[]> {
    if (!this.cached) {
      let request: Promise<readonly AgentGUIAgent[]>;
      request = this.loadAgents().catch((error: unknown) => {
        if (this.cached === request) {
          this.cached = null;
        }
        throw error;
      });
      this.cached = request;
    }
    return this.cached;
  }

  invalidate(): void {
    this.cached = null;
  }
}
