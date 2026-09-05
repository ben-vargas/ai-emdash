import type { HostRef } from '@emdash/core/primitives/host/api';
import type { HostConnection } from '../../api/node/host-connection';

export interface HostService {
  readonly host: HostRef;
  readonly connection: HostConnection;
}
