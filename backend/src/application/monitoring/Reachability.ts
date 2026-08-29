export type Reachability =
  | true
  | false
  | null;

const ONLINE_STATES = new Set([
  "REACHABLE",
  "DELAY",
]);

const OFFLINE_STATES = new Set([
  "FAILED",
  "INCOMPLETE",
]);

export function getNeighborState(
  state: string | undefined,
): Reachability {
  if (!state) {
    return null;
  }

  const normalized =
    state.toUpperCase();

  if (ONLINE_STATES.has(normalized)) {
    return true;
  }

  if (OFFLINE_STATES.has(normalized)) {
    return false;
  }

  return null;
}
