export type MonacoModule = typeof import("monaco-editor");

export function loadMonaco(): Promise<MonacoModule> {
  return import("monaco-editor");
}
