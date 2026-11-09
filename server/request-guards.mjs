import { createHash } from "node:crypto";
import { verifyPassword } from "./password.mjs";

export const defaultTrustedProxyCount = 1;

export const tooManyAuthFailuresPayload = Object.freeze({
  error: "too_many_requests",
  message: "Too many failed authentication attempts. Try again later.",
});

export const normalizeTrustedProxyCount = (value, name = "trustedProxyCount") => {
  if (value === undefined || value === null) return defaultTrustedProxyCount;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} 必须是大于等于 1 的整数`);
  }
  return value;
};

export const normalizeOptionalBoolean = (value, name, fallback = false) => {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") {
    throw new Error(`${name} 必须是 true 或 false`);
  }
  return value;
};
export const normalizePositiveInteger = (value, name, fallback, { minimum = 1, maximum = Number.MAX_SAFE_INTEGER } = {}) => {
  if (value === undefined || value === null) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${name} 必须是 ${minimum} 到 ${maximum} 的整数`);
  return value;
};
export const environmentInteger = (value, name) => {
  if (value == null || value === "") return undefined;
  if (!/^\d+$/u.test(value)) throw new Error(`${name} 必须是整数`);
  return Number(value);
};

// Every trusted proxy appends the address it accepted the connection from to
// X-Forwarded-For, so the right-hand entries are written by our own proxies and
// everything to their left is whatever the client sent. The client address is
// therefore the entry appended by the outermost trusted proxy.
export const resolveClientAddress = (
  request,
  { trustProxyHeaders = false, trustedProxyCount = defaultTrustedProxyCount } = {},
) => {
  const socketAddress = request.socket?.remoteAddress || "unknown";
  if (trustProxyHeaders !== true) return socketAddress;
  const header = request.headers["x-forwarded-for"];
  const entries = (Array.isArray(header) ? header.join(",") : String(header ?? ""))
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length < trustedProxyCount) return socketAddress;
  return entries[entries.length - trustedProxyCount];
};

// Devices that logged in successfully before (proven by a signed device
// cookie) get a lockout bucket of their own, so exhausting the shared user and
// IP buckets cannot lock the owner out of devices they already use.
export const loginAttemptKeys = ({ deviceId, clientAddress, username }) =>
  deviceId
    ? [`device:${deviceId}`]
    : [`ip:${clientAddress}`, `user:${username}`];

export const bearerTokenFrom = (request) => {
  const match = String(request.headers.authorization || "").match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : "";
};

const toRetryAfterSeconds = (milliseconds) => Math.max(1, Math.ceil(milliseconds / 1000));

// Tracks failed attempts per key inside a fixed window that starts with the
// first failure. A key is limited while its post-failure delay is running or
// once failures (plus verifications still in flight) reach maxFailures.
// Counting in-flight verifications stops a burst of concurrent requests from
// getting past the limit before the first failure is recorded.
export const createFailureLimiter = ({
  maxFailures,
  windowMs,
  maxEntries,
  delayMs = () => 0,
  now = Date.now,
}) => {
  const entries = new Map();

  const isExpired = (entry, at) =>
    entry.inFlight === 0 && at - entry.firstAt >= windowMs && at >= entry.nextAllowedAt;

  const prune = (at) => {
    for (const [key, entry] of entries) {
      if (isExpired(entry, at)) entries.delete(key);
    }
  };

  const current = (key, at) => {
    const entry = entries.get(key);
    if (entry && isExpired(entry, at)) {
      entries.delete(key);
      return undefined;
    }
    return entry;
  };

  const ensure = (key, at) => {
    const existing = current(key, at);
    if (existing) return existing;
    if (entries.size >= maxEntries) prune(at);
    if (entries.size >= maxEntries) return undefined;
    const entry = { failures: 0, firstAt: at, nextAllowedAt: 0, inFlight: 0 };
    entries.set(key, entry);
    return entry;
  };

  const recordAt = (key, at) => {
    const entry = ensure(key, at);
    if (!entry) return;
    entry.failures += 1;
    entry.nextAllowedAt = at + delayMs(entry.failures);
  };

  const evaluate = (key, at) => {
    const entry = current(key, at);
    if (!entry) return { limited: false, retryAfterMs: 0 };
    const delayLeftMs = entry.nextAllowedAt - at;
    const exhausted = entry.failures + entry.inFlight >= maxFailures;
    if (delayLeftMs <= 0 && !exhausted) return { limited: false, retryAfterMs: 0 };
    let retryAfterMs = Math.max(0, delayLeftMs);
    if (entry.failures >= maxFailures) {
      retryAfterMs = Math.max(retryAfterMs, entry.firstAt + windowMs - at);
    } else if (exhausted) {
      retryAfterMs = Math.max(retryAfterMs, 1000);
    }
    return { limited: true, retryAfterMs };
  };

  const checkAt = (keys, at) => {
    let limited = false;
    let retryAfterMs = 0;
    for (const key of keys) {
      const state = evaluate(key, at);
      if (!state.limited) continue;
      limited = true;
      retryAfterMs = Math.max(retryAfterMs, state.retryAfterMs);
    }
    const missingCount = () => keys.filter((key) => !entries.has(key)).length;
    if (entries.size + missingCount() > maxEntries) {
      prune(at);
      if (entries.size + missingCount() > maxEntries) {
        // Never evict an active window to admit an attacker-chosen identity.
        // Unknown clients wait for capacity; tracked clients keep their limits.
        let capacityRetryMs = windowMs;
        for (const entry of entries.values()) {
          capacityRetryMs = Math.min(capacityRetryMs, entry.inFlight > 0
            ? 1000
            : Math.max(entry.firstAt + windowMs, entry.nextAllowedAt) - at);
        }
        limited = true;
        retryAfterMs = Math.max(retryAfterMs, Math.max(1000, capacityRetryMs));
      }
    }
    return { limited, retryAfterMs };
  };

  return {
    check(keys) {
      return checkAt([...new Set(keys)], now());
    },
    begin(keys) {
      const at = now();
      const uniqueKeys = [...new Set(keys)];
      if (checkAt(uniqueKeys, at).limited) return false;
      for (const key of uniqueKeys) ensure(key, at).inFlight += 1;
      return true;
    },
    finish(keys, { failed }) {
      const at = now();
      for (const key of keys) {
        const entry = entries.get(key);
        if (entry && entry.inFlight > 0) entry.inFlight -= 1;
        if (failed) {
          recordAt(key, at);
          continue;
        }
        const remaining = current(key, at);
        if (remaining && remaining.failures === 0 && remaining.inFlight === 0) {
          entries.delete(key);
        }
      }
    },
    recordFailure(keys) {
      const at = now();
      for (const key of keys) recordAt(key, at);
    },
    clear(keys) {
      for (const key of keys) {
        const entry = entries.get(key);
        if (!entry) continue;
        if (entry.inFlight > 0) {
          entry.failures = 0;
          entry.nextAllowedAt = 0;
        } else {
          entries.delete(key);
        }
      }
    },
    get size() {
      return entries.size;
    },
  };
};

