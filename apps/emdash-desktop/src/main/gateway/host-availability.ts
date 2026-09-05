import { hostRef } from '@emdash/core/primitives/host/api';
import type { RuntimeBroker } from '@emdash/core/services/runtime-broker/api';
import { err, ok } from '@emdash/shared';
import type { Scope } from '@emdash/shared/concurrency';
import { waitWithSignal } from '@emdash/shared/scheduling';
import {
  createHostAvailability,
  type HostAvailabilityService,
} from '@core/services/hosts/node/availability';
import type { Hosts } from '@core/services/hosts/node/hosts';
import { translateHostPreparationError } from '@core/services/hosts/node/runtime-resolution';

export type CreateDesktopHostAvailabilityOptions = {
  scope: Scope;
  hosts: Pick<Hosts, 'get' | 'availability' | 'demand' | 'wake' | 'onReady' | 'onInvalidate'>;
  runtimes: Pick<RuntimeBroker, 'rebind' | 'forget'>;
  localReady(): Promise<void>;
};

/** Remote availability is projected directly; only local workers use the local readiness adapter. */
export function createDesktopHostAvailability(
  options: CreateDesktopHostAvailabilityOptions
): HostAvailabilityService {
  const availability = createHostAvailability({
    scope: options.scope,
    remote: (id) => {
      const current = options.hosts.get(hostRef('remote', id));
      if (!current) throw new Error(`Host '${id}' is not managed`);
      return { connection: current.connection, ...current.runtime };
    },
    remoteState: (id) => options.hosts.availability(id),
    remoteDemand: (id, mode, owner) => options.hosts.demand(id, mode, owner),
    wakeRemote: (cause) => options.hosts.wake(cause),
    readiness: {
      prepare: async (host, context) => {
        try {
          await waitWithSignal(options.localReady(), context.signal);
          return ok();
        } catch (error) {
          return err(translateHostPreparationError(host, 'handshaking', error));
        }
      },
    },
  });
  options.scope.add(
    options.hosts.onReady((id, attachment) => {
      options.runtimes.rebind(hostRef('remote', id), {
        client: attachment.client,
        connection: attachment.connection,
      });
    })
  );
  options.scope.add(
    options.hosts.onInvalidate(({ connectionId }) => {
      options.runtimes.forget(hostRef('remote', connectionId));
    })
  );
  return availability;
}
