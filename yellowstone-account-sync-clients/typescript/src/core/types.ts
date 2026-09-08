import type { Commitment, ConnectionConfig, DataSlice, PublicKey } from "@solana/web3.js";

export type AccountSyncCommitment = "processed" | "confirmed" | "finalized";

export enum AccountSyncTransports {
  WS = "ws",
  GRPC = "grpc"
}

// What: Transport kinds supported by the Node SDK build.
// Why: Node can use both gRPC and WebSocket subscriptions.
// How: Selected via `accountSync.transport` in constructor config.
export type NodeSubscriptionTransport =
  | AccountSyncTransports.WS
  | AccountSyncTransports.GRPC;

// What: Transport kinds supported by the browser SDK build.
// Why: Browsers cannot run `@grpc/grpc-js`.
// How: Browser build only accepts `ws`.
export type BrowserSubscriptionTransport = AccountSyncTransports.WS;

export interface GrpcTransportOptions {
  flowControlWindowBytes?: number;
  maxReceiveMessageLengthBytes?: number;
  keepAliveIntervalMs?: number;
  keepAliveTimeoutMs?: number;
  keepAlivePermitWithoutCalls?: boolean;
}

// What: Transport-agnostic SDK options injected under web3.js connection config.
// Why: Preserve web3.js constructor shape while adding account-sync options.
// How: Users pass these inside `accountSync` object.
export interface AccountSyncOptions<TTransport extends AccountSyncTransports> {
  transport?: TTransport;
  subscriptionEndpoint?: string;
  commitment?: AccountSyncCommitment;
  initialAccounts?: ReadonlyArray<string | PublicKey>;
  autoSubscribeOnMiss?: boolean;
  missTimeoutMs?: number;
  rpcPollIntervalMs?: number;
  reconnectInitialDelayMs?: number;
  reconnectMaxDelayMs?: number;
  connectTimeoutMs?: number;
  closeTimeoutMs?: number;
  dynamicSubscriptionTtlMs?: number;
  maxAccountsPerCommitment?: number;
  grpc?: TTransport extends AccountSyncTransports.GRPC
    ? GrpcTransportOptions
    : never;
}

// What: Node-side constructor config compatible with web3.js config.
// Why: Keep migration cost low for existing Node users.
// How: Extend `ConnectionConfig` with optional `accountSync` section.
export interface NodeAccountSyncConnectionConfig extends ConnectionConfig {
  accountSync?: AccountSyncOptions<NodeSubscriptionTransport>;
}

// What: Browser-side constructor config compatible with web3.js config.
// Why: Keep browser ergonomics identical while constraining transport.
// How: Extend `ConnectionConfig` with browser transport options.
export interface BrowserAccountSyncConnectionConfig extends ConnectionConfig {
  accountSync?: AccountSyncOptions<BrowserSubscriptionTransport>;
}

// What: Constructor second-argument shape accepted by the Node connection wrapper.
// Why: Match web3.js style: commitment string OR config object.
// How: Union of `Commitment` and config object.
export type NodeCommitmentOrConfig =
  | Commitment
  | NodeAccountSyncConnectionConfig
  | undefined;

// What: Constructor second-argument shape accepted by the browser connection wrapper.
// Why: Match web3.js style while browser transport remains ws-only.
// How: Union of `Commitment` and browser config object.
export type BrowserCommitmentOrConfig =
  | Commitment
  | BrowserAccountSyncConnectionConfig
  | undefined;

// What: Normalized account update decoded from SubscribeUpdate.
// Why: Core buffering/routing should not depend on raw protobuf objects.
// How: Transports decode protobuf payloads into this stable structure.
export interface DecodedAccountUpdate {
  accountId: string;
  lamports: bigint;
  owner: string;
  executable: boolean;
  rentEpoch: bigint;
  data: Uint8Array;
  slot: bigint;
  writeVersion: bigint;
}

// What: Buffered account state with local bookkeeping metadata.
// Why: Consumers need latest account payload while core tracks update time.
// How: Extends decoded update with `updatedAtMs`.
export interface BufferedAccountState extends DecodedAccountUpdate {
  updatedAtMs: number;
}

// What: Read-time constraints for resolving buffered account state.
// Why: web3.js `getAccountInfo` config can require a minimum context slot.
// How: The SDK compares this against the slot carried by the buffered update.
export interface AccountReadConstraints {
  minContextSlot?: number;
}

// What: Normalized `getAccountInfo` options after parsing web3.js input syntax.
// Why: Connections need commitment, min slot, and data slice in one small value.
// How: `connection/utils` validates and constructs this type.
export interface ResolvedGetAccountInfoOptions extends AccountReadConstraints {
  commitment: AccountSyncCommitment;
  dataSlice?: DataSlice;
}
