import { stdout } from "node:process";
import {
  versionedClaudeSDKSidecarEvent,
  type ClaudeSDKSidecarEvent,
  type ClaudeSDKSidecarEventEmitter
} from "./protocol.ts";

let sidecarEventSink = (event: ClaudeSDKSidecarEvent): void => {
  stdout.write(`${JSON.stringify(event)}\n`);
};

export const emit: ClaudeSDKSidecarEventEmitter = (event): void => {
  sidecarEventSink(versionedClaudeSDKSidecarEvent(event));
};

export function withSidecarEventSinkForTest(
  sink: (event: ClaudeSDKSidecarEvent) => void
): () => void {
  sidecarEventSink = sink;
  return () => {
    sidecarEventSink = (event: ClaudeSDKSidecarEvent): void => {
      stdout.write(`${JSON.stringify(event)}\n`);
    };
  };
}
