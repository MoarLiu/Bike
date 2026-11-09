const { execFileSync } = require("node:child_process");
const path = require("node:path");

exports.default = async (context) => {
  if (context.electronPlatformName !== "darwin") return;
  if (process.env.BIKE_SIGNED_RELEASE === "1") return;

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);

  execFileSync(
    "codesign",
    ["--force", "--deep", "--sign", "-", appPath],
    { stdio: "inherit" },
  );
};
