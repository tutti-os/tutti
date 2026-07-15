export interface AgentGuiScheduledTask {
  cancel(): void;
}

export interface AgentGuiScheduler {
  schedule(delayMs: number, task: () => void): AgentGuiScheduledTask;
}

export const agentGuiScheduler: AgentGuiScheduler = {
  schedule(delayMs, task) {
    // timing: centralize cancellable Agent GUI delays behind one scheduler port
    const timer = setTimeout(task, delayMs);
    return {
      cancel() {
        clearTimeout(timer);
      }
    };
  }
};
