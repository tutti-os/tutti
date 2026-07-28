const DOCK_MAGNIFICATION_SPRING_MASS = 0.1;
const DOCK_MAGNIFICATION_SPRING_STIFFNESS = 200;
const DOCK_MAGNIFICATION_SPRING_DAMPING = 14;
const DOCK_MAGNIFICATION_SPRING_SUBSTEPS = 8;
const MAGNIFICATION_SETTLE_EPSILON = 0.2;

export interface DockMagnificationSpring {
  value: number;
  velocity: number;
}

export function advanceDockMagnificationSpring(
  current: DockMagnificationSpring,
  target: number,
  deltaSeconds: number
): DockMagnificationSpring {
  const subDeltaSeconds = deltaSeconds / DOCK_MAGNIFICATION_SPRING_SUBSTEPS;
  let { value, velocity } = current;

  for (let step = 0; step < DOCK_MAGNIFICATION_SPRING_SUBSTEPS; step += 1) {
    const force =
      -DOCK_MAGNIFICATION_SPRING_STIFFNESS * (value - target) -
      DOCK_MAGNIFICATION_SPRING_DAMPING * velocity;
    const acceleration = force / DOCK_MAGNIFICATION_SPRING_MASS;
    velocity += acceleration * subDeltaSeconds;
    value += velocity * subDeltaSeconds;
  }

  return { value, velocity };
}

export function isDockMagnificationSpringSettled(
  spring: DockMagnificationSpring,
  target: number
): boolean {
  return (
    Math.abs(spring.value - target) <= MAGNIFICATION_SETTLE_EPSILON &&
    Math.abs(spring.velocity) <= MAGNIFICATION_SETTLE_EPSILON
  );
}
