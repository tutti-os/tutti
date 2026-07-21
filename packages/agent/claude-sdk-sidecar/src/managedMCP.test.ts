import assert from "node:assert/strict";
import test from "node:test";
import { managedMCPServersFromEnv } from "./managedMCP.ts";

test("managedMCPServersFromEnv projects trusted stdio servers", () => {
  const raw = Buffer.from(
    JSON.stringify({
      servers: [
        {
          name: "tsh_reply_resources",
          stdio: {
            command: "/opt/tsh/product/bin/tsh-bundle-services",
            args: ["reply-resource-mcp"],
            env: [{ name: "TSH_REPLY_RESOURCE_SCOPE_TOKEN", value: "scoped" }]
          }
        }
      ]
    })
  ).toString("base64");
  assert.deepEqual(
    managedMCPServersFromEnv({
      TSH_MANAGED_AGENT_MCP_ATTACHMENT_B64: raw
    }),
    {
      tsh_reply_resources: {
        type: "stdio",
        command: "/opt/tsh/product/bin/tsh-bundle-services",
        args: ["reply-resource-mcp"],
        env: { TSH_REPLY_RESOURCE_SCOPE_TOKEN: "scoped" }
      }
    }
  );
});

test("managedMCPServersFromEnv fails closed for malformed attachments", () => {
  assert.deepEqual(
    managedMCPServersFromEnv({
      TSH_MANAGED_AGENT_MCP_ATTACHMENT_B64: "not-base64-json"
    }),
    {}
  );
});
