import type { Scope } from '@emdash/shared/concurrency';
import type { HostDemandLease, HostDemandMode } from '../api/availability';
import type { HostConnection } from '../api/node/host-connection';

/** Compatibility for project callers: passive observation does not register connection intent. */
export function adaptHostDemand(
  connection: HostConnection,
  mode: HostDemandMode,
  owner: Scope
): HostDemandLease {
  let current = mode;
  let lease: Scope | undefined;
  const update = () => {
    if (owner.disposed) return;
    if (current === 'automatic') {
      lease = owner.child('host-lease');
      connection.lease(lease);
    } else {
      void lease?.dispose();
      lease = undefined;
    }
  };
  update();
  return {
    get mode() {
      return current;
    },
    setMode(next) {
      if (current === next || owner.disposed) return;
      current = next;
      update();
    },
  };
}
