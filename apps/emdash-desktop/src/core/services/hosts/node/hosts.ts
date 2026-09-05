import { sshConnectionIdOf, type HostRef } from '@emdash/core/primitives/host/api';
import type { Scope } from '@emdash/shared/concurrency';
import { cell, derived, snapshot, type Cell, type Readable } from '@emdash/wire/state';
import type { SshConnectionLifecycle } from '@core/primitives/ssh/api/node/connection-control';
import type { SshConnectionManagerEvent } from '@core/primitives/ssh/api/node/ssh-connection-manager';
import type { HostInvalidation, MachineMutationEvents } from '../api';
import type { HostAvailabilityState, HostDemandLease, HostDemandMode } from '../api/availability';
import { adaptHostDemand } from './host-demand';
import {
  createHostService,
  type CreateHostServiceOptions,
  type HostService,
  type HostServiceEntry,
} from './host/host-service';
import { HostStateModel } from './state-model';
import type { WorkspaceServerConnection } from './workspace-server/connect/wire-connection-manager';

export interface Hosts {
  /** Stable until identity replacement. Local workers remain owned by desktop runtime bootstrap. */
  get(host: HostRef): HostService | undefined;
  /** Cross-identity projection and legacy project demand integration. */
  availability(connectionId: string): Readable<HostAvailabilityState>;
  demand(connectionId: string, mode: HostDemandMode, owner: Scope): HostDemandLease;
  readonly lifecycle: SshConnectionLifecycle;
  readonly stateModel: HostStateModel;
  wake(cause: 'online' | 'focus' | 'resume' | 'suspend'): void;
  onInvalidate(listener: (event: HostInvalidation) => void): () => void;
  onReady(
    listener: (connectionId: string, attachment: WorkspaceServerConnection) => void
  ): () => void;
  dispose(): Promise<void>;
}

export type CreateHostsOptions = Omit<
  CreateHostServiceOptions,
  'host' | 'stateModel' | 'nextGeneration' | 'onReady'
> & {
  machineEvents: MachineMutationEvents;
};

/** Registry and identity owner. Host-specific connection and server work lives in HostService. */
export function createHosts(options: CreateHostsOptions): Hosts {
  const scope = options.scope.child('hosts');
  const stateModel = scope.use(new HostStateModel());
  const entries = new Map<string, HostServiceEntry>();
  const availabilityStates = new Map<
    string,
    {
      source: Cell<Readable<HostAvailabilityState> | undefined>;
      value: Readable<HostAvailabilityState>;
    }
  >();
  const demands = new Map<
    string,
    Set<{ mode: HostDemandMode; owner: Scope; lease: HostDemandLease }>
  >();
  const readyListeners = new Set<(id: string, attachment: WorkspaceServerConnection) => void>();
  const invalidationListeners = new Set<(event: HostInvalidation) => void>();
  let generation = 0;

  function slot(id: string) {
    let value = availabilityStates.get(id);
    if (!value) {
      const source = cell<Readable<HostAvailabilityState> | undefined>(undefined);
      const availability = derived((): HostAvailabilityState => {
        const current = snapshot(source).value;
        return current ? snapshot(current).value : { kind: 'unavailable', recovery: 'eligible' };
      }) as Readable<HostAvailabilityState>;
      value = { source, value: availability };
      availabilityStates.set(id, value);
    }
    return value;
  }

  function entry(id: string): HostServiceEntry {
    scope.signal.throwIfAborted();
    const existing = entries.get(id);
    if (existing) return existing;
    const instance = createHostService({
      ...options,
      scope,
      host: { type: 'remote', id },
      stateModel,
      nextGeneration: () => ++generation,
      onReady: (attachment) => {
        if (entries.get(id) !== instance) return;
        for (const listener of readyListeners) {
          try {
            listener(id, attachment);
          } catch (error) {
            options.logger?.warn('Host readiness observer failed', { error });
          }
        }
      },
    });
    entries.set(id, instance);
    slot(id).source.set(instance.service.connection.availability);
    return instance;
  }

  function retire(id: string): Promise<void> {
    const previous = entries.get(id);
    entries.delete(id);
    const disposed = previous?.dispose() ?? Promise.resolve();
    stateModel.remove(id);
    slot(id).source.set(undefined);
    return disposed;
  }

  const onSshEvent = (event: SshConnectionManagerEvent) => {
    if (event.type === 'disconnected') entries.get(event.connectionId)?.sshDisconnected();
  };
  options.ssh.manager.on('connection-event', onSshEvent);
  scope.add(() => {
    options.ssh.manager.off('connection-event', onSshEvent);
  });
  scope.add(
    options.machineEvents.on('machine:mutated', ({ connectionId: id }) => {
      void retire(id);
      for (const listener of invalidationListeners) {
        try {
          listener({ connectionId: id, reason: 'machine-mutation' });
        } catch {
          /* An observer cannot prevent lease rebinding or other observers. */
        }
      }
      for (const demand of demands.get(id) ?? []) {
        demand.lease.setMode('passive');
        demand.lease = adaptHostDemand(entry(id).service.connection, demand.mode, demand.owner);
      }
    })
  );
  scope.add(() => {
    invalidationListeners.clear();
    readyListeners.clear();
    entries.clear();
  });

  return {
    get(host) {
      const id = sshConnectionIdOf(host);
      return id ? entry(id).service : undefined;
    },
    availability: (id) => slot(id).value,
    demand(id, mode, owner) {
      const demand = {
        mode,
        owner,
        lease: adaptHostDemand(entry(id).service.connection, mode, owner),
      };
      let leases = demands.get(id);
      if (!leases) {
        leases = new Set();
        demands.set(id, leases);
      }
      leases.add(demand);
      owner.add(() => {
        leases.delete(demand);
        if (leases.size === 0) demands.delete(id);
      });
      return {
        get mode() {
          return demand.mode;
        },
        setMode(next) {
          demand.mode = next;
          demand.lease.setMode(next);
        },
      };
    },
    lifecycle: {
      connect: async (id) => {
        await entry(id).connectSsh();
        return 'connected';
      },
      ensureConnected: async (id) => {
        const current = entry(id);
        if (!(await options.ssh.control.readIntent(id))) return 'disconnected';
        await current.ensureSsh();
        return 'connected';
      },
      disconnect: async (id) => {
        const result = await entry(id).service.connection.disconnect();
        if (!result.success) throw result.error;
      },
      invalidate: async (id) => {
        const disposed = retire(id);
        // Drop before yielding: a newly created identity must not lose its SSH client later.
        await Promise.all([disposed, options.ssh.manager.dropConnection(id)]);
      },
    },
    stateModel,
    wake(cause) {
      for (const current of entries.values()) current.wake(cause);
    },
    onInvalidate(listener) {
      invalidationListeners.add(listener);
      return () => invalidationListeners.delete(listener);
    },
    onReady(listener) {
      readyListeners.add(listener);
      for (const [id, current] of entries) {
        const attachment = current.readyAttachment();
        if (attachment) listener(id, attachment);
      }
      return () => readyListeners.delete(listener);
    },
    dispose: () => scope.dispose(),
  };
}
