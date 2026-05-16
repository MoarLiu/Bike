import { pbkdf2Sync, randomBytes } from "node:crypto";

const password = process.argv[2];

if (!password) {
  console.error("用法：npm run auth:hash -- \"你的登录密码\"");
  process.exit(1);
}

const iterations = 310000;
const salt = randomBytes(18).toString("base64url");
const hash = pbkdf2Sync(password, salt, iterations, 32, "sha256").toString(
  "base64url",
);
const sessionSecret = randomBytes(32).toString("base64url");

console.log(
  JSON.stringify(
    {
      passwordHash: `pbkdf2$${iterations}$${salt}$${hash}`,
      sessionSecret,
    },
    null,
    2,
  ),
);
