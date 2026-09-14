// What: Compares two account sets for exact equality.
// Why: Avoid unnecessary transport writes when desired tracked set is unchanged.
// How: Compare set sizes then membership.
export function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const value of a) {
    if (!b.has(value)) {
      return false;
    }
  }
  return true;
}

const WS_SERVICE_SEGMENT = "YellowstoneAccountSyncService";
const WS_METHOD_SEGMENT = "ws";

// What: Normalizes websocket endpoint to service route expected by account-sync ingress.
// Why: SDK websocket traffic must consistently target `/[<token>/]YellowstoneAccountSyncService/ws`.
// How: Parse URL, preserve protocol/host/query, and rewrite pathname to token-first service path.
export function normalizeWsSubscriptionEndpoint(endpoint: string): string {
  const normalizedEndpoint = endpoint.includes("://") ? endpoint : `ws://${endpoint}`;
  const url = new URL(normalizedEndpoint);

  const pathSegments = url.pathname.split("/").filter((segment) => segment.length > 0);
  const serviceTailIndex = pathSegments.length - 2;
  const hasCurrentServiceTail =
    serviceTailIndex >= 0 &&
    pathSegments[serviceTailIndex] === WS_SERVICE_SEGMENT &&
    pathSegments[serviceTailIndex + 1] === WS_METHOD_SEGMENT;
  if (hasCurrentServiceTail) {
    return url.toString();
  }

  const token = inferTokenSegmentFromWsPath(pathSegments);
  const servicePath = `/${WS_SERVICE_SEGMENT}/${WS_METHOD_SEGMENT}`;
  url.pathname = token ? `/${token}${servicePath}` : servicePath;
  return url.toString();
}

function inferTokenSegmentFromWsPath(pathSegments: string[]): string | null {
  if (pathSegments.length === 0) {
    return null;
  }

  if (pathSegments.length >= 2) {
    const serviceIndex = pathSegments.length - 2;
    if (
      pathSegments[serviceIndex] === WS_SERVICE_SEGMENT &&
      pathSegments[pathSegments.length - 1] === WS_METHOD_SEGMENT
    ) {
      return serviceIndex === 0 ? null : pathSegments[serviceIndex - 1];
    }
  }

  return pathSegments[pathSegments.length - 1];
}
