import type { HostRef } from '@emdash/core/primitives/host/api';
import type { HostService } from './host/host-service';

export interface Hosts {
  get(host: HostRef): HostService | undefined;
}
