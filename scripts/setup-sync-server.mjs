#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  createDeviceToken,
  createSecretHash,
} from "../server/password.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const configPath = process.env.BIKE_SYNC_CONFIG
  ? path.resolve(process.env.BIKE_SYNC_CONFIG)
  : path.join(projectRoot, "config", "bike-sync.config.json");
const dataDir = path.join(projectRoot, "data");
const pidPath = path.join(dataDir, "bike-sync-server.pid");
const logPath = path.join(dataDir, "bike-sync-server.log");

let rl;
let scriptedAnswers;

const getReadline = () => {
  rl ??= createInterface({ input, output });
  return rl;
};

const closeReadline = () => {
  rl?.close();
  rl = undefined;
};

const readScriptedAnswers = async () => {
  if (scriptedAnswers) return scriptedAnswers;
  let text = "";
  for await (const chunk of input) {
    text += chunk;
  }
  scriptedAnswers = text.split(/\r?\n/);
  if (scriptedAnswers.at(-1) === "") scriptedAnswers.pop();
  return scriptedAnswers;
};

const takeScriptedAnswer = async () => {
  const answers = await readScriptedAnswers();
  return answers.length ? answers.shift() ?? "" : "";
};

const defaultConfig = () => ({
  host: "127.0.0.1",
  port: 4174,
  owner: {
    username: "me",
  },
  databasePath: "data/bike-sync.sqlite",
  deviceTokenHashes: [],
  maxBodyBytes: 10485760,
  cors: {
    enabled: true,
    allowedOrigins: [
      "http://127.0.0.1:4173",
      "http://localhost:4173",
    ],
  },
});

const normalizeConfig = (config) => {
  const defaults = defaultConfig();
  return {
    ...defaults,
    ...config,
    owner: {
      ...defaults.owner,
      ...(config.owner && typeof config.owner === "object" ? config.owner : {}),
    },
    deviceTokenHashes: Array.isArray(config.deviceTokenHashes)
      ? config.deviceTokenHashes
      : [],
    cors: {
      ...defaults.cors,
      ...(config.cors && typeof config.cors === "object" ? config.cors : {}),
      allowedOrigins: Array.isArray(config.cors?.allowedOrigins)
        ? config.cors.allowedOrigins
        : defaults.cors.allowedOrigins,
    },
  };
};

const loadConfig = async () => {
  try {
    return normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  } catch {
    return defaultConfig();
  }
};

const saveConfig = async (config) => {
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(`${configPath}.tmp`, `${JSON.stringify(normalizeConfig(config), null, 2)}\n`, "utf8");
  await rename(`${configPath}.tmp`, configPath);
};

const ask = async (question, fallback = "") => {
  const suffix = fallback ? ` [${fallback}]` : "";
  if (!input.isTTY) {
    const answer = (await takeScriptedAnswer()).trim();
    output.write(`${question}${suffix}: ${answer}\n`);
    return answer || fallback;
  }
  const answer = (await getReadline().question(`${question}${suffix}: `)).trim();
  return answer || fallback;
};

const askHidden = async (question) => {
  if (!input.isTTY) {
    const answer = (await takeScriptedAnswer()).trim();
    output.write(`${question}: \n`);
    return answer;
  }
  closeReadline();
  output.write(`${question}: `);
  input.setRawMode(true);
  input.resume();
  input.setEncoding("utf8");
  return await new Promise((resolve, reject) => {
    let value = "";
    const cleanup = () => {
      input.off("data", onData);
      input.setRawMode(false);
      input.pause();
      output.write("\n");
    };
    const onData = (char) => {
      if (char === "\u0003") {
        cleanup();
        reject(new Error("已取消"));
        return;
      }
      if (char === "\r" || char === "\n") {
        cleanup();
        resolve(value.trim());
        return;
      }
      if (char === "\u007f" || char === "\b") {
        value = value.slice(0, -1);
        return;
      }
      value += char;
    };
    input.on("data", onData);
  });
};

const askPort = async (fallback) => {
  while (true) {
    const answer = Number(await ask("同步端口", String(fallback)));
    if (Number.isInteger(answer) && answer > 0 && answer < 65536) return answer;
    console.log("请输入 1-65535 之间的端口。");
  }
};

const askNumber = async (question, fallback) => {
  while (true) {
    const answer = Number(await ask(question, String(fallback)));
    if (Number.isFinite(answer) && answer > 0) return Math.round(answer);
    console.log("请输入正整数。");
  }
};

const askYesNo = async (question, fallback = true) => {
  const answer = (await ask(question, fallback ? "Y" : "N")).toLowerCase();
  return answer === "y" || answer === "yes" || answer === "是";
};

