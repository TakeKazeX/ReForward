import {
  DEFAULT_PUBLIC_PROXY_CACHE_CONTROL,
  DEFAULT_REDIRECT_FALLBACK,
  MAX_PUBLIC_PROXY_CACHE_CONTROL_LENGTH,
  MAX_PUBLIC_PROXY_CACHE_TTL_SECONDS,
} from "./constants.js";
import { HttpError, stripOuterSlashes } from "./utils.js";

let runtimeSessionSecret = "";
let runtimeSessionSecretWarningShown = false;

export function getAppConfig(env) {
  const legacyBackendBasePath = normalizeAdminBasePath(env?.BACKEND_PATH || "");
  const explicitSessionSecret = String(env?.SESSION_SECRET || "").trim();
  const versionSessionSecret = String(env?.CF_VERSION_METADATA?.id || "").trim();
  const redirectSeed = String(env?.DEFAULT_REDIRECT_URL || "").trim();
  const sessionSecret = explicitSessionSecret || versionSessionSecret || getRuntimeSessionSecret();
  const sessionSecretMode = explicitSessionSecret ? "env" : versionSessionSecret ? "deployment" : "runtime";

  warnOnEphemeralSessionSecret(sessionSecretMode);

  return {
    backendBasePath: "",
    backendPathValue: "",
    legacyBackendBasePath,
    legacyBackendPathValue: stripOuterSlashes(env?.BACKEND_PATH || ""),
    sessionSecret,
    defaultRedirectSeed: redirectSeed ? sanitizeRedirectUrl(redirectSeed) : "",
    publicProxyCacheControl: sanitizePublicProxyCacheControl(env?.PUBLIC_PROXY_CACHE_CONTROL),
    publicProxyCacheTtlSeconds: sanitizePublicProxyCacheTtl(env?.PUBLIC_PROXY_CACHE_TTL_SECONDS),
    sessionSecretMode,
  };
}

export function validateBootConfig(config, env) {
  if (!env?.DB) {
    throw new HttpError(500, "Missing DB binding");
  }
}

export function normalizeAdminBasePath(value) {
  const clean = stripOuterSlashes(value).trim();
  if (!clean) return "";
  return `/${clean}`;
}

export function resolveRuntimeConfig(config, bootstrap) {
  const storedBackendPath = stripOuterSlashes(bootstrap?.backendPathValue || "");
  const useLegacyBackendPath = !storedBackendPath && Boolean(bootstrap?.hasBootstrapData);
  const backendPathValue = storedBackendPath || (useLegacyBackendPath ? config.legacyBackendPathValue : "");

  return {
    ...config,
    backendPathValue,
    backendBasePath: normalizeAdminBasePath(backendPathValue),
    backendPathSource: storedBackendPath ? "d1" : backendPathValue ? "env" : "unset",
  };
}

export function sanitizeRedirectUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return DEFAULT_REDIRECT_FALLBACK;
    return url.toString();
  } catch {
    return DEFAULT_REDIRECT_FALLBACK;
  }
}

function getRuntimeSessionSecret() {
  if (!runtimeSessionSecret) {
    runtimeSessionSecret = crypto.randomUUID();
  }
  return runtimeSessionSecret;
}

function sanitizePublicProxyCacheControl(value) {
  const raw = String(value || "").trim();
  if (!raw) return DEFAULT_PUBLIC_PROXY_CACHE_CONTROL;
  if (/^pass-?through$/i.test(raw)) return "pass-through";
  if (raw.length > MAX_PUBLIC_PROXY_CACHE_CONTROL_LENGTH || /[\r\n]/.test(raw)) {
    return DEFAULT_PUBLIC_PROXY_CACHE_CONTROL;
  }
  return raw;
}

function sanitizePublicProxyCacheTtl(value) {
  if (value == null || value === "") return 0;
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 0) return 0;
  return Math.min(numeric, MAX_PUBLIC_PROXY_CACHE_TTL_SECONDS);
}

function warnOnEphemeralSessionSecret(mode) {
  if (mode !== "runtime" || runtimeSessionSecretWarningShown) return;
  runtimeSessionSecretWarningShown = true;
  console.warn(
    "ReForward is using an ephemeral runtime session secret. Set SESSION_SECRET or enable CF_VERSION_METADATA for stable admin sessions."
  );
}
