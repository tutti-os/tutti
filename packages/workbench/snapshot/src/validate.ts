import { workbenchSnapshotLimits } from "./limits.ts";
import {
  workbenchSnapshotSchemaVersion,
  type WorkbenchFrameV1,
  type WorkbenchSnapshotDisplayModeV1,
  type WorkbenchSnapshotV1
} from "./types.ts";

export interface WorkbenchSnapshotValidationIssue {
  path: string;
  message: string;
}

export interface WorkbenchSnapshotValidationResult {
  ok: boolean;
  issues: WorkbenchSnapshotValidationIssue[];
}

const displayModes = new Set<WorkbenchSnapshotDisplayModeV1>([
  "floating",
  "fullscreen"
]);

export function validateWorkbenchSnapshot(
  value: unknown
): WorkbenchSnapshotValidationResult {
  const issues: WorkbenchSnapshotValidationIssue[] = [];

  if (!isRecord(value)) {
    return issue("snapshot", "snapshot must be an object");
  }
  validateAllowedKeys(
    value,
    "snapshot",
    [
      "schemaVersion",
      "nodes",
      "nodeStack",
      "activeNodeId",
      "spaces",
      "activeSpaceId",
      "layoutBasis",
      "metadata"
    ],
    issues
  );

  if (value.schemaVersion !== workbenchSnapshotSchemaVersion) {
    issues.push({
      path: "schemaVersion",
      message: "unsupported workbench snapshot schema version"
    });
  }

  if (!Array.isArray(value.nodes)) {
    issues.push({ path: "nodes", message: "nodes must be an array" });
  } else {
    if (value.nodes.length > workbenchSnapshotLimits.maxNodes) {
      issues.push({
        path: "nodes",
        message: `nodes must contain at most ${workbenchSnapshotLimits.maxNodes} items`
      });
    }
    validateNodes(value.nodes, issues);
  }

  validateStringArray(value.nodeStack, "nodeStack", issues, true);
  validateOptionalStringOrNull(value.activeNodeId, "activeNodeId", issues);

  if (value.spaces !== undefined) {
    if (!Array.isArray(value.spaces)) {
      issues.push({ path: "spaces", message: "spaces must be an array" });
    } else {
      validateSpaces(value.spaces, issues);
    }
  }

  validateOptionalStringOrNull(value.activeSpaceId, "activeSpaceId", issues);

  if (value.layoutBasis !== undefined) {
    validateLayoutBasis(value.layoutBasis, "layoutBasis", issues);
  }

  const serializedBytes = serializedByteLength(value);
  if (serializedBytes > workbenchSnapshotLimits.maxSerializedBytes) {
    issues.push({
      path: "snapshot",
      message: `snapshot must serialize to at most ${workbenchSnapshotLimits.maxSerializedBytes} bytes`
    });
  }

  return { ok: issues.length === 0, issues };
}

export function assertValidWorkbenchSnapshot(
  value: unknown
): asserts value is WorkbenchSnapshotV1 {
  const result = validateWorkbenchSnapshot(value);
  if (!result.ok) {
    throw new Error(formatWorkbenchSnapshotValidationIssues(result.issues));
  }
}

export function formatWorkbenchSnapshotValidationIssues(
  issues: WorkbenchSnapshotValidationIssue[]
): string {
  if (issues.length === 0) {
    return "workbench snapshot is valid";
  }

  return issues.map((item) => `${item.path}: ${item.message}`).join("; ");
}

