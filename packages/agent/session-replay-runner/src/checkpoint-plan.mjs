import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * @param {object} plan
 * @param {Array<{ sequence?: number }>} activityEvents
 * @param {{ cassetteSchemaVersion: number }} options
 */
export function validateReplayCheckpointPlan(plan, activityEvents, options) {
  const cassetteSchemaVersion = options?.cassetteSchemaVersion;
  if (!Number.isSafeInteger(cassetteSchemaVersion)) {
    throw new Error(
      "checkpoint_plan_invalid: cassetteSchemaVersion option is required"
    );
  }
  if (
    plan?.schemaVersion !== 2 ||
    plan.cassetteSchemaVersion !== cassetteSchemaVersion ||
    plan.observationSchemaVersion !== 2 ||
    !Array.isArray(plan.checkpoints) ||
    plan.checkpoints.length === 0
  ) {
    throw new Error("checkpoint_plan_invalid: unsupported plan schema");
  }
  let previousActivitySequence = 0;
  const ids = new Set();
  for (const [index, checkpoint] of plan.checkpoints.entries()) {
    if (
      checkpoint?.index !== index ||
      checkpoint.id !== `checkpoint-${String(index).padStart(4, "0")}` ||
      ids.has(checkpoint.id) ||
      typeof checkpoint.kind !== "string" ||
      !Array.isArray(checkpoint.tags) ||
      !checkpoint.tags.includes(checkpoint.kind) ||
      !Number.isSafeInteger(checkpoint.cursor?.activityEventSequence) ||
      checkpoint.cursor.activityEventSequence < previousActivitySequence ||
      !Array.isArray(checkpoint.cursor.providerConnections) ||
      !["bootstrap", "activity-boundary", "provider-observation"].includes(
        checkpoint.trigger?.source
      )
    ) {
      throw new Error(`checkpoint_plan_invalid: checkpoint ${index}`);
    }
    if (
      checkpoint.trigger.source === "activity-boundary" &&
      checkpoint.trigger.afterActivityEventSequence !==
        checkpoint.cursor.activityEventSequence
    ) {
      throw new Error(
        `checkpoint_plan_invalid: activity boundary ${checkpoint.id}`
      );
    }
    if (
      checkpoint.cursor.activityEventSequence >
      (activityEvents.at(-1)?.sequence ?? 0)
    ) {
      throw new Error(
        `checkpoint_plan_invalid: activity cursor ${checkpoint.id}`
      );
    }
    ids.add(checkpoint.id);
    previousActivitySequence = checkpoint.cursor.activityEventSequence;
  }
  if (plan.checkpoints[0].trigger.source !== "bootstrap") {
    throw new Error("checkpoint_plan_invalid: checkpoint zero");
  }
  return plan.checkpoints;
}

/**
 * @param {string} cassetteDirectory
 * @param {Array<{ sequence?: number }>} activityEvents
 * @param {{
 *   cassetteSchemaVersion: number,
 *   checkpointPlanPath?: string
 * }} options
 */
export async function loadReplayCheckpointPlan(
  cassetteDirectory,
  activityEvents,
  options
) {
  const checkpointPlanPath =
    options?.checkpointPlanPath?.trim() || "checkpoint-plan.json";
  const plan = JSON.parse(
    await readFile(join(cassetteDirectory, checkpointPlanPath), "utf8")
  );
  return validateReplayCheckpointPlan(plan, activityEvents, options);
}
