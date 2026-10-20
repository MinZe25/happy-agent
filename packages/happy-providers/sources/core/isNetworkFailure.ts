/**
 * Whether a failure never reached the vendor: the connection was refused, reset, timed out, or
 * the host did not resolve. Node and undici report these as error codes somewhere along the
 * `cause` chain, and fetch wraps them in a bare "fetch failed". A failure the vendor answered
 * carries an HTTP status and is never a network failure.
 */
export function isNetworkFailure(error: unknown, message: string): boolean {
    return (
        hasNetworkCode(error, new Set()) ||
        NETWORK_FAILURE_MESSAGES.some((pattern) => pattern.test(message))
    );
}

const NETWORK_FAILURE_CODES = new Set([
    "EAI_AGAIN",
    "ECONNABORTED",
    "ECONNREFUSED",
    "ECONNRESET",
    "EHOSTUNREACH",
    "ENETDOWN",
    "ENETUNREACH",
    "ENOTFOUND",
    "EPIPE",
    "ETIMEDOUT",
    "UND_ERR_BODY_TIMEOUT",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_SOCKET",
]);

const NETWORK_FAILURE_MESSAGES = [
    /^fetch failed$/iu,
    /socket hang up/iu,
    /^premature close$/iu,
    /other side closed/iu,
    /getaddrinfo (?:ENOTFOUND|EAI_AGAIN)/u,
    /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH)\b/u,
];

function hasNetworkCode(error: unknown, seen: Set<object>): boolean {
    if (typeof error !== "object" || error === null || seen.has(error)) return false;
    seen.add(error);
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && NETWORK_FAILURE_CODES.has(code)) return true;
    const nested = error as { cause?: unknown; error?: unknown };
    return hasNetworkCode(nested.cause, seen) || hasNetworkCode(nested.error, seen);
}
