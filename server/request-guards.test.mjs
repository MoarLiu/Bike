import assert from "node:assert/strict";
import test from "node:test";
import {
  bearerTokenFrom,
  createDeviceTokenGuard,
  createFailureLimiter,
  loginAttemptKeys,
  normalizeOptionalBoolean,
  normalizeTrustedProxyCount,
  resolveClientAddress,
} from "./request-guards.mjs";

const fakeRequest = ({ remoteAddress = "10.0.0.1", forwardedFor, authorization } = {}) => ({
  socket: { remoteAddress },
  headers: {
    ...(forwardedFor === undefined ? {} : { "x-forwarded-for": forwardedFor }),
    ...(authorization === undefined ? {} : { authorization }),
  },
});

const trustOneProxy = { trustProxyHeaders: true, trustedProxyCount: 1 };

test("client address ignores X-Forwarded-For unless proxy headers are trusted", () => {
  const request = fakeRequest({ forwardedFor: "1.2.3.4, 203.0.113.10" });
  assert.equal(resolveClientAddress(request), "10.0.0.1");
  assert.equal(resolveClientAddress(request, { trustProxyHeaders: false }), "10.0.0.1");
});

test("client address is the entry appended by the trusted proxy", () => {
  const address = (forwardedFor, options = trustOneProxy) =>
    resolveClientAddress(fakeRequest({ forwardedFor }), options);

  assert.equal(address("203.0.113.10"), "203.0.113.10");
  assert.equal(address("1.2.3.4, 203.0.113.10"), "203.0.113.10");
  assert.equal(address("1.2.3.4,203.0.113.10 "), "203.0.113.10");
  assert.equal(address("1.2.3.4, , 203.0.113.10"), "203.0.113.10");
  assert.equal(address(["1.2.3.4", "203.0.113.10"]), "203.0.113.10");

  const twoProxies = { trustProxyHeaders: true, trustedProxyCount: 2 };
  assert.equal(address("1.2.3.4, 198.51.100.7, 10.0.0.2", twoProxies), "198.51.100.7");
  // Fewer entries than trusted proxies: fall back to the leftmost entry.
  assert.equal(address("198.51.100.7", twoProxies), "198.51.100.7");
});

test("client address falls back to the socket when the header is missing or empty", () => {
  assert.equal(resolveClientAddress(fakeRequest(), trustOneProxy), "10.0.0.1");
  assert.equal(resolveClientAddress(fakeRequest({ forwardedFor: "" }), trustOneProxy), "10.0.0.1");
  assert.equal(resolveClientAddress(fakeRequest({ forwardedFor: " , " }), trustOneProxy), "10.0.0.1");
  assert.equal(
    resolveClientAddress({ socket: {}, headers: {} }, trustOneProxy),
    "unknown",
  );
});

test("spoofed X-Forwarded-For prefixes share one login limiter key", () => {
  const keysFor = (forwardedFor) =>
    loginAttemptKeys({
      clientAddress: resolveClientAddress(fakeRequest({ forwardedFor }), trustOneProxy),
      username: "owner",
    });
  const first = keysFor("1.2.3.4, 203.0.113.10");
  const second = keysFor("5.6.7.8, 203.0.113.10");
  assert.deepEqual(first, ["ip:203.0.113.10:owner", "user:owner"]);
  assert.deepEqual(second, first);

  // Only the IP scope, to show it alone is shared.
  const limiter = createFailureLimiter({ maxFailures: 1, windowMs: 60_000, maxEntries: 10 });
  limiter.recordFailure([first[0]]);
  assert.equal(limiter.check([second[0]]).limited, true);
  assert.equal(limiter.check([keysFor("5.6.7.8, 203.0.113.99")[0]]).limited, false);
});

test("devices with a valid device cookie only use their own limiter key", () => {
  assert.deepEqual(
    loginAttemptKeys({ deviceId: "device-a", clientAddress: "203.0.113.10", username: "owner" }),
    ["device:device-a"],
  );
});

test("trustedProxyCount must be a positive integer", () => {
  assert.equal(normalizeTrustedProxyCount(undefined), 1);
  assert.equal(normalizeTrustedProxyCount(null), 1);
  assert.equal(normalizeTrustedProxyCount(1), 1);
  assert.equal(normalizeTrustedProxyCount(3), 3);
  for (const value of [0, -1, 1.5, "2", true, Number.NaN]) {
    assert.throws(() => normalizeTrustedProxyCount(value, "auth.trustedProxyCount"), /auth\.trustedProxyCount/);
  }
});

test("optional booleans reject non-boolean values", () => {
  assert.equal(normalizeOptionalBoolean(undefined, "trustProxyHeaders"), false);
  assert.equal(normalizeOptionalBoolean(null, "trustProxyHeaders"), false);
  assert.equal(normalizeOptionalBoolean(true, "trustProxyHeaders"), true);
  assert.equal(normalizeOptionalBoolean(false, "trustProxyHeaders"), false);
  assert.throws(() => normalizeOptionalBoolean("false", "trustProxyHeaders"), /trustProxyHeaders/);
});

