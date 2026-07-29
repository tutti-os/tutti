export class AgentSessionRecordingBinding {
  private readonly pendingByWorkspace = new Map<string, string>();

  arm(workspaceId: string, recordingId: string): void {
    this.pendingByWorkspace.set(workspaceId.trim(), recordingId.trim());
  }

  clear(workspaceId: string, recordingId?: string): void {
    const key = workspaceId.trim();
    if (
      recordingId === undefined ||
      this.pendingByWorkspace.get(key) === recordingId.trim()
    ) {
      this.pendingByWorkspace.delete(key);
    }
  }

  take(workspaceId: string): string | null {
    const key = workspaceId.trim();
    const recordingId = this.pendingByWorkspace.get(key) ?? null;
    this.pendingByWorkspace.delete(key);
    return recordingId;
  }

  restore(workspaceId: string, recordingId: string): void {
    const key = workspaceId.trim();
    if (!this.pendingByWorkspace.has(key)) {
      this.pendingByWorkspace.set(key, recordingId.trim());
    }
  }
}
