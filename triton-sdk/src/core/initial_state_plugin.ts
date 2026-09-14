import type { AccountSyncCommitment, DecodedAccountUpdate } from "./types";

export interface InitialStateHydrationContext {
  accountIds: readonly string[];
  commitment: AccountSyncCommitment;
  minContextSlot?: number;
  singleRequest?: boolean;
  rpcErrorMessage?: string;
  signal: AbortSignal;
  upsert: (update: DecodedAccountUpdate) => boolean;
  remove: (accountId: string, slot: bigint) => boolean;
}

// What: Extension point owned by the core for account cache warmup.
// Why: Transports should keep streaming while another source hydrates initial state.
// How: Implementations fetch account state and insert through the provided upsert hook.
export interface AccountSyncInitialStatePlugin {
  hydrate(context: InitialStateHydrationContext): Promise<void>;
}
