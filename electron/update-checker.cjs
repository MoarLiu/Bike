const DEFAULT_RELEASES_API_URL = "https://api.github.com/repos/MoarLiu/Bike/releases/latest";
const DEFAULT_RELEASES_PAGE_URL = "https://github.com/MoarLiu/Bike/releases";

const normalizeVersion = (value) =>
  String(value ?? "")
    .trim()
    .replace(/^v/i, "")
    .split(/[+-]/)[0];

const parseVersionParts = (value) => {
  const normalized = normalizeVersion(value);
  if (!/^\d+(?:\.\d+){0,3}$/.test(normalized)) return null;
  return normalized.split(".").map((part) => Number.parseInt(part, 10));
};

const compareVersions = (left, right) => {
  const leftParts = parseVersionParts(left);
  const rightParts = parseVersionParts(right);
  if (!leftParts || !rightParts) return 0;
  const length = Math.max(leftParts.length, rightParts.length, 3);
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index] ?? 0;
    const rightPart = rightParts[index] ?? 0;
    if (leftPart > rightPart) return 1;
    if (leftPart < rightPart) return -1;
  }
  return 0;
};

const releaseVersion = (release) => {
  const candidate = release?.tag_name || release?.name || "";
  return normalizeVersion(candidate);
};

const resultFromRelease = ({ currentVersion, release, releasesPageUrl = DEFAULT_RELEASES_PAGE_URL }) => {
  const latestVersion = releaseVersion(release);
  if (!latestVersion || !parseVersionParts(latestVersion)) {
    throw new Error("发布信息里没有可识别的版本号");
  }
  return {
    ok: true,
    currentVersion,
    latestVersion,
    updateAvailable: compareVersions(latestVersion, currentVersion) > 0,
    releaseName: typeof release.name === "string" && release.name.trim()
      ? release.name.trim()
      : `v${latestVersion}`,
    releaseUrl: typeof release.html_url === "string" && release.html_url
      ? release.html_url
      : releasesPageUrl,
    publishedAt: typeof release.published_at === "string" ? release.published_at : "",
  };
};

const fetchLatestRelease = async ({
  fetchImpl = globalThis.fetch,
  currentVersion,
  releasesApiUrl = DEFAULT_RELEASES_API_URL,
  releasesPageUrl = DEFAULT_RELEASES_PAGE_URL,
  timeoutMs = 15_000,
} = {}) => {
  if (typeof fetchImpl !== "function") {
    throw new Error("当前运行环境不支持网络请求");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(releasesApiUrl, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": `Bike/${currentVersion || "unknown"}`,
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      if (response.status === 404) {
        throw new Error("没有找到可用的发布信息");
      }
      throw new Error(`更新检查失败：HTTP ${response.status}`);
    }
    const release = await response.json();
    return resultFromRelease({ currentVersion, release, releasesPageUrl });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("检查更新超时，请稍后重试");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
};

module.exports = {
  DEFAULT_RELEASES_API_URL,
  DEFAULT_RELEASES_PAGE_URL,
  compareVersions,
  fetchLatestRelease,
  normalizeVersion,
  parseVersionParts,
  resultFromRelease,
};
