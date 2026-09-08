import type { DecodedAccountUpdate } from "./types";
import type { AccountSyncCommitment } from "./types";

// What: Callbacks emitted by transport implementations.
// Why: Core state machine needs decoded account updates and transport errors.
// How: Transports invoke these callbacks from websocket/grpc event loops.
export interface TransportHandlers {
  onAccountUpdate: (update: DecodedAccountUpdate) => void;
  onTransportError: (error: Error) => void;
}

// What: Common transport interface used by SDK core.
// Why: Keeps business logic independent from wire protocol implementation.
// How: Core calls `connect`/`setTrackedAccounts`/`close` on this interface.
export interface AccountSubscriptionTransport {
  connect(handlers: TransportHandlers, signal: AbortSignal): Promise<void>;
  setTrackedAccounts(
    accountIds: readonly string[],
    commitment: AccountSyncCommitment
  ): Promise<void>;
  close(): Promise<void>;
}

// What: Builds one transport session for a requested commitment.
// Why: Server sessions have one commitment for the whole account set.
// How: Core creates separate sessions when callers request different commitments.
export type AccountSubscriptionTransportFactory = (
  commitment: AccountSyncCommitment
) => AccountSubscriptionTransport;
