import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeAgentTitleText } from "./agentTitleText";

describe("normalizeAgentTitleText", () => {
  const fixtures = JSON.parse(
    readFileSync(resolve(process.cwd(), "../titletext-fixtures.json"), "utf8")
  ) as Array<{ input: string; name: string; normalized: string }>;

  it.each(fixtures)("normalizes $name", ({ input, normalized }) => {
    expect(normalizeAgentTitleText(input)).toBe(normalized);
  });
});
