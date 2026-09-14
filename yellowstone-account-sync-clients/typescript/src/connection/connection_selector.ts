import {
  Connection as Web3Connection,
  type Commitment,
  type ConnectionConfig
} from "@solana/web3.js";

export interface ConnectionConstructor<
  T extends ConnectionConfig & { accountSync?: unknown },
  TEnabled extends Web3Connection
> {
  new (endpoint: string, config: T & { accountSync: NonNullable<T["accountSync"]> }): TEnabled;
  new (endpoint: string, config?: Commitment | T): Web3Connection;
}

export function createConnectionConstructor<
  T extends ConnectionConfig & { accountSync?: unknown },
  TEnabled extends Web3Connection
>(
  AccountSyncConnection: new (endpoint: string, config: T) => TEnabled
): ConnectionConstructor<T, TEnabled> {
  function Connection(endpoint: string, config?: Commitment | T) {
    if (typeof config === "object" && config?.accountSync !== undefined) {
      return new AccountSyncConnection(endpoint, config);
    }
    return new Web3Connection(endpoint, config);
  }

  return Connection as unknown as ConnectionConstructor<T, TEnabled>;
}
