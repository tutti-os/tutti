const attachmentEnvKey = "TSH_MANAGED_AGENT_MCP_ATTACHMENT_B64";

type PrepareAttachment = {
  servers?: Array<{
    name?: unknown;
    stdio?: {
      command?: unknown;
      args?: unknown;
      env?: unknown;
    };
  }>;
};

export function managedMCPServersFromEnv(
  env: Record<string, string | undefined>
): Record<string, unknown> {
  const encoded = env[attachmentEnvKey]?.trim();
  if (!encoded) return {};
  try {
    const attachment = JSON.parse(
      Buffer.from(encoded, "base64").toString("utf8")
    ) as PrepareAttachment;
    const result: Record<string, unknown> = {};
    for (const server of attachment.servers ?? []) {
      const name = typeof server.name === "string" ? server.name.trim() : "";
      const command =
        typeof server.stdio?.command === "string"
          ? server.stdio.command.trim()
          : "";
      if (!name || !command || Object.hasOwn(result, name)) continue;
      const args = Array.isArray(server.stdio?.args)
        ? server.stdio.args.filter(
            (value): value is string => typeof value === "string"
          )
        : [];
      const variables: Record<string, string> = {};
      if (Array.isArray(server.stdio?.env)) {
        for (const entry of server.stdio.env) {
          if (!entry || typeof entry !== "object") continue;
          const item = entry as { name?: unknown; value?: unknown };
          if (typeof item.name === "string" && typeof item.value === "string") {
            variables[item.name] = item.value;
          }
        }
      }
      result[name] = {
        type: "stdio",
        command,
        ...(args.length > 0 ? { args } : {}),
        ...(Object.keys(variables).length > 0 ? { env: variables } : {})
      };
    }
    return result;
  } catch {
    return {};
  }
}
