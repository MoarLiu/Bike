import process from "node:process";
import { createSecretHash, createSessionSecret } from "../server/password.mjs";

const readPasswordFromStdin = async () => {
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
  }

  process.stdout.write("输入登录密码（不会回显）：");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  return await new Promise((resolve, reject) => {
    let password = "";
    const cleanup = () => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
    };

    const onData = (char) => {
      if (char === "\u0003") {
        cleanup();
        reject(new Error("已取消"));
        return;
      }
      if (char === "\r" || char === "\n") {
        cleanup();
        resolve(password);
        return;
      }
      if (char === "\u007f" || char === "\b") {
        password = password.slice(0, -1);
        return;
      }
      password += char;
    };

    process.stdin.on("data", onData);
  });
};

const password = await readPasswordFromStdin();

if (!password) {
  console.error("密码不能为空。用法：printf '%s' '你的登录密码' | npm run auth:hash");
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      passwordHash: createSecretHash(password),
      sessionSecret: createSessionSecret(),
    },
    null,
    2,
  ),
);