function validateNodes(
  nodes: unknown[],
  issues: WorkbenchSnapshotValidationIssue[]
): void {
  const ids = new Set<string>();

  nodes.forEach((node, index) => {
    const path = `nodes[${index}]`;
    if (!isRecord(node)) {
      issues.push({ path, message: "node must be an object" });
      return;
    }
    validateAllowedKeys(
      node,
      path,
      [
        "id",
        "kind",
        "title",
        "frame",
        "displayMode",
        "restoreFrame",
        "isMinimized",
        "minimizedAtUnixMs",
        "data",
        "adapterState"
      ],
      issues
    );

    const id = validateRequiredString(node.id, `${path}.id`, issues, {
      maxLength: workbenchSnapshotLimits.maxNodeIDLength
    });
    if (id) {
      if (ids.has(id)) {
        issues.push({ path: `${path}.id`, message: "node id must be unique" });
      }
      ids.add(id);
    }

    validateRequiredString(node.kind, `${path}.kind`, issues, {
      maxLength: workbenchSnapshotLimits.maxKindLength
    });
    validateRequiredString(node.title, `${path}.title`, issues, {
      allowEmpty: true,
      maxLength: workbenchSnapshotLimits.maxTitleLength
    });
    validateFrame(node.frame, `${path}.frame`, issues);

    if (
      node.displayMode !== undefined &&
      !displayModes.has(node.displayMode as WorkbenchSnapshotDisplayModeV1)
    ) {
      issues.push({
        path: `${path}.displayMode`,
        message: "displayMode must be floating or fullscreen"
      });
    }

    if (node.restoreFrame !== undefined && node.restoreFrame !== null) {
      validateFrame(node.restoreFrame, `${path}.restoreFrame`, issues);
    }

    if (
      node.isMinimized !== undefined &&
      typeof node.isMinimized !== "boolean"
    ) {
      issues.push({
        path: `${path}.isMinimized`,
        message: "isMinimized must be a boolean"
      });
    }

    validateOptionalNonNegativeIntegerOrNull(
      node.minimizedAtUnixMs,
      `${path}.minimizedAtUnixMs`,
      issues
    );
  });
}

function validateSpaces(
  spaces: unknown[],
  issues: WorkbenchSnapshotValidationIssue[]
): void {
  spaces.forEach((space, index) => {
    const path = `spaces[${index}]`;
    if (!isRecord(space)) {
      issues.push({ path, message: "space must be an object" });
      return;
    }
    validateAllowedKeys(
      space,
      path,
      ["id", "name", "nodeIds", "frame", "data"],
      issues
    );

    validateRequiredString(space.id, `${path}.id`, issues);
    validateRequiredString(space.name, `${path}.name`, issues, {
      allowEmpty: true
    });
    validateStringArray(space.nodeIds, `${path}.nodeIds`, issues, false);

    if (space.frame !== undefined && space.frame !== null) {
      validateFrame(space.frame, `${path}.frame`, issues);
    }
  });
}

function validateRequiredString(
  value: unknown,
  path: string,
  issues: WorkbenchSnapshotValidationIssue[],
  options: { allowEmpty?: boolean; maxLength?: number } = {}
): string | null {
  if (typeof value !== "string") {
    issues.push({ path, message: "value must be a string" });
    return null;
  }

  const trimmed = value.trim();
  if (!options.allowEmpty && trimmed === "") {
    issues.push({ path, message: "value must not be empty" });
    return null;
  }

  if (options.maxLength !== undefined && value.length > options.maxLength) {
    issues.push({
      path,
      message: `value must be at most ${options.maxLength} characters`
    });
  }

  return trimmed;
}

function validateStringArray(
  value: unknown,
  path: string,
  issues: WorkbenchSnapshotValidationIssue[],
  optional: boolean
): void {
  if (value === undefined && optional) {
    return;
  }
  if (!Array.isArray(value)) {
    issues.push({ path, message: "value must be an array" });
    return;
  }

  value.forEach((item, index) => {
    if (typeof item !== "string" || item.trim() === "") {
      issues.push({
        path: `${path}[${index}]`,
        message: "value must be a non-empty string"
      });
    }
  });
}

function validateOptionalStringOrNull(
  value: unknown,
  path: string,
  issues: WorkbenchSnapshotValidationIssue[]
): void {
  if (value === undefined || value === null || typeof value === "string") {
    return;
  }
  issues.push({ path, message: "value must be a string or null" });
}

function validateOptionalNonNegativeIntegerOrNull(
  value: unknown,
  path: string,
  issues: WorkbenchSnapshotValidationIssue[]
): void {
  if (value === undefined || value === null) {
    return;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    issues.push({
      path,
      message: "value must be a non-negative integer or null"
    });
  }
}

