# TypeScript SDK Examples for Yellowstone Account Sync

These examples use `@triton-one/triton-sdk` to get account data from local buffers.

The SDK is a web3.js-compatible `Connection` with streaming-backed account reads. These examples show:

- `getAccountInfo`
- `getAccountInfoAndContext`
- `getMultipleAccountsInfo`
- `getMultipleAccountsInfoAndContext`
- `getParsedAccountInfo`
- `getMultipleParsedAccounts`
- `dataSlice`
- `minContextSlot`
- bounded connection and shutdown settings
- bounded dynamic subscriptions
- add, remove, and re-add lifecycle
- `grpc-js` flow-control and keepalive settings

## Install

From this directory:

```bash
cd examples/clients/typescript
npm install
```

## Common Values

Most examples use these defaults:

| Name | Default |
| --- | --- |
| `rpc_endpoint` | `https://example.com/yourToken` |
| `account` | `ping6gwBZx1ccMMFyLgkVSupUmujYrFidEXuNRPq989` |
| `parsed_account` | `So11111111111111111111111111111111111111112` |
| `accounts` | comma-separated public keys |
| `commitment` | `confirmed`, except `minContextSlot` examples default to `processed` |
| `dataSlice` | `0:32` |

All examples accept one endpoint flag:

```bash
--rpc-endpoint <rpc_endpoint>
```

The endpoint is used for both Solana JSON-RPC and account-sync streaming. gRPC
examples use it directly. WebSocket examples replace `http` with `ws` and
`https` with `wss`.

Commitment values:

- `processed`
- `confirmed`
- `finalized`

`accounts` must be comma-separated public keys:

```text
pubkey1,pubkey2,pubkey3
```

`dataSlice` uses `offset:length`:

```text
8:32
```

That means: start at byte offset `8`, return up to `32` bytes.

## Command Index

The package contains both WebSocket and gRPC examples. Browser applications must
use WebSocket. The gRPC examples use the Node-only `grpc-js` transport.

| Script | Method shown | Transport |
| --- | --- | --- |
| `npm run example:ws` | `getAccountInfoAndContext` | WebSocket |
| `npm run example:multiple:ws` | `getMultipleAccountsInfoAndContext` | WebSocket |
| `npm run example:grpc` | `getAccountInfoAndContext` | gRPC |
| `npm run example:multiple:grpc` | `getMultipleAccountsInfoAndContext` | gRPC |
| `npm run example:grpc:parsed` | `getParsedAccountInfo` | gRPC |
| `npm run example:multiple:grpc:parsed` | `getMultipleParsedAccounts` | gRPC |
| `npm run example:grpc:data-slice` | `getAccountInfoAndContext` with `dataSlice` | gRPC |
| `npm run example:multiple:grpc:data-slice` | `getMultipleAccountsInfoAndContext` with `dataSlice` | gRPC |
| `npm run example:grpc:min-context-slot` | `getAccountInfoAndContext` with `minContextSlot` | gRPC |
| `npm run example:multiple:grpc:min-context-slot` | `getMultipleAccountsInfoAndContext` with `minContextSlot` | gRPC |
| `npm run example:grpc:lifecycle` | add, remove, and re-add an account | gRPC |
| `npm run example:compare:get-account-info` | Triton SDK and web3.js `getMultipleAccountsInfo` timing for 100 accounts | gRPC and JSON-RPC |

## Compare `getMultipleAccountsInfo` Response Times

This example calls the Triton SDK and standard web3.js client concurrently. It
loads the first 100 unique accounts from `../../accounts.csv` and passes the
same ordered list to both clients. It hashes each full ordered result and prints
one row when both results match and that full result has not been printed
before. Each duration covers the full 100-account request.

```bash
npm run example:compare:get-account-info -- \
  --rpc-endpoint https://example.com/<TOKEN> \
  confirmed \
  250
```

Arguments after the endpoint are `commitment` and `poll_interval_ms`. Stop the
example with `Ctrl+C`.

For each unique matching 100-account result, the output shows:

- `update`: unique matched account state number.
- `web3 durationMs`: web3.js `getMultipleAccountsInfo` response time.
- `triton durationMs`: Triton SDK `getMultipleAccountsInfo` response time.
- `winner`: client with the shorter response time.
- `fasterByMs`: difference between the two response times.

The hash includes account order, missing accounts, and every account field. The
script compares only calls made in the same polling round. It does not match
results across different rounds. Because `getMultipleAccountsInfo` does not
return write slots, identical full results at a later slot are not printed
again. Call duration measures the full batch response time. It is not full
validator-to-client latency.

## Behavior Shown by the Examples

- Each account-read step makes one SDK call. It does not poll in a retry loop.
- The SDK retries failed initial hydration while the account remains tracked.
- `null` means RPC confirmed that the account is missing.
- A slow stream, failed RPC call, or local read timeout is an error. It is not
  changed into `null`.
- Present and missing results include the bank context slot that proved the
  result.