const configure = async () => {
  const config = await loadConfig();
  config.host = await ask("监听地址", config.host);
  config.port = await askPort(config.port);
  config.owner.username = await ask("用户名", config.owner.username);
  config.databasePath = await ask("SQLite 数据库路径", config.databasePath);
  config.maxBodyBytes = await askNumber("单次请求最大字节数", config.maxBodyBytes);
  config.cors.enabled = await askYesNo("允许浏览器跨域访问同步服务", config.cors.enabled);
  if (config.cors.enabled) {
    const origins = await ask(
      "允许的 Web 来源，多个用英文逗号分隔，* 表示全部",
      config.cors.allowedOrigins.join(","),
    );
    config.cors.allowedOrigins = origins
      .split(",")
      .map((origin) => origin.trim().replace(/\/+$/, ""))
      .filter(Boolean);
  }

  await saveConfig(config);
  console.log(`已写入同步服务配置：${configPath}`);

  if (!config.deviceTokenHashes.length || await askYesNo("是否现在添加同步密钥", false)) {
    await addKey();
  }
};

const addKey = async () => {
  const config = await loadConfig();
  const name = await ask("密钥名称", `${config.owner.username}-device`);
  const mode = await ask("同步密钥来源：1=系统生成，2=自定义", "1");
  let token;
  if (mode === "2") {
    token = await askHidden("输入自定义同步密钥（不会回显）");
    if (!token) {
      console.log("同步密钥不能为空，已取消添加。");
      return;
    }
  } else {
    token = createDeviceToken();
  }

  config.deviceTokenHashes.push({
    name,
    hash: createSecretHash(token),
    createdAt: new Date().toISOString(),
  });
  await saveConfig(config);
  console.log(`已保存密钥：${name}`);
  if (mode !== "2") {
    console.log(`请立即记录系统生成的同步密钥：${token}`);
  }
};

const readPid = async () => {
  try {
    const pid = Number((await readFile(pidPath, "utf8")).trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
};

const isProcessRunning = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const startService = async () => {
  try {
    await readFile(configPath, "utf8");
  } catch {
    console.log(`未找到同步服务配置：${configPath}`);
    console.log("请先运行 npm run setup:sync -- configure");
    return;
  }

  const existingPid = await readPid();
  if (existingPid && isProcessRunning(existingPid)) {
    console.log(`同步服务已在运行，PID ${existingPid}`);
    return;
  }

  await mkdir(dataDir, { recursive: true });
  const logFile = await open(logPath, "a");
  const child = spawn(process.execPath, ["server/sync-server.mjs"], {
    cwd: projectRoot,
    detached: true,
    env: {
      ...process.env,
      BIKE_SYNC_CONFIG: configPath,
    },
    stdio: ["ignore", logFile.fd, logFile.fd],
  });
  child.unref();
  await writeFile(pidPath, `${child.pid}\n`, "utf8");
  await logFile.close();
  console.log(`同步服务已启动，PID ${child.pid}`);
  console.log(`日志文件：${logPath}`);
};

const stopService = async () => {
  const pid = await readPid();
  if (!pid) {
    console.log("没有找到同步服务 PID 文件。");
    return;
  }
  if (!isProcessRunning(pid)) {
    await rm(pidPath, { force: true });
    console.log("PID 文件已过期，已清理。");
    return;
  }

  process.kill(pid, "SIGTERM");
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (!isProcessRunning(pid)) break;
  }
  await rm(pidPath, { force: true });
  console.log(`同步服务已停止，PID ${pid}`);
};

const restartService = async () => {
  await stopService();
  await startService();
};

const statusService = async () => {
  const pid = await readPid();
  if (pid && isProcessRunning(pid)) {
    console.log(`同步服务运行中，PID ${pid}`);
    console.log(`配置文件：${configPath}`);
    console.log(`日志文件：${logPath}`);
    return;
  }
  console.log("同步服务未运行。");
};

const showMenu = async () => {
  while (true) {
    console.log("\nBike 同步服务部署");
    console.log("1. 配置同步服务");
    console.log("2. 添加同步密钥");
    console.log("3. 启动同步服务");
    console.log("4. 重启同步服务");
    console.log("5. 停止同步服务");
    console.log("6. 查看状态");
    console.log("0. 退出");
    const choice = await ask("请选择", "1");
    if (choice === "1") await configure();
    else if (choice === "2") await addKey();
    else if (choice === "3") await startService();
    else if (choice === "4") await restartService();
    else if (choice === "5") await stopService();
    else if (choice === "6") await statusService();
    else if (choice === "0") break;
    else console.log("未知选项。");
  }
};

const action = process.argv[2];

try {
  if (!action) await showMenu();
  else if (action === "configure") await configure();
  else if (action === "add-key") await addKey();
  else if (action === "start") await startService();
  else if (action === "stop") await stopService();
  else if (action === "restart") await restartService();
  else if (action === "status") await statusService();
  else {
    console.error("用法：npm run setup:sync -- [configure|add-key|start|stop|restart|status]");
    process.exitCode = 1;
  }
} finally {
  closeReadline();
}
