import fs from "node:fs";

export function readApiKey(keyFile = process.env.TYPESAFE_KEY_FILE) {
  const file =
    keyFile || new URL("../../work/secrets/typesafe.key", import.meta.url);
  const key = (
    process.env.TYPESAFE_API_KEY ||
    (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "")
  ).trim();
  if (!key)
    throw new Error(
      "Set TYPESAFE_API_KEY or TYPESAFE_KEY_FILE before making API requests.",
    );
  return key;
}