- Read-created subscriptions expire after `dynamicSubscriptionTtlMs` when they
  are idle. Pinned accounts stay until removed.
- Account state is bounded by `maxAccountsPerCommitment`.
- `removeAccounts` releases the subscription and cached state after active reads
  finish. Re-adding the account obtains current state.
- `connection.close()` owns its shutdown limit. The examples do not hide a
  failed shutdown behind another timer.

## Shared Connection Limits

Most examples use these account-sync settings:

| Setting | Value |
| --- | --- |
| `missTimeoutMs` | `5000` |
| `connectTimeoutMs` | `10000` |
| `closeTimeoutMs` | `5000` |
| `dynamicSubscriptionTtlMs` | `60000` |
| `maxAccountsPerCommitment` | `10000` |

The gRPC examples also use:

| Setting | Value |
| --- | --- |
| `flowControlWindowBytes` | `16777216` |
| `maxReceiveMessageLengthBytes` | `16777216` |
| `keepAliveIntervalMs` | `30000` |
| `keepAliveTimeoutMs` | `10000` |
| `keepAlivePermitWithoutCalls` | `true` |

These are fixed `grpc-js` channel settings. `grpc-js` does not expose Triton's
adaptive-window setting and does not support Zstd stream compression.

## WebSocket: `getAccountInfo`

Script:

```bash
npm run example:ws
```

Command forms:

```bash
npm run example:ws
npm run example:ws -- [--rpc-endpoint <rpc_endpoint>] [account] [commitment]
```

Examples:

```bash
npm run example:ws
npm run example:ws -- --rpc-endpoint https://example.com/yourToken ping6gwBZx1ccMMFyLgkVSupUmujYrFidEXuNRPq989 confirmed
```

## WebSocket: `getMultipleAccountsInfo`

Script:

```bash
npm run example:multiple:ws
```

Command forms:

```bash
npm run example:multiple:ws
npm run example:multiple:ws -- [--rpc-endpoint <rpc_endpoint>] [accounts] [commitment]
```

Examples:

```bash
npm run example:multiple:ws
npm run example:multiple:ws -- --rpc-endpoint https://example.com/yourToken ping6gwBZx1ccMMFyLgkVSupUmujYrFidEXuNRPq989,ping6gwBZx1ccMMFyLgkVSupUmujYrFidEXuNRPq989 confirmed
```

Output order matches input order.

## gRPC: `getAccountInfo`

Script:

```bash
npm run example:grpc
```

Command forms:

```bash
npm run example:grpc
npm run example:grpc -- [--rpc-endpoint <rpc_endpoint>] [account] [commitment]
```

Examples:

```bash
npm run example:grpc
npm run example:grpc -- --rpc-endpoint https://example.com/yourToken ping6gwBZx1ccMMFyLgkVSupUmujYrFidEXuNRPq989 confirmed
```

## gRPC: `getMultipleAccountsInfo`

Script:

```bash
npm run example:multiple:grpc
```

Command forms:

```bash
npm run example:multiple:grpc
npm run example:multiple:grpc -- [--rpc-endpoint <rpc_endpoint>] [accounts] [commitment]
```

Examples:

```bash
npm run example:multiple:grpc
npm run example:multiple:grpc -- --rpc-endpoint https://example.com/yourToken ping6gwBZx1ccMMFyLgkVSupUmujYrFidEXuNRPq989,ping6gwBZx1ccMMFyLgkVSupUmujYrFidEXuNRPq989 confirmed
```

Output order matches input order.

## gRPC: `getParsedAccountInfo`

Script:

```bash
npm run example:grpc:parsed
```

Command forms:

```bash
npm run example:grpc:parsed
npm run example:grpc:parsed -- [--rpc-endpoint <rpc_endpoint>] [account] [commitment]
```

Examples:

```bash
npm run example:grpc:parsed
npm run example:grpc:parsed -- --rpc-endpoint https://example.com/yourToken So11111111111111111111111111111111111111112 confirmed
```

Default account:

```text
So11111111111111111111111111111111111111112
```

## gRPC: `getMultipleParsedAccounts`

Script:

```bash
npm run example:multiple:grpc:parsed
```

Command forms:

```bash
npm run example:multiple:grpc:parsed
npm run example:multiple:grpc:parsed -- [--rpc-endpoint <rpc_endpoint>] [accounts] [commitment]
```

Examples:

```bash
npm run example:multiple:grpc:parsed
npm run example:multiple:grpc:parsed -- --rpc-endpoint https://example.com/yourToken So11111111111111111111111111111111111111112,So11111111111111111111111111111111111111112 confirmed
```

Default accounts:

```text
So11111111111111111111111111111111111111112,So11111111111111111111111111111111111111112
```

## gRPC: `getAccountInfo` With `dataSlice`

Script:

```bash
npm run example:grpc:data-slice
```

Command forms:

```bash
npm run example:grpc:data-slice
npm run example:grpc:data-slice -- [--rpc-endpoint <rpc_endpoint>] [account] [commitment] [offset:length]
```

