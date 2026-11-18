// Sign-in keys.
//
// Each person has a secret sign-in key (25 characters, ~125 bits), made on
// their phone and sent as "Authorization: Bearer <key>". The server never
// stores the key: a person's id is a hash of it. So sharing your id with your
// partner (as linking does) never lets them act as you.
//
// The same key signs you in on another phone. Lose it and the account is gone,
// which is why the page asks people to save it.

import { createHash } from "node:crypto";
import { PairingError } from "./pairing.js";

export const KEY_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32
export const KEY_LENGTH = 25;

export function normalizeKey(input) {
  return String(input ?? "").toUpperCase().replace(/[^0-9A-Z]/g, "")
    .replace(/O/g, "0").replace(/[IL]/g, "1").replace(/U/g, "V");
}

export function isValidKey(key) {
  return key.length === KEY_LENGTH && [...key].every(c => KEY_ALPHABET.includes(c));
}

export function userIdFromKey(key) {
  return "u_" + createHash("sha256").update("love-better:" + key).digest("hex").slice(0, 32);
}

export function userIdFromRequest(req) {
  const h = String(req.headers.authorization || "");
  const m = /^Bearer\s+(.+)$/i.exec(h);
  const key = m ? normalizeKey(m[1]) : "";
  if (!isValidKey(key)) throw new PairingError("unauthenticated", "Missing or invalid sign-in key.", 401);
  return userIdFromKey(key);
}
