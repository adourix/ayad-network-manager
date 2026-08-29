import type { Reachability } from "./Reachability.js";
const OFFLINE_GRACE_PERIOD_MS = 15_000;
const FAILED_CONFIRMATION_MS = 10_000;

interface PresenceState {
  lastOnlineEvidenceAt: number;
  confirmedOnline: boolean;
  offlineCandidateSince: number | null;
}

export class PresenceResolver {
  private readonly states =
    new Map<string, PresenceState>();

  resolve(
    mac: string,
    neighborState: string | undefined,
    hasNeighborEntry: boolean,
    getNeighborState: (
      state: string | undefined,
    ) => Reachability,
  ): Reachability {
    const now = Date.now();

    let presence =
      this.states.get(mac);

    if (!presence) {
      presence = {
        lastOnlineEvidenceAt: 0,
        confirmedOnline: false,
        offlineCandidateSince: null,
      };

      this.states.set(mac, presence);
    }

    const directState =
      getNeighborState(
        neighborState,
      );

    if (directState === true) {
      presence.lastOnlineEvidenceAt =
        now;

      presence.confirmedOnline = true;
      presence.offlineCandidateSince = null;

      return true;
    }

    if (directState === false) {
      if (
        presence.offlineCandidateSince === null
      ) {
        presence.offlineCandidateSince = now;
      }

      const offlineElapsed =
        now -
        presence.offlineCandidateSince;

      if (
        offlineElapsed >=
        FAILED_CONFIRMATION_MS
      ) {
        presence.confirmedOnline = false;

        return false;
      }

      return presence.confirmedOnline;
    }

    if (!hasNeighborEntry) {
      if (
        presence.offlineCandidateSince === null
      ) {
        presence.offlineCandidateSince = now;
      }

      const offlineElapsed =
        now -
        presence.offlineCandidateSince;

      if (
        offlineElapsed >=
        OFFLINE_GRACE_PERIOD_MS
      ) {
        presence.confirmedOnline = false;

        return false;
      }

      return presence.confirmedOnline;
    }

    return presence.confirmedOnline;
  }
}
