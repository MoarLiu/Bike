import { pbkdf2, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";

const defaultIterations = 310000;

export const isPbkdf2Hash = (value) =>
  typeof value === "string" && value.startsWith("pbkdf2$");

export const createSecretHash = (secret, { iterations = defaultIterations } = {}) => {
  const salt = randomBytes(18).toString("base64url");
  const hash = pbkdf2Sync(secret, salt, iterations, 32, "sha256").toString(
    "base64url",
  );
  return `pbkdf2$${iterations}$${salt}$${hash}`;
};

export const createSessionSecret = () => randomBytes(32).toString("base64url");

export const createDeviceToken = () => randomBytes(24).toString("base64url");

export const verifyPassword = (password, passwordHash) => {
  const [scheme, iterationText, salt, expectedHash] = String(passwordHash).split("$");
  if (scheme !== "pbkdf2" || !iterationText || !salt || !expectedHash) {
    return false;
  }
  const iterations = Number(iterationText);
  if (!Number.isFinite(iterations) || iterations < 100000) return false;
  return new Promise((resolve) => {
    pbkdf2(password, salt, iterations, 32, "sha256", (error, derivedKey) => {
      if (error) {
        resolve(false);
        return;
      }
      const actualBuffer = Buffer.from(derivedKey.toString("base64url"));
      const expectedBuffer = Buffer.from(expectedHash);
      resolve(
        actualBuffer.length === expectedBuffer.length &&
          timingSafeEqual(actualBuffer, expectedBuffer),
      );
    });
  });
};
