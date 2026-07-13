import { ipcMain, type IpcMainInvokeEvent } from "electron";
import type {
  DesktopInvokeChannel,
  DesktopInvokePayloadByChannel,
  DesktopInvokeResultByChannel
} from "../../shared/contracts/ipc";
import { toDesktopIpcResult } from "./result";
import { assertDesktopIpcMainFrame } from "./mainFrameAccess.ts";

export function registerDesktopIpcHandler<
  TChannel extends DesktopInvokeChannel
>(
  channel: TChannel,
  handler: (
    event: IpcMainInvokeEvent,
    ...args: DesktopInvokePayloadByChannel[TChannel] extends undefined
      ? []
      : [payload: DesktopInvokePayloadByChannel[TChannel]]
  ) =>
    | Promise<DesktopInvokeResultByChannel[TChannel]>
    | DesktopInvokeResultByChannel[TChannel]
): void {
  ipcMain.handle(channel, (event, ...args) =>
    toDesktopIpcResult(() => {
      assertDesktopIpcMainFrame(event);
      return Promise.resolve(
        handler(
          event,
          ...(args as DesktopInvokePayloadByChannel[TChannel] extends undefined
            ? []
            : [payload: DesktopInvokePayloadByChannel[TChannel]])
        )
      );
    })
  );
}