test("bearer tokens are read from the Authorization header", () => {
  assert.equal(bearerTokenFrom(fakeRequest({ authorization: "Bearer abc.def" })), "abc.def");
  assert.equal(bearerTokenFrom(fakeRequest({ authorization: "bearer abc" })), "abc");
  assert.equal(bearerTokenFrom(fakeRequest({ authorization: "Basic abc" })), "");
  assert.equal(bearerTokenFrom(fakeRequest()), "");
});

test("failure limiter delays after failures and exhausts within the window", () => {
  let clock = 0;
  const limiter = createFailureLimiter({
    maxFailures: 3,
    windowMs: 60_000,
    maxEntries: 10,
    delayMs: (failures) => failures * 1000,
    now: () => clock,
  });
  const keys = ["user:owner"];

  assert.deepEqual(limiter.check(keys), { limited: false, retryAfterMs: 0 });
  limiter.recordFailure(keys);
  assert.deepEqual(limiter.check(keys), { limited: true, retryAfterMs: 1000 });
  clock = 1000;
  assert.equal(limiter.check(keys).limited, false);
  limiter.recordFailure(keys);
  assert.deepEqual(limiter.check(keys), { limited: true, retryAfterMs: 2000 });
  clock = 3000;
  assert.equal(limiter.check(keys).limited, false);
  limiter.recordFailure(keys);
  // Exhausted: blocked until the window that started at t=0 ends.
  assert.deepEqual(limiter.check(keys), { limited: true, retryAfterMs: 57_000 });
  clock = 59_999;
  assert.equal(limiter.check(keys).limited, true);
  clock = 60_000;
  assert.equal(limiter.check(keys).limited, false);
  assert.equal(limiter.size, 0);
});

test("failure limiter is limited when any key is limited", () => {
  const limiter = createFailureLimiter({ maxFailures: 1, windowMs: 60_000, maxEntries: 10 });
  limiter.recordFailure(["ip:203.0.113.10:owner"]);
  assert.equal(limiter.check(["ip:198.51.100.1:owner", "user:owner"]).limited, false);
  assert.equal(limiter.check(["ip:203.0.113.10:owner", "user:owner"]).limited, true);
});

test("failure limiter counts verifications that are still in flight", () => {
  let clock = 0;
  const limiter = createFailureLimiter({
    maxFailures: 2,
    windowMs: 60_000,
    maxEntries: 10,
    now: () => clock,
  });
  const keys = ["client"];
  limiter.begin(keys);
  assert.equal(limiter.check(keys).limited, false);
  limiter.begin(keys);
  assert.deepEqual(limiter.check(keys), { limited: true, retryAfterMs: 1000 });
  limiter.finish(keys, { failed: false });
  limiter.finish(keys, { failed: false });
  assert.equal(limiter.check(keys).limited, false);
  assert.equal(limiter.size, 0);

  limiter.begin(keys);
  limiter.finish(keys, { failed: true });
  assert.equal(limiter.check(keys).limited, false);
  limiter.begin(keys);
  assert.equal(limiter.check(keys).limited, true);
  limiter.finish(keys, { failed: true });
  assert.deepEqual(limiter.check(keys), { limited: true, retryAfterMs: 60_000 });
});

test("clearing a key forgets its failures", () => {
  const limiter = createFailureLimiter({ maxFailures: 1, windowMs: 60_000, maxEntries: 10 });
  limiter.recordFailure(["user:owner"]);
  assert.equal(limiter.check(["user:owner"]).limited, true);
  limiter.clear(["user:owner"]);
  assert.equal(limiter.check(["user:owner"]).limited, false);
  assert.equal(limiter.size, 0);
});

test("failure limiter stays within maxEntries by dropping the oldest windows", () => {
  let clock = 0;
  const limiter = createFailureLimiter({
    maxFailures: 1,
    windowMs: 60_000,
    maxEntries: 3,
    now: () => clock,
  });
  for (const key of ["a", "b", "c", "d", "e"]) {
    limiter.recordFailure([key]);
    clock += 1;
    assert.ok(limiter.size <= 3);
  }
  assert.equal(limiter.check(["a"]).limited, false);
  assert.equal(limiter.check(["b"]).limited, false);
  assert.equal(limiter.check(["e"]).limited, true);

  // Expired windows are reclaimed before live ones are evicted.
  clock = 120_000;
  limiter.recordFailure(["f"]);
  assert.equal(limiter.size, 1);
});

const countingVerifier = (validTokens) => {
  const calls = [];
  return {
    calls,
    verify: async (token, hash) => {
      calls.push([token, hash]);
      return validTokens.get(hash) === token;
    },
  };
};