const tokenDigest = (token) => createHash("sha256").update(token, "utf8").digest("base64url");

// Device tokens are stored as PBKDF2 hashes, which costs tens of milliseconds
// per configured hash. Successful verifications are cached by token digest
// with a sliding TTL so legitimate clients pay that cost about once per hour,
// and each client may only trigger a bounded number of failed verifications
// per window; once limited, uncached tokens are refused before any PBKDF2 work
// while cached valid tokens keep working.
export const createDeviceTokenGuard = ({
  tokenHashes,
  verify = verifyPassword,
  now = Date.now,
  cacheTtlMs = 60 * 60 * 1000,
  maxCacheEntries = 1000,
  maxFailures = 10,
  failureWindowMs = 10 * 60 * 1000,
  maxClientEntries = 5000,
}) => {
  const hashes = [...tokenHashes];
  const verified = new Map();
  const pending = new Map();
  const failures = createFailureLimiter({
    maxFailures,
    windowMs: failureWindowMs,
    maxEntries: maxClientEntries,
    now,
  });

  const isCached = (digest) => {
    const expiresAt = verified.get(digest);
    if (expiresAt === undefined) return false;
    verified.delete(digest);
    const at = now();
    if (expiresAt <= at) return false;
    verified.set(digest, at + cacheTtlMs);
    return true;
  };

  const remember = (digest) => {
    verified.delete(digest);
    verified.set(digest, now() + cacheTtlMs);
    while (verified.size > maxCacheEntries) {
      verified.delete(verified.keys().next().value);
    }
  };

  const verifyAgainstHashes = async (token) => {
    for (const hash of hashes) {
      if (await verify(token, hash)) return true;
    }
    return false;
  };

  // Concurrent requests carrying the same token share one verification.
  const startVerification = (digest, token) => {
    const verification = verifyAgainstHashes(token)
      .catch(() => false)
      .then((valid) => {
        if (valid) remember(digest);
        return valid;
      })
      .finally(() => pending.delete(digest));
    pending.set(digest, verification);
    return verification;
  };

  return {
    async authenticate(token, clientKey) {
      if (!token || !hashes.length) return { ok: false, limited: false };
      const digest = tokenDigest(token);
      if (isCached(digest)) return { ok: true, limited: false };

      const keys = [String(clientKey || "unknown")];
      const limit = failures.check(keys);
      if (limit.limited) {
        return {
          ok: false,
          limited: true,
          retryAfterSeconds: toRetryAfterSeconds(limit.retryAfterMs),
        };
      }

      const inFlight = pending.get(digest);
      if (inFlight) {
        const valid = await inFlight;
        if (!valid) failures.recordFailure(keys);
        return { ok: valid, limited: false };
      }

      failures.begin(keys);
      let valid = false;
      try {
        valid = await startVerification(digest, token);
      } finally {
        failures.finish(keys, { failed: !valid });
      }
      return { ok: valid, limited: false };
    },
  };
};
