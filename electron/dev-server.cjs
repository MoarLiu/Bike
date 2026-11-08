const DEV_SERVER_URL_ENV = "VITE_DEV_SERVER_URL";

const builtRenderer = (warning = null) => ({
  isDev: false,
  url: null,
  origin: null,
  warning,
});

// Decides whether the Electron shell loads the Vite dev server or the built
// dist/index.html. Dev mode needs an explicit http(s) VITE_DEV_SERVER_URL on an
// unpackaged app; packaged builds always ignore the variable.
const resolveDevServer = ({ env, isPackaged }) => {
  if (isPackaged) return builtRenderer();
  const raw = String(env?.[DEV_SERVER_URL_ENV] ?? "").trim();
  if (!raw) return builtRenderer();

  let url;
  try {
    url = new URL(raw);
  } catch {
    return builtRenderer(
      `Ignoring ${DEV_SERVER_URL_ENV}=${JSON.stringify(raw)}: not a valid URL. Loading the built dist/index.html instead.`,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return builtRenderer(
      `Ignoring ${DEV_SERVER_URL_ENV}=${JSON.stringify(raw)}: only http:// and https:// URLs are supported. Loading the built dist/index.html instead.`,
    );
  }
  return { isDev: true, url: url.href, origin: url.origin, warning: null };
};

module.exports = {
  DEV_SERVER_URL_ENV,
  resolveDevServer,
};
