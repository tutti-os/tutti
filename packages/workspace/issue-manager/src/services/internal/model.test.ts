import assert from "node:assert/strict";
import test from "node:test";
import {
  createIssueManagerDate,
  formatIssueManagerDate,
  formatIssueManagerTimestamp
} from "./model.ts";

test("createIssueManagerDate normalizes unix seconds to milliseconds", () => {
  const date = createIssueManagerDate(1_748_374_400);
  assert.ok(date instanceof Date);
  assert.equal(date?.getTime(), 1_748_374_400_000);
});

test("createIssueManagerDate preserves millisecond timestamps", () => {
  const date = createIssueManagerDate(1_748_374_400_000);
  assert.ok(date instanceof Date);
  assert.equal(date?.getTime(), 1_748_374_400_000);
});

test("formatIssueManagerDate returns an empty string for invalid values", () => {
  assert.equal(formatIssueManagerDate(null), "");
  assert.equal(formatIssueManagerDate(Number.NaN), "");
});

test("formatIssueManagerTimestamp uses the shared English short date-time format", () => {
  const timestamp = new Date(2026, 4, 23, 12, 14).getTime();

  assert.equal(formatIssueManagerTimestamp(timestamp), "May 23, 12:14");
});
