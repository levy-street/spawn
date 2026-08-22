export interface DragDecisionInput {
  translation: number;
  velocity: number;
  size: number;
  threshold?: number;
  projectionMs?: number;
}

const DEFAULT_THRESHOLD = 0.35;
const DEFAULT_PROJECTION_MS = 150;

function projectedTranslation(input: DragDecisionInput): number {
  "worklet";
  const projectionMs = input.projectionMs ?? DEFAULT_PROJECTION_MS;
  return input.translation + input.velocity * (projectionMs / 1000);
}

/** Projects the release point forward by velocity and decides whether to commit. */
export function shouldCommitDrag(input: DragDecisionInput): boolean {
  "worklet";
  if (input.size <= 0) {
    return false;
  }

  const projected = projectedTranslation(input);
  if (input.translation !== 0 && projected * input.translation < 0) {
    return false;
  }

  const threshold = input.threshold ?? DEFAULT_THRESHOLD;
  return Math.abs(projected) >= input.size * threshold;
}

/** The resting offset to animate to given a decision. */
export function restingOffset(input: DragDecisionInput, committed: boolean): number {
  "worklet";
  if (!committed || input.size <= 0) {
    return 0;
  }

  const directionSource = input.translation === 0 ? projectedTranslation(input) : input.translation;
  if (directionSource < 0) {
    return -input.size;
  }
  return input.size;
}
