import dotenv from "dotenv";
dotenv.config();

export function getPrivateKeysFromEnv(): string[] {
  const privateKeys = process.env.PRIVATE_KEYS;
  if (!privateKeys) {
    throw new Error("PRIVATE_KEYS environment variable is not set");
  }
  return privateKeys.split(",");
}
