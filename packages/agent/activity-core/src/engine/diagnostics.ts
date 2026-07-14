import type { EngineIntent } from "./types.ts";

// Instance-level diagnostics: the sink is a factory input, never a
// module-level global. Desktop and external hosts each wire their own receiving
// end instead of sharing a process-wide store sink.

export type EngineDiagnosticEvent =
  | {
      type: "commandResultAfterDispose";
      commandId: string;
    }
  | {
      type: "commandResultAfterTimeout";
      commandId: string;
    }
  | {
      type: "intentDroppedAfterDispose";
      intentType: EngineIntent["type"];
    }
  | {
      type: "intentDroppedForIdentityMismatch";
      intentType: EngineIntent["type"];
    }
  | {
      type: "listenerError";
      error: unknown;
    };

export type EngineDiagnosticSink = (event: EngineDiagnosticEvent) => void;
