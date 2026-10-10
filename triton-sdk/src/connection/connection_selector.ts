import {
  Connection as Web3Connection,
  type Commitment,
  type ConnectionConfig
} from "@solana/web3.js";

export interface ConnectionConstructor<
  T extends ConnectionConfig & { accountSync?: unknown },
  TEnabled extends Web3Connection
> {
  /**
   * Create a connection with account-sync reads enabled.
   *
   * @param endpoint URL of the Solana JSON RPC endpoint.
   * @param config Connection options with account-sync settings.
   * @returns A connection that serves account reads through account-sync.
   * @throws Error when the endpoint or account-sync settings are invalid.
   */
  new (endpoint: string, config: T & { accountSync: NonNullable<T["accountSync"]> }): TEnabled;
  /**
   * Create a connection using the supplied commitment or options.
   *
   * @param endpoint URL of the Solana JSON RPC endpoint.
   * @param config Optional default commitment or connection options.
   * @returns An account-sync connection when accountSync is supplied, or a native web3.js connection otherwise.
   * @throws Error when the endpoint or connection settings are invalid.
   */
  new (endpoint: string, config?: Commitment | T): Web3Connection;
}

/**
 * Build the constructor exposed as Connection.
 *
 * @param AccountSyncConnection Account-sync connection class for this runtime.
 * @returns A constructor that selects account-sync when its settings are supplied.
 */
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
