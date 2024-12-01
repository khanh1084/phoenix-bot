import dotenv from "dotenv";

dotenv.config();

export function getPrivateKeyFromEnv(): string {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    throw new Error("Private key not found in .env file");
  }
  return privateKey;
}
