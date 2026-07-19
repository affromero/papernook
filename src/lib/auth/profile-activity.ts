/**
 * Coordinates long-running, per-profile writes with complete profile erasure.
 * Erasure marks every lease cancelled synchronously, then waits until each
 * writer has observed cancellation and removed any provisional artifacts.
 */

export interface ProfileActivity {
  readonly username: string;
  cancelled(): boolean;
  finish(): void;
}

interface ActivityState {
  cancelled: boolean;
  done: Promise<void>;
  resolveDone: () => void;
}

const active = new Map<string, Set<ActivityState>>();
const erasing = new Set<string>();

export function beginProfileActivity(username: string): ProfileActivity | null {
  if (erasing.has(username)) return null;
  let resolveDone = () => {};
  const state: ActivityState = {
    cancelled: false,
    done: new Promise<void>((resolve) => {
      resolveDone = resolve;
    }),
    resolveDone: () => resolveDone(),
  };
  const activities = active.get(username) ?? new Set<ActivityState>();
  activities.add(state);
  active.set(username, activities);
  let finished = false;
  return {
    username,
    cancelled: () => state.cancelled,
    finish: () => {
      if (finished) return;
      finished = true;
      activities.delete(state);
      if (activities.size === 0) active.delete(username);
      state.resolveDone();
    },
  };
}

export async function beginProfileErasure(
  username: string,
): Promise<() => void> {
  erasing.add(username);
  const activities = [...(active.get(username) ?? [])];
  for (const activity of activities) activity.cancelled = true;
  await Promise.all(activities.map((activity) => activity.done));
  return () => erasing.delete(username);
}
