import {
  PASSWORD_HASH_ITERATIONS,
  SESSION_COOKIE_NAME,
} from "./constants.js";

const hmacKeyCache = new Map();

export async function getAdminSession(request, sessionSecret, expectedRevision = null) {
  const cookieHeader = request.headers.get("cookie") || "";
  const cookies = parseCookies(cookieHeader);
  const token = cookies[SESSION_COOKIE_NAME];
  if (!token) return { valid: false };
  return verifySessionToken(token, sessionSecret, expectedRevision);
}

export function buildSessionCookie({ name, value, path, maxAge, secure = true }) {
  const parts = [
    `${name}=${value}`,
    `Path=${path}`,
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAge}`,
  ];
  if (secure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

export async function createSessionToken(secret, ttlSeconds, revision = 0) {
  const safeRevision = Number.isInteger(revision) && revision >= 0 ? revision : 0;
  const payload = base64UrlEncodeUtf8(
    JSON.stringify({
      csrf: crypto.randomUUID(),
      exp: Math.floor(Date.now() / 1000) + ttlSeconds,
      nonce: crypto.randomUUID(),
      rev: safeRevision,
    })
  );
  const signature = await signText(secret, payload);
  return `${payload}.${signature}`;
}

export async function createPasswordRecord(password) {
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derivePasswordHash(password, saltBytes, PASSWORD_HASH_ITERATIONS);
  return {
    hash,
    iterations: PASSWORD_HASH_ITERATIONS,
    salt: base64UrlEncodeBytes(saltBytes),
  };
}

export async function verifyPassword(password, record) {
  const iterations = Number(record?.iterations);
  const salt = base64UrlDecodeBytes(String(record?.salt || ""));
  if (!Number.isInteger(iterations) || iterations < 10000 || !salt.length) {
    return false;
  }
  const actualHash = await derivePasswordHash(password, salt, iterations);
  return safeStringEqual(actualHash, String(record?.hash || ""));
}

export function safeStringEqual(a, b) {
  const left = String(a || "");
  const right = String(b || "");
  let mismatch = 0;
  const length = Math.max(left.length, right.length);
  mismatch |= left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    mismatch |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return mismatch === 0;
}

function parseCookies(cookieHeader) {
  const out = {};
  for (const entry of cookieHeader.split(";")) {
    const [rawName, ...rawValue] = entry.trim().split("=");
    if (!rawName) continue;
    out[rawName] = rawValue.join("=");
  }
  return out;
}

async function verifySessionToken(token, secret, expectedRevision) {
  const [payload, signature] = String(token || "").split(".");
  if (!payload || !signature) return { valid: false };

  const expectedSignature = await signText(secret, payload);
  if (!safeStringEqual(signature, expectedSignature)) return { valid: false };

  try {
    const parsed = JSON.parse(base64UrlDecodeUtf8(payload));
    if (!parsed?.exp || parsed.exp < Math.floor(Date.now() / 1000)) {
      return { valid: false };
    }
    const csrf = typeof parsed?.csrf === "string" && parsed.csrf ? parsed.csrf : "";
    if (!csrf) return { valid: false };
    const tokenRevision = Number.isInteger(parsed?.rev) && parsed.rev >= 0 ? parsed.rev : 0;
    if (Number.isInteger(expectedRevision) && tokenRevision !== expectedRevision) {
      return { valid: false };
    }
    return { valid: true, csrf, exp: parsed.exp, rev: tokenRevision };
  } catch {
    return { valid: false };
  }
}

async function signText(secret, text) {
  const key = await getHmacKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text));
  return base64UrlEncodeBytes(new Uint8Array(signature));
}

function getHmacKey(secret) {
  const cacheKey = String(secret || "");
  if (!hmacKeyCache.has(cacheKey)) {
    hmacKeyCache.set(
      cacheKey,
      crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(cacheKey),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
      )
    );
  }
  return hmacKeyCache.get(cacheKey);
}

function base64UrlEncodeUtf8(value) {
  return base64UrlEncodeBytes(new TextEncoder().encode(value));
}

function base64UrlEncodeBytes(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecodeUtf8(value) {
  let normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  while (normalized.length % 4) normalized += "=";

  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new TextDecoder().decode(bytes);
}

function base64UrlDecodeBytes(value) {
  let normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  while (normalized.length % 4) normalized += "=";

  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function derivePasswordHash(password, saltBytes, iterations) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(String(password || "")),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      iterations,
      salt: saltBytes,
    },
    key,
    256
  );
  return base64UrlEncodeBytes(new Uint8Array(bits));
}
