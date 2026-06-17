import { describe, expect, it } from "vitest";
import { chunkBy } from "./chunkBy";

describe("chunkBy", () => {
  const sameParity = (a: number, b: number) => a % 2 === b % 2;

  const cases: {
    name: string;
    items: number[];
    expected: number[][];
  }[] = [
    { name: "empty input yields no runs", items: [], expected: [] },
    { name: "single item is one run", items: [1], expected: [[1]] },
    {
      name: "consecutive matches coalesce",
      items: [1, 3, 5],
      expected: [[1, 3, 5]]
    },
    {
      name: "a mismatch starts a new run",
      items: [1, 2],
      expected: [[1], [2]]
    },
    {
      name: "runs break and resume on parity flips",
      items: [1, 3, 2, 4, 5],
      expected: [[1, 3], [2, 4], [5]]
    },
    {
      name: "alternating values are all singletons",
      items: [1, 2, 3, 4],
      expected: [[1], [2], [3], [4]]
    }
  ];

  for (const { name, items, expected } of cases) {
    it(name, () => {
      expect(chunkBy(items, sameParity)).toEqual(expected);
    });
  }

  it("never drops or duplicates elements (partition property)", () => {
    const items = [4, 4, 7, 9, 2, 2, 2, 5];
    const runs = chunkBy(items, sameParity);
    expect(runs.flat()).toEqual(items);
  });

  it("only ever compares the run's last element with the next item", () => {
    const seen: [number, number][] = [];
    chunkBy([10, 20, 30], (previous, current) => {
      seen.push([previous, current]);
      return true;
    });
    expect(seen).toEqual([
      [10, 20],
      [20, 30]
    ]);
  });
});
