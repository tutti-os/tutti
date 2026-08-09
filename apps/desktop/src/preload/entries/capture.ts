import { contextBridge } from "electron";
import { desktopIpcChannels } from "../../shared/contracts/ipc.ts";
import type { DesktopCaptureApi } from "../../shared/contracts/capture.ts";
import { invokeDesktopApi } from "../api/invoke.ts";

const captureApi: DesktopCaptureApi = {
  cancel: () => invokeDesktopApi(desktopIpcChannels.capture.cancel),
  getComposerOptions: (input) =>
    invokeDesktopApi(desktopIpcChannels.capture.getComposerOptions, input),
  getState: () => invokeDesktopApi(desktopIpcChannels.capture.getState),
  queryMentionDirectory: (input) =>
    invokeDesktopApi(desktopIpcChannels.capture.queryMentionDirectory, input),
  queryMentions: (input) =>
    invokeDesktopApi(desktopIpcChannels.capture.queryMentions, input),
  rememberComposerDefaults: (input) =>
    invokeDesktopApi(
      desktopIpcChannels.capture.rememberComposerDefaults,
      input
    ),
  resolveMention: (input) =>
    invokeDesktopApi(desktopIpcChannels.capture.resolveMention, input),
  select: (input) => invokeDesktopApi(desktopIpcChannels.capture.select, input),
  selectFiles: () => invokeDesktopApi(desktopIpcChannels.capture.selectFiles),
  selectProjectDirectory: () =>
    invokeDesktopApi(desktopIpcChannels.capture.selectProjectDirectory),
  submit: (input) => invokeDesktopApi(desktopIpcChannels.capture.submit, input),
  userProjects: {
    list: () => invokeDesktopApi(desktopIpcChannels.capture.userProjectsList),
    prepareSelection: (input) =>
      invokeDesktopApi(
        desktopIpcChannels.capture.userProjectsPrepareSelection,
        input
      ),
    use: (input) =>
      invokeDesktopApi(desktopIpcChannels.capture.userProjectsUse, input)
  }
};

contextBridge.exposeInMainWorld("tuttiCapture", captureApi);
