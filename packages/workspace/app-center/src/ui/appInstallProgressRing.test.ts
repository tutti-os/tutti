import assert from "node:assert/strict";
import test from "node:test";
import { getAppInstallProgressRingPresentation } from "./appInstallProgressRing.ts";

test("determinate install progress exposes its percentage", () => {
  const presentation = getAppInstallProgressRingPresentation({
    fallbackPercent: 12,
    progress: {
      downloadedBytes: null,
      indeterminate: false,
      overallPercent: 42,
      totalBytes: null,
      userPhase: "installing"
    }
  });

  assert.equal(presentation.ariaValueNow, 42);
  assert.equal(presentation.ariaValueText, undefined);
  assert.match(presentation.indicatorStyle.background, /42%/);
  assert.doesNotMatch(presentation.indicatorClassName, /animate-spin/);
});

test("indeterminate install progress spins without announcing a false percentage", () => {
  const presentation = getAppInstallProgressRingPresentation({
    fallbackPercent: 96,
    indeterminateValueText: "Starting…",
    progress: {
      downloadedBytes: null,
      indeterminate: true,
      overallPercent: 0,
      totalBytes: null,
      userPhase: "starting"
    }
  });

  assert.equal(presentation.ariaValueNow, undefined);
  assert.equal(presentation.ariaValueText, "Starting…");
  assert.match(presentation.indicatorClassName, /animate-spin/);
  assert.match(presentation.indicatorClassName, /motion-reduce:animate-none/);
  assert.match(presentation.indicatorStyle.background, /transparent/);
});
