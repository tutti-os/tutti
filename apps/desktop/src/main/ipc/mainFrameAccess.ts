interface DesktopIpcFrameIdentity {
  processId: number;
  routingId: number;
}

export interface DesktopIpcFrameAccessEvent {
  sender: {
    mainFrame: DesktopIpcFrameIdentity;
  };
  senderFrame: DesktopIpcFrameIdentity | null;
}

export function assertDesktopIpcMainFrame(
  event: DesktopIpcFrameAccessEvent
): void {
  const senderFrame = event.senderFrame;
  const mainFrame = event.sender.mainFrame;
  if (
    !senderFrame ||
    senderFrame.processId !== mainFrame.processId ||
    senderFrame.routingId !== mainFrame.routingId
  ) {
    throw new Error("Desktop IPC is restricted to the main frame");
  }
}
