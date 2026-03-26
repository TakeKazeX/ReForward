import {
  ALLOWED_ROUTE_KINDS,
  BOOTSTRAP_FALLBACK_MODES,
  BOOTSTRAP_ROUTE_PATH,
  DEFAULT_SECURITY_MODE,
  DEFAULT_BLOCK_PRIVATE_TARGETS,
  DEFAULT_ENABLE_CORS,
  DEFAULT_STRIP_COOKIES,
  HTML_REWRITE_KINDS,
  MAX_BOOTSTRAP_TEXT_LENGTH,
  MAX_CONSOLE_PASSWORD_LENGTH,
  MAX_ROUTE_NOTES_LENGTH,
  MAX_SLUG_LENGTH,
  MAX_TARGET_URL_LENGTH,
  MAX_TEXT_CONTENT_LENGTH,
  MAX_USER_AGENT_LENGTH,
  MIN_CONSOLE_PASSWORD_LENGTH,
  SECURITY_MODE_ACTIONS,
  UA_MAP,
} from "./constants.js";
import { parseTargetUrl } from "./public.js";
import { escapeRegExp, HttpError, stripOuterSlashes } from "./utils.js";

export function extractRouteId(routePath, backendBasePath) {
  const match = routePath.match(new RegExp(`^${escapeRegExp(`${backendBasePath}/api/routes/`)}(\\d+)$`));
  return match ? Number(match[1]) : null;
}

export function validateRoutePayload(payload, config) {
  const slug = normalizeSlug(payload?.slug);
  const kind = String(payload?.kind || "").trim();
  const targetUrl = normalizeRouteTargetUrl(String(payload?.targetUrl || "").trim(), kind);
  const content = String(payload?.content || "");
  const userAgent = String(payload?.userAgent || "").trim();
  const notes = String(payload?.notes || "").trim();
  const enabled = toBoolean(payload?.enabled, true);
  const stripCookies = toBoolean(payload?.stripCookies, DEFAULT_STRIP_COOKIES);
  const enableCors = toBoolean(payload?.enableCors, DEFAULT_ENABLE_CORS);
  const blockPrivateTargets = toBoolean(payload?.blockPrivateTargets, DEFAULT_BLOCK_PRIVATE_TARGETS);
  const rewriteHtml = toBoolean(payload?.rewriteHtml, kind === "site");

  if (!slug) {
    throw new HttpError(400, "Route path is required");
  }

  if (!ALLOWED_ROUTE_KINDS.has(kind)) {
    throw new HttpError(400, "Invalid route kind");
  }

  validateSlugAgainstAdmin(slug, config.backendPathValue);

  if (targetUrl.length > MAX_TARGET_URL_LENGTH) {
    throw new HttpError(400, `Target URL is too long (max ${MAX_TARGET_URL_LENGTH} chars)`);
  }

  if (content.length > MAX_TEXT_CONTENT_LENGTH) {
    throw new HttpError(400, `Text content is too long (max ${MAX_TEXT_CONTENT_LENGTH} chars)`);
  }

  if (userAgent.length > MAX_USER_AGENT_LENGTH) {
    throw new HttpError(400, `User-Agent is too long (max ${MAX_USER_AGENT_LENGTH} chars)`);
  }

  if (notes.length > MAX_ROUTE_NOTES_LENGTH) {
    throw new HttpError(400, `Notes is too long (max ${MAX_ROUTE_NOTES_LENGTH} chars)`);
  }

  if (kind === "text") {
    if (!content.trim()) {
      throw new HttpError(400, "Text content is required");
    }
  } else {
    if (!targetUrl) {
      throw new HttpError(400, "Target URL is required");
    }
    parseTargetUrl(targetUrl);
  }

  if (userAgent && !UA_MAP[userAgent] && /[\r\n]/.test(userAgent)) {
    throw new HttpError(400, "Invalid user agent");
  }

  return {
    slug,
    kind,
    targetUrl: kind === "text" ? null : targetUrl,
    content: kind === "text" ? content : "",
    userAgent,
    enabled,
    stripCookies,
    enableCors,
    blockPrivateTargets,
    rewriteHtml: HTML_REWRITE_KINDS.has(kind) ? rewriteHtml : false,
    notes,
  };
}

export function validateSecurityModePayload(payload) {
  const action = String(payload?.action ?? DEFAULT_SECURITY_MODE.action).trim();
  const enabled = toBoolean(payload?.enabled, DEFAULT_SECURITY_MODE.enabled);
  const statusCode = normalizeStatusCode(payload?.statusCode);
  const text = normalizeSecurityText(payload?.text);

  if (!SECURITY_MODE_ACTIONS.has(action)) {
    throw new HttpError(400, "Invalid security mode action");
  }

  if (action === "status_code" && payload?.statusCode == null) {
    throw new HttpError(400, "Status code is required for status_code action");
  }
  if (action === "status_code" && !Number.isInteger(Number(payload?.statusCode))) {
    throw new HttpError(400, "Status code must be an integer");
  }

  if (action === "text" && !String(payload?.text ?? "").trim()) {
    throw new HttpError(400, "Text content is required for text action");
  }

  return {
    enabled,
    action,
    statusCode,
    text,
  };
}

