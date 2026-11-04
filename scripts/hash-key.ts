/**
 * Prints the SHA-256 of a virtual key, for the `keyHash` field in config.
 *   npm run hash-key -- my-new-secret-key
 * Tip: generate a random key with `openssl rand -hex 24`.
 */
import { hashKey } from "../src/auth.js";

const secret = process.argv[2];
if (!secret) {
  console.error("Usage: npm run hash-key -- <secret>");
  process.exit(1);
}
console.log(hashKey(secret));