Examples:

```bash
npm run example:grpc:data-slice
npm run example:grpc:data-slice -- --rpc-endpoint https://example.com/yourToken ping6gwBZx1ccMMFyLgkVSupUmujYrFidEXuNRPq989 confirmed 8:32
npm run example:grpc:data-slice -- --rpc-endpoint https://example.com/yourToken ping6gwBZx1ccMMFyLgkVSupUmujYrFidEXuNRPq989 finalized 0:64
```

## gRPC: `getMultipleAccountsInfo` With `dataSlice`

Script:

```bash
npm run example:multiple:grpc:data-slice
```

Command forms:

```bash
npm run example:multiple:grpc:data-slice
npm run example:multiple:grpc:data-slice -- [--rpc-endpoint <rpc_endpoint>] [accounts] [commitment] [offset:length]
```

Examples:

```bash
npm run example:multiple:grpc:data-slice
npm run example:multiple:grpc:data-slice -- --rpc-endpoint https://example.com/yourToken ping6gwBZx1ccMMFyLgkVSupUmujYrFidEXuNRPq989,ping6gwBZx1ccMMFyLgkVSupUmujYrFidEXuNRPq989 confirmed 8:32
npm run example:multiple:grpc:data-slice -- --rpc-endpoint https://example.com/yourToken ping6gwBZx1ccMMFyLgkVSupUmujYrFidEXuNRPq989,ping6gwBZx1ccMMFyLgkVSupUmujYrFidEXuNRPq989 finalized 0:64
```

## gRPC: `getAccountInfo` With `minContextSlot`

Script:

```bash
npm run example:grpc:min-context-slot
```

Command forms:

```bash
npm run example:grpc:min-context-slot
npm run example:grpc:min-context-slot -- [--rpc-endpoint <rpc_endpoint>] [account] [commitment]
```

Examples:

```bash
npm run example:grpc:min-context-slot
npm run example:grpc:min-context-slot -- --rpc-endpoint https://example.com/yourToken ping6gwBZx1ccMMFyLgkVSupUmujYrFidEXuNRPq989 processed
npm run example:grpc:min-context-slot -- --rpc-endpoint https://example.com/yourToken ping6gwBZx1ccMMFyLgkVSupUmujYrFidEXuNRPq989 confirmed
```

This example calls `getSlot` with finalized commitment, then uses `slot + 30`
as `minContextSlot` for `getAccountInfoAndContext`.

The example uses `missTimeoutMs = 30000` because RPC or stream bank progress may
need time to reach the requested slot. It checks that the returned bank context
is not before `minContextSlot`. A missing account is still a valid result when
its context meets that rule.

## gRPC: `getMultipleAccountsInfoAndContext` With `minContextSlot`

Script:

```bash
npm run example:multiple:grpc:min-context-slot
```

Command forms:

```bash
npm run example:multiple:grpc:min-context-slot
npm run example:multiple:grpc:min-context-slot -- [--rpc-endpoint <rpc_endpoint>] [accounts] [commitment]
```

Examples:

```bash
npm run example:multiple:grpc:min-context-slot
npm run example:multiple:grpc:min-context-slot -- --rpc-endpoint https://example.com/yourToken ping6gwBZx1ccMMFyLgkVSupUmujYrFidEXuNRPq989,ping6gwBZx1ccMMFyLgkVSupUmujYrFidEXuNRPq989 processed
npm run example:multiple:grpc:min-context-slot -- --rpc-endpoint https://example.com/yourToken ping6gwBZx1ccMMFyLgkVSupUmujYrFidEXuNRPq989,ping6gwBZx1ccMMFyLgkVSupUmujYrFidEXuNRPq989 confirmed
```

This example calls `getSlot` with finalized commitment, then uses `slot + 30` as `minContextSlot` for `getMultipleAccountsInfoAndContext`.

The example prints the response context slot and returned accounts.

It accepts missing accounts as valid tombstones and prints them as
`confirmed-missing`. It fails if the returned bank context is before the
requested `minContextSlot`.

## gRPC: Account Subscription Lifecycle

Script:

```bash
npm run example:grpc:lifecycle
```

Command forms:

```bash
npm run example:grpc:lifecycle
npm run example:grpc:lifecycle -- [--rpc-endpoint <rpc_endpoint>] [account] [commitment]
```

The example adds and reads an account, removes it, then re-adds it before the
next read. This matters because a read made while the account is removed creates
a new temporary lease. The example also uses a small account limit and a short
dynamic lease so those controls are easy to find in the code.

## Notes

- Node examples can use gRPC or WebSocket.
- Browser apps should use WebSocket.
- The SDK package export is designed to expose the right browser or Node
  connection type for the environment.
- `minContextSlot` is checked against known bank context progress, not the last
  slot where the account data changed.
- `dataSlice` changes returned `data`, not full account `space`.
- Call and await `connection.close()` when a script is done.
- Use `npm run typecheck` to check every example without making network calls.