export function validateBootstrapPayload(payload) {
  const backendPath = normalizeBackendPath(payload?.backendPath);
  const fallbackMode = String(payload?.fallbackMode || "").trim();
  const defaultRedirectUrl = normalizeBootstrapRedirectUrl(payload?.defaultRedirectUrl);
  const defaultText = String(payload?.defaultText || "");
  const defaultStatusCode = normalizeStatusCode(payload?.defaultStatusCode);
  const password = String(payload?.password || "");
  const confirmPassword = String(payload?.confirmPassword || "");

  if (!backendPath) {
    throw new HttpError(400, "Backend path is required");
  }

  validateBackendPath(backendPath);

  if (!BOOTSTRAP_FALLBACK_MODES.has(fallbackMode)) {
    throw new HttpError(400, "Invalid default access mode");
  }

  if (fallbackMode === "site") {
    if (!defaultRedirectUrl) {
      throw new HttpError(400, "Default site URL is required");
    }
  }

  if (fallbackMode === "text") {
    if (!defaultText.trim()) {
      throw new HttpError(400, "Default text is required");
    }
    if (defaultText.length > MAX_BOOTSTRAP_TEXT_LENGTH) {
      throw new HttpError(400, `Default text is too long (max ${MAX_BOOTSTRAP_TEXT_LENGTH} chars)`);
    }
  }

  if (fallbackMode === "status_code" && payload?.defaultStatusCode == null) {
    throw new HttpError(400, "Default status code is required");
  }
  if (fallbackMode === "status_code" && !Number.isInteger(Number(payload?.defaultStatusCode))) {
    throw new HttpError(400, "Default status code must be an integer");
  }

  if (password.length < MIN_CONSOLE_PASSWORD_LENGTH) {
    throw new HttpError(400, `Password is too short (min ${MIN_CONSOLE_PASSWORD_LENGTH} chars)`);
  }
  if (password.length > MAX_CONSOLE_PASSWORD_LENGTH) {
    throw new HttpError(400, `Password is too long (max ${MAX_CONSOLE_PASSWORD_LENGTH} chars)`);
  }
  if (password !== confirmPassword) {
    throw new HttpError(400, "Passwords do not match");
  }

  return {
    backendPath,
    fallbackMode,
    defaultRedirectUrl,
    defaultStatusCode,
    defaultText: defaultText.trim(),
    password,
  };
}

export function validatePasswordChangePayload(payload) {
  const currentPassword = String(payload?.currentPassword || "");
  const newPassword = String(payload?.newPassword || "");
  const confirmNewPassword = String(payload?.confirmNewPassword || "");

  if (!currentPassword) {
    throw new HttpError(400, "Current password is required");
  }
  if (newPassword.length < MIN_CONSOLE_PASSWORD_LENGTH) {
    throw new HttpError(400, `New password is too short (min ${MIN_CONSOLE_PASSWORD_LENGTH} chars)`);
  }
  if (newPassword.length > MAX_CONSOLE_PASSWORD_LENGTH) {
    throw new HttpError(400, `New password is too long (max ${MAX_CONSOLE_PASSWORD_LENGTH} chars)`);
  }
  if (newPassword !== confirmNewPassword) {
    throw new HttpError(400, "New passwords do not match");
  }
  if (currentPassword === newPassword) {
    throw new HttpError(400, "New password must be different from the current password");
  }

  return {
    currentPassword,
    newPassword,
  };
}

function validateSlugAgainstAdmin(slug, backendPathValue) {
  const reservedSetupPath = stripOuterSlashes(BOOTSTRAP_ROUTE_PATH);
  if (slug === reservedSetupPath || slug.startsWith(`${reservedSetupPath}/`) || reservedSetupPath.startsWith(`${slug}/`)) {
    throw new HttpError(400, "Route path conflicts with reserved setup path");
  }

  if (!backendPathValue) return;

  if (
    slug === backendPathValue ||
    slug.startsWith(`${backendPathValue}/`) ||
    backendPathValue.startsWith(`${slug}/`)
  ) {
    throw new HttpError(400, "Route path conflicts with backend path");
  }
}

function validateBackendPath(backendPath) {
  if (
    backendPath === stripOuterSlashes(BOOTSTRAP_ROUTE_PATH) ||
    backendPath.startsWith(`${stripOuterSlashes(BOOTSTRAP_ROUTE_PATH)}/`)
  ) {
    throw new HttpError(400, "Backend path conflicts with reserved setup path");
  }
}

function normalizeSlug(value) {
  const clean = stripOuterSlashes(String(value || "").trim());
  if (!clean) return "";
  if (clean.length > MAX_SLUG_LENGTH) {
    throw new HttpError(400, `Route path is too long (max ${MAX_SLUG_LENGTH} chars)`);
  }
  if (clean.includes("?") || clean.includes("#")) {
    throw new HttpError(400, "Route path cannot contain ? or #");
  }
  if (!/^[A-Za-z0-9._~/-]+$/.test(clean)) {
    throw new HttpError(400, "Route path only supports letters, numbers, /, ., _, ~ and -");
  }
  return clean;
}

function normalizeBackendPath(value) {
  const clean = normalizeSlug(value);
  if (!clean) return "";
  return clean;
}

function normalizeBootstrapRedirectUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  parseTargetUrl(withScheme);
  return withScheme;
}

function normalizeRouteTargetUrl(value, kind) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (kind === "text") return raw;
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

function toBoolean(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const lowered = String(value).toLowerCase().trim();
  if (["1", "true", "yes", "on"].includes(lowered)) return true;
  if (["0", "false", "no", "off"].includes(lowered)) return false;
  return fallback;
}

function normalizeStatusCode(value) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric)) return DEFAULT_SECURITY_MODE.statusCode;
  if (numeric < 100 || numeric > 599) {
    throw new HttpError(400, "Status code must be between 100 and 599");
  }
  return numeric;
}

function normalizeSecurityText(value) {
  const text = String(value ?? "").trim();
  if (!text) return DEFAULT_SECURITY_MODE.text;
  if (text.length > 4000) {
    throw new HttpError(400, "Text content is too long (max 4000 chars)");
  }
  return text;
}
