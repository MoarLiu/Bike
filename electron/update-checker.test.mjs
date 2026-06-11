import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  compareVersions,
  fetchLatestRelease,
  normalizeVersion,
  resultFromRelease,
} = require("./update-checker.cjs");

test("normalizes version tags", () => {
  assert.equal(normalizeVersion("v1.3.3"), "1.3.3");
  assert.equal(normalizeVersion("1.3.3+build.7"), "1.3.3");
  assert.equal(normalizeVersion("  V2.0.0-beta.1 "), "2.0.0");
});

test("compares semantic version numbers", () => {
  assert.equal(compareVersions("1.3.3", "1.3.2"), 1);
  assert.equal(compareVersions("1.3", "1.3.0"), 0);
  assert.equal(compareVersions("1.2.9", "1.3.0"), -1);
});

test("detects whether a newer release is available", () => {
  const result = resultFromRelease({
    currentVersion: "1.3.2",
    release: {
      tag_name: "v1.3.3",
      name: "Bike 1.3.3",
      html_url: "https://example.com/releases/v1.3.3",
      published_at: "2026-06-11T00:00:00Z",
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.latestVersion, "1.3.3");
  assert.equal(result.updateAvailable, true);
  assert.equal(result.releaseName, "Bike 1.3.3");
});

test("fetchLatestRelease uses the provided fetch implementation", async () => {
  const result = await fetchLatestRelease({
    currentVersion: "1.3.2",
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ tag_name: "v1.3.2", html_url: "https://example.com/releases" }),
    }),
  });

  assert.equal(result.latestVersion, "1.3.2");
  assert.equal(result.updateAvailable, false);
});
