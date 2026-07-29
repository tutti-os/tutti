import assert from "node:assert/strict";
import test from "node:test";
import type { ILink, Terminal } from "@xterm/xterm";
import type { TerminalNodeFeature } from "../core/feature.ts";
import { createTerminalFileLinkProvider } from "./terminalFileLinkProvider.ts";

test("terminal file link provider resolves cwd from the latest getter value", async () => {
  let currentCwd = "/workspace/first";
  const openCalls: Array<Record<string, unknown>> = [];
  const provider = createTerminalFileLinkProvider({
    feature: {
      linkHandler: {
        open(target) {
          openCalls.push(target as Record<string, unknown>);
          return Promise.resolve();
        }
      }
    } as TerminalNodeFeature,
    getCwd: () => currentCwd,
    terminal: {
      buffer: {
        active: {
          getLine() {
            return {
              translateToString() {
                return "./src/app.ts:12:4";
              }
            };
          }
        }
      }
    } as unknown as Terminal
  });

  const links = await new Promise<ILink[] | undefined>((resolve) => {
    provider.provideLinks(1, resolve);
  });

  assert.ok(links);
  assert.equal(links.length, 1);

  links[0]?.activate({} as MouseEvent, links[0]?.text ?? "");
  currentCwd = "/workspace/second";
  links[0]?.activate({} as MouseEvent, links[0]?.text ?? "");

  assert.deepEqual(
    openCalls.map((call) => ({
      column: call.column,
      cwd: call.cwd,
      line: call.line,
      path: call.path
    })),
    [
      {
        column: 4,
        cwd: "/workspace/first",
        line: 12,
        path: "./src/app.ts"
      },
      {
        column: 4,
        cwd: "/workspace/second",
        line: 12,
        path: "./src/app.ts"
      }
    ]
  );
});