function validateFrame(
  value: unknown,
  path: string,
  issues: WorkbenchSnapshotValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "frame must be an object" });
    return;
  }
  validateAllowedKeys(value, path, ["x", "y", "width", "height"], issues);

  validateFiniteNumber(value.x, `${path}.x`, issues);
  validateFiniteNumber(value.y, `${path}.y`, issues);
  validateFiniteNumber(value.width, `${path}.width`, issues);
  validateFiniteNumber(value.height, `${path}.height`, issues);

  const frame = value as Partial<WorkbenchFrameV1>;
  if (
    typeof frame.width === "number" &&
    frame.width < workbenchSnapshotLimits.minFrameWidth
  ) {
    issues.push({
      path: `${path}.width`,
      message: `width must be at least ${workbenchSnapshotLimits.minFrameWidth}`
    });
  }
  if (
    typeof frame.height === "number" &&
    frame.height < workbenchSnapshotLimits.minFrameHeight
  ) {
    issues.push({
      path: `${path}.height`,
      message: `height must be at least ${workbenchSnapshotLimits.minFrameHeight}`
    });
  }
}

function validateLayoutBasis(
  value: unknown,
  path: string,
  issues: WorkbenchSnapshotValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "layout basis must be an object" });
    return;
  }
  validateAllowedKeys(
    value,
    path,
    ["surfaceSize", "layoutConstraints"],
    issues
  );
  validateSize(value.surfaceSize, `${path}.surfaceSize`, issues);
  validateLayoutConstraints(
    value.layoutConstraints,
    `${path}.layoutConstraints`,
    issues
  );
}

function validateSize(
  value: unknown,
  path: string,
  issues: WorkbenchSnapshotValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "size must be an object" });
    return;
  }
  validateAllowedKeys(value, path, ["width", "height"], issues);
  validatePositiveFiniteNumber(value.width, `${path}.width`, issues);
  validatePositiveFiniteNumber(value.height, `${path}.height`, issues);
}

function validateLayoutConstraints(
  value: unknown,
  path: string,
  issues: WorkbenchSnapshotValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "layout constraints must be an object" });
    return;
  }
  validateAllowedKeys(
    value,
    path,
    ["minWidth", "minHeight", "surfacePadding", "safeArea"],
    issues
  );
  validateNonNegativeFiniteNumber(value.minWidth, `${path}.minWidth`, issues);
  validateNonNegativeFiniteNumber(value.minHeight, `${path}.minHeight`, issues);
  validateNonNegativeFiniteNumber(
    value.surfacePadding,
    `${path}.surfacePadding`,
    issues
  );

  const safeAreaPath = `${path}.safeArea`;
  if (!isRecord(value.safeArea)) {
    issues.push({
      path: safeAreaPath,
      message: "safe area must be an object"
    });
    return;
  }
  validateAllowedKeys(
    value.safeArea,
    safeAreaPath,
    ["top", "right", "bottom", "left"],
    issues
  );
  for (const edge of ["top", "right", "bottom", "left"] as const) {
    validateNonNegativeFiniteNumber(
      value.safeArea[edge],
      `${safeAreaPath}.${edge}`,
      issues
    );
  }
}

function validatePositiveFiniteNumber(
  value: unknown,
  path: string,
  issues: WorkbenchSnapshotValidationIssue[]
): void {
  validateFiniteNumber(value, path, issues);
  if (typeof value === "number" && Number.isFinite(value) && value <= 0) {
    issues.push({ path, message: "value must be greater than zero" });
  }
}

function validateNonNegativeFiniteNumber(
  value: unknown,
  path: string,
  issues: WorkbenchSnapshotValidationIssue[]
): void {
  validateFiniteNumber(value, path, issues);
  if (typeof value === "number" && Number.isFinite(value) && value < 0) {
    issues.push({ path, message: "value must be non-negative" });
  }
}

function validateFiniteNumber(
  value: unknown,
  path: string,
  issues: WorkbenchSnapshotValidationIssue[]
): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    issues.push({ path, message: "value must be a finite number" });
  }
}

function validateAllowedKeys(
  value: Record<string, unknown>,
  path: string,
  allowedKeys: string[],
  issues: WorkbenchSnapshotValidationIssue[]
): void {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      issues.push({
        path: `${path}.${key}`,
        message: "field is not part of the workbench snapshot contract"
      });
    }
  }
}

function serializedByteLength(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function issue(
  path: string,
  message: string
): WorkbenchSnapshotValidationResult {
  return { ok: false, issues: [{ path, message }] };
}
