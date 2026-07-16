export interface AgentGeneratedImageRowVM {
  kind: "generated-image";
  id: string;
  turnId: string;
  sourceCallId: string;
  uri: string;
  mimeType: string | null;
  prompt: string | null;
  occurredAtUnixMs: number | null;
}