test("device token guard caches successful verifications with a sliding TTL", async () => {
  let clock = 0;
  const { calls, verify } = countingVerifier(new Map([["hash-b", "good token"]]));
  const guard = createDeviceTokenGuard({
    tokenHashes: ["hash-a", "hash-b"],
    verify,
    now: () => clock,
    cacheTtlMs: 60_000,
  });

  assert.deepEqual(await guard.authenticate("good token", "client-1"), { ok: true, limited: false });
  assert.equal(calls.length, 2);
  assert.deepEqual(await guard.authenticate("good token", "client-2"), { ok: true, limited: false });
  clock = 50_000;
  assert.equal((await guard.authenticate("good token", "client-1")).ok, true);
  clock = 100_000;
  assert.equal((await guard.authenticate("good token", "client-1")).ok, true);
  assert.equal(calls.length, 2);

  // Idle for longer than the TTL: verified again.
  clock = 170_000;
  assert.equal((await guard.authenticate("good token", "client-1")).ok, true);
  assert.equal(calls.length, 4);
});

test("device token guard refuses limited clients before PBKDF2 but keeps cached tokens working", async () => {
  let clock = 0;
  const { calls, verify } = countingVerifier(new Map([["hash-a", "good token"]]));
  const guard = createDeviceTokenGuard({
    tokenHashes: ["hash-a"],
    verify,
    now: () => clock,
  });

  assert.equal((await guard.authenticate("good token", "203.0.113.50")).ok, true);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    assert.deepEqual(
      await guard.authenticate(`wrong ${attempt}`, "203.0.113.50"),
      { ok: false, limited: false },
    );
  }
  assert.equal(calls.length, 11);

  assert.deepEqual(await guard.authenticate("wrong again", "203.0.113.50"), {
    ok: false,
    limited: true,
    retryAfterSeconds: 600,
  });
  assert.equal(calls.length, 11);

  assert.deepEqual(await guard.authenticate("good token", "203.0.113.50"), {
    ok: true,
    limited: false,
  });
  assert.equal(calls.length, 11);

  // Other clients are unaffected.
  assert.deepEqual(await guard.authenticate("wrong", "198.51.100.1"), { ok: false, limited: false });
  assert.equal(calls.length, 12);

  // The window ends ten minutes after the first failure.
  clock = 10 * 60 * 1000;
  assert.deepEqual(await guard.authenticate("wrong", "203.0.113.50"), { ok: false, limited: false });
  assert.equal(calls.length, 13);
});

test("device token guard bounds concurrent verifications per client", async () => {
  const releases = [];
  let calls = 0;
  const guard = createDeviceTokenGuard({
    tokenHashes: ["hash-a"],
    verify: async () => {
      calls += 1;
      await new Promise((resolve) => releases.push(resolve));
      return false;
    },
  });

  const attempts = Array.from({ length: 15 }, (_, index) =>
    guard.authenticate(`wrong ${index}`, "203.0.113.50"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 10);
  releases.forEach((release) => release());
  const results = await Promise.all(attempts);
  assert.equal(results.filter((result) => result.limited).length, 5);
  assert.equal(calls, 10);
});

test("device token guard shares one verification between concurrent requests for a token", async () => {
  let release;
  let calls = 0;
  const guard = createDeviceTokenGuard({
    tokenHashes: ["hash-a"],
    verify: async (token) => {
      calls += 1;
      await new Promise((resolve) => {
        release = resolve;
      });
      return token === "good token";
    },
  });

  const attempts = Array.from({ length: 20 }, () =>
    guard.authenticate("good token", "203.0.113.50"));
  await new Promise((resolve) => setImmediate(resolve));
  release();
  const results = await Promise.all(attempts);
  assert.ok(results.every((result) => result.ok));
  assert.equal(calls, 1);
});

test("device token guard bounds its cache", async () => {
  let clock = 0;
  const tokens = new Map([
    ["hash-a", "token a"],
    ["hash-b", "token b"],
    ["hash-c", "token c"],
  ]);
  const { calls, verify } = countingVerifier(tokens);
  const guard = createDeviceTokenGuard({
    tokenHashes: [...tokens.keys()],
    verify,
    now: () => clock,
    maxCacheEntries: 2,
  });
  for (const token of ["token a", "token b", "token c"]) {
    assert.equal((await guard.authenticate(token, "client")).ok, true);
  }
  const before = calls.length;
  assert.equal((await guard.authenticate("token c", "client")).ok, true);
  assert.equal(calls.length, before);
  // "token a" was the least recently used entry and has been evicted.
  assert.equal((await guard.authenticate("token a", "client")).ok, true);
  assert.ok(calls.length > before);
});

test("device token guard rejects without verifying when nothing is configured", async () => {
  let calls = 0;
  const guard = createDeviceTokenGuard({
    tokenHashes: [],
    verify: async () => {
      calls += 1;
      return true;
    },
  });
  assert.deepEqual(await guard.authenticate("anything", "client"), { ok: false, limited: false });
  const configured = createDeviceTokenGuard({
    tokenHashes: ["hash-a"],
    verify: async () => {
      calls += 1;
      return true;
    },
  });
  assert.deepEqual(await configured.authenticate("", "client"), { ok: false, limited: false });
  assert.equal(calls, 0);
});
