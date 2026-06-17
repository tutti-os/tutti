const TUTTI_BROWSER_USE_SUBMIT_PREFIX =
  "Use the injected browser-use skill and only the tutti browser CLI. Do not use any other browser skill, CDP scripts, or direct browser automation.";

export interface TuttiBrowserUseInvocation {
  args: string;
  commandName: string;
}

export function parseTuttiBrowserUseInvocation(
  draft: string
): TuttiBrowserUseInvocation | null {
  const match = /^(\s*)([$/])(browser|浏览器)(?:\s+([\s\S]*))?$/.exec(draft);
  if (!match) {
    return null;
  }
  const commandName = (match[3] ?? "").trim();
  if (!commandName) {
    return null;
  }
  return {
    commandName,
    args: match[4] ?? ""
  };
}

export function buildTuttiBrowserUseSubmitPrompt(args: string): string {
  const trimmedArgs = args.trim();
  if (!trimmedArgs) {
    return TUTTI_BROWSER_USE_SUBMIT_PREFIX;
  }
  return `${TUTTI_BROWSER_USE_SUBMIT_PREFIX}\n\n${trimmedArgs}`;
}
