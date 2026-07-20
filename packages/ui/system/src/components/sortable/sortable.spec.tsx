import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(import.meta.dirname, "sortable.tsx"), "utf8");

describe("Sortable Tutti adaptations", () => {
  it("keeps the reviewed mouse and touch activation constraints", () => {
    expect(source).toContain("activationConstraint: { distance: 6 }");
    expect(source).toContain(
      "activationConstraint: { delay: 180, tolerance: 5 }"
    );
  });

  it("registers the activator ref only while the handle is enabled", () => {
    expect(source).toMatch(
      /if \(isDisabled\) return;\s*itemContext\.setActivatorNodeRef\(node\)/u
    );
    expect(source).not.toMatch(/if \(!isDisabled\) return/u);
  });

  it("requires caller-owned accessibility copy and respects reduced motion", () => {
    expect(source).toContain('"announcements" | "screenReaderInstructions"');
    expect(source).not.toContain("Grabbed sortable item");
    expect(source).toContain("prefers-reduced-motion: reduce");
  });

  it("does not treat the keyboard sensor's prevented activator event as a canceled move", () => {
    expect(source).not.toContain("activatorEvent.defaultPrevented");
  });

  it("keeps parent disabled authoritative and disables overlay motion when requested", () => {
    expect(source).toContain("Boolean(itemContext.disabled || disabled)");
    expect(source).toContain("callerDropAnimation === undefined");
  });
});
