import {
  BACKUP_FILE_FORMAT,
  BACKUP_FILE_VERSION,
  BOOTSTRAP_FALLBACK_MODES,
  DEFAULT_SECURITY_MODE,
  LOGIN_BLOCK_SECONDS,
  LOGIN_MAX_FAILURES,
  LOGIN_WINDOW_SECONDS,
  MAX_BOOTSTRAP_TEXT_LENGTH,
  SECURITY_MODE_ACTIONS,
} from "./constants.js";
import { ROUTES_SCHEMA_SQL, ROUTES_SCHEMA_SQL_PATH } from "./schema.js";
import { HttpError, stripOuterSlashes } from "./utils.js";

export const ROUTES_SCHEMA_ERROR_MESSAGE = "D1 表结构尚未初始化，请先执行初始化 SQL。";

export async function listRoutes(db) {
  try {
    const result = await db.prepare("SELECT * FROM routes ORDER BY updated_at DESC, id DESC").all();
    return (result.results || []).map(mapRouteRecord);
  } catch (error) {
    throwIfSchemaMissing(error);
    throw error;
  }
}

export async function getRoutesSchemaStatus(db) {
  const table = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'routes' LIMIT 1")
    .first();

  return {
    ready: Boolean(table),
    initSqlPath: ROUTES_SCHEMA_SQL_PATH,
    sql: ROUTES_SCHEMA_SQL,
    message: ROUTES_SCHEMA_ERROR_MESSAGE,
  };
}

export async function getSecurityMode(db) {
  await ensureSystemSettingsSchema(db);
  const settings = await readSystemSettings(db, [
    "security_mode_enabled",
    "security_mode_action",
    "security_mode_status_code",
    "security_mode_text",
  ]);
  return normalizeSecurityModeRecord(settings);
}

export async function getBootstrapState(db) {
  await ensureSystemSettingsSchema(db);
  const settings = await readSystemSettings(db, [
    "backend_path",
    "console_password_hash",
    "console_password_iterations",
    "console_password_salt",
    "default_fallback_mode",
    "default_redirect_url",
    "default_response_text",
    "default_status_code",
  ]);
  return buildBootstrapState(settings);
}

export async function getBootstrapAndSecurityState(db) {
  await ensureSystemSettingsSchema(db);
  const settings = await readSystemSettings(db, [
    "backend_path",
    "console_password_hash",
    "console_password_iterations",
    "console_password_salt",
    "default_fallback_mode",
    "default_redirect_url",
    "default_response_text",
    "default_status_code",
    "security_mode_enabled",
    "security_mode_action",
    "security_mode_status_code",
    "security_mode_text",
  ]);

  return {
    bootstrap: buildBootstrapState(settings),
    securityMode: normalizeSecurityModeRecord(settings),
  };
}

export async function exportAdminBackup(db) {
  const [bootstrap, securityMode, passwordRecord, routes] = await Promise.all([
    getBootstrapState(db),
    getSecurityMode(db),
    getConsolePasswordRecord(db),
    listRoutes(db),
  ]);

  if (!bootstrap.backendPathValue || !passwordRecord) {
    throw new HttpError(503, "Backup is unavailable before setup is complete");
  }

  return {
    format: BACKUP_FILE_FORMAT,
    version: BACKUP_FILE_VERSION,
    createdAt: new Date().toISOString(),
    bootstrap: {
      backendPath: bootstrap.backendPathValue,
      fallbackMode: bootstrap.fallbackMode,
      defaultRedirect: bootstrap.defaultRedirect,
      defaultText: bootstrap.defaultText,
      defaultStatusCode: bootstrap.defaultStatusCode,
      passwordRecord,
    },
    securityMode,
    routes,
  };
}

export async function restoreAdminBackup(db, backup) {
  await ensureSystemSettingsSchema(db);
  await ensureLoginAttemptsSchema(db);

  const routeStatements = backup.routes.map((route) =>
    db
      .prepare(
        `INSERT INTO routes
          (slug, kind, target_url, content, user_agent, enabled, strip_cookies, enable_cors, block_private_targets, rewrite_html, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        route.slug,
        route.kind,
        route.targetUrl,
        route.content,
        route.userAgent,
        route.enabled ? 1 : 0,
        route.stripCookies ? 1 : 0,
        route.enableCors ? 1 : 0,
        route.blockPrivateTargets ? 1 : 0,
        route.rewriteHtml ? 1 : 0,
        route.notes
      )
  );

  const settingEntries = [
    ["backend_path", normalizeBackendPathSetting(backup.bootstrap.backendPath)],
    ["console_password_hash", String(backup.bootstrap.passwordRecord.hash || "")],
    ["console_password_iterations", String(backup.bootstrap.passwordRecord.iterations || "")],
    ["console_password_salt", String(backup.bootstrap.passwordRecord.salt || "")],
    ["default_fallback_mode", backup.bootstrap.fallbackMode],
    ["default_redirect_url", normalizeDefaultRedirectSetting(backup.bootstrap.defaultRedirect)],
    ["default_response_text", normalizeBootstrapText(backup.bootstrap.defaultText)],
    ["default_status_code", String(normalizeBootstrapStatusCode(backup.bootstrap.defaultStatusCode))],
    ["security_mode_enabled", backup.securityMode.enabled ? "1" : "0"],
    ["security_mode_action", backup.securityMode.action],
    ["security_mode_status_code", String(normalizeStatusCode(backup.securityMode.statusCode))],
    ["security_mode_text", normalizeSecurityText(backup.securityMode.text)],
  ];

  const settingStatements = settingEntries.map(([key, value]) =>
    db
      .prepare(
        `INSERT INTO system_settings(key, value, updated_at)
         VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at = CURRENT_TIMESTAMP`
      )
      .bind(key, value)
  );

  await db.batch([
    db.prepare("DELETE FROM routes"),
    db.prepare("DELETE FROM login_attempts"),
    ...routeStatements,
    ...settingStatements,
  ]);

  return {
    backendPath: normalizeBackendPathSetting(backup.bootstrap.backendPath),
    routeCount: backup.routes.length,
  };
}

function buildBootstrapState(settings) {
  const backendPathValue = normalizeBackendPathSetting(settings.backend_path);
  const defaultRedirect = normalizeDefaultRedirectSetting(settings.default_redirect_url);
  const fallbackMode = normalizeBootstrapFallbackMode(settings.default_fallback_mode, defaultRedirect);
  const defaultText = normalizeBootstrapText(settings.default_response_text);
  const defaultStatusCode = normalizeBootstrapStatusCode(settings.default_status_code);
  const passwordConfigured = Boolean(
    settings.console_password_hash &&
      settings.console_password_iterations &&
      settings.console_password_salt
  );
  const fallbackConfigured = isBootstrapFallbackConfigured({
    defaultRedirect,
    fallbackMode,
    defaultStatusCode,
    defaultText,
  });
  const hasBootstrapData = hasAnyBootstrapSetting(settings);

  return {
    ready: Boolean(passwordConfigured && backendPathValue && fallbackConfigured),
    hasBootstrapData,
    backendPathValue,
    fallbackConfigured,
    fallbackMode,
    defaultRedirect,
    defaultStatusCode,
    defaultText,
    passwordConfigured,
  };
}

export async function getConsolePasswordRecord(db) {
  await ensureSystemSettingsSchema(db);
  const settings = await readSystemSettings(db, [
    "console_password_hash",
    "console_password_iterations",
    "console_password_salt",
  ]);
  if (!settings.console_password_hash || !settings.console_password_iterations || !settings.console_password_salt) {
    return null;
  }
  return {
    hash: settings.console_password_hash,
    iterations: Number(settings.console_password_iterations),
    salt: settings.console_password_salt,
  };
}

export async function updateConsolePasswordRecord(db, record) {
  await ensureSystemSettingsSchema(db);
  await upsertSystemSettings(db, [
    ["console_password_hash", String(record.hash || "")],
    ["console_password_iterations", String(record.iterations || "")],
    ["console_password_salt", String(record.salt || "")],
  ]);
  return getConsolePasswordRecord(db);
}

export async function initializeBootstrap(db, input) {
  await ensureSystemSettingsSchema(db);
  const current = await getBootstrapState(db);
  if (current.hasBootstrapData) {
    throw new HttpError(409, "ReForward setup is locked");
  }

  await upsertSystemSettings(db, [
    ["backend_path", normalizeBackendPathSetting(input.backendPath)],
    ["console_password_hash", input.passwordHash],
    ["console_password_iterations", String(input.passwordIterations)],
    ["console_password_salt", input.passwordSalt],
    ["default_fallback_mode", input.fallbackMode],
    ["default_redirect_url", normalizeDefaultRedirectSetting(input.defaultRedirect)],
    ["default_response_text", normalizeBootstrapText(input.defaultText)],
    ["default_status_code", String(normalizeBootstrapStatusCode(input.defaultStatusCode))],
  ]);

  return getBootstrapState(db);
}

export async function persistBackendPath(db, backendPath) {
  await ensureSystemSettingsSchema(db);
  const normalized = normalizeBackendPathSetting(backendPath);
  if (!normalized) return "";

  const settings = await readSystemSettings(db, ["backend_path"]);
  if (normalizeBackendPathSetting(settings.backend_path)) {
    return normalizeBackendPathSetting(settings.backend_path);
  }

  await upsertSystemSettings(db, [["backend_path", normalized]]);
  return normalized;
}

export async function updateSecurityMode(db, mode) {
  await ensureSystemSettingsSchema(db);
  const normalized = normalizeSecurityModeRecord(mode);
  await upsertSystemSettings(db, [
    ["security_mode_enabled", normalized.enabled ? "1" : "0"],
    ["security_mode_action", normalized.action],
    ["security_mode_status_code", String(normalized.statusCode)],
    ["security_mode_text", normalized.text],
  ]);
  return normalized;
}

export async function getSessionRevision(db) {
  await ensureSystemSettingsSchema(db);
  const settings = await readSystemSettings(db, ["session_revision"]);
  return normalizeSessionRevision(settings.session_revision);
}

export async function bumpSessionRevision(db) {
  const currentRevision = await getSessionRevision(db);
  const nextRevision = currentRevision + 1;
  await upsertSystemSettings(db, [["session_revision", String(nextRevision)]]);
  return nextRevision;
}

export async function getLoginThrottleState(db, key) {
  await ensureLoginAttemptsSchema(db);
  const now = nowInSeconds();
  const row = await db
    .prepare("SELECT failures, window_started_at, blocked_until FROM login_attempts WHERE key = ? LIMIT 1")
    .bind(key)
    .first();

  if (!row) {
    return buildLoginThrottleState();
  }

  if (Number(row.blocked_until) > now) {
    return buildLoginThrottleState({
      blocked: true,
      failures: Number(row.failures) || 0,
      retryAfter: Math.max(1, Number(row.blocked_until) - now),
    });
  }

  if (Number(row.window_started_at) + LOGIN_WINDOW_SECONDS <= now) {
    await clearLoginThrottle(db, key);
    return buildLoginThrottleState();
  }

  return buildLoginThrottleState({
    failures: Number(row.failures) || 0,
  });
}

export async function recordLoginFailure(db, key) {
  await ensureLoginAttemptsSchema(db);
  const now = nowInSeconds();
  const row = await db
    .prepare("SELECT failures, window_started_at FROM login_attempts WHERE key = ? LIMIT 1")
    .bind(key)
    .first();

  let failures = 1;
  let windowStartedAt = now;
  if (row && Number(row.window_started_at) + LOGIN_WINDOW_SECONDS > now) {
    failures = (Number(row.failures) || 0) + 1;
    windowStartedAt = Number(row.window_started_at) || now;
  }

  const blockedUntil = failures >= LOGIN_MAX_FAILURES ? now + LOGIN_BLOCK_SECONDS : 0;

  await db
    .prepare(
      `INSERT INTO login_attempts(key, failures, window_started_at, blocked_until, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         failures = excluded.failures,
         window_started_at = excluded.window_started_at,
         blocked_until = excluded.blocked_until,
         updated_at = excluded.updated_at`
    )
    .bind(key, failures, windowStartedAt, blockedUntil, now)
    .run();

  return buildLoginThrottleState({
    blocked: blockedUntil > now,
    failures,
    retryAfter: blockedUntil > now ? blockedUntil - now : 0,
  });
}

export async function clearLoginThrottle(db, key) {
  await ensureLoginAttemptsSchema(db);
  await db.prepare("DELETE FROM login_attempts WHERE key = ?").bind(key).run();
}

export async function findPublicRoute(db, routePath) {
  try {
    const slug = stripOuterSlashes(routePath);
    const exact = await db
      .prepare("SELECT * FROM routes WHERE slug = ? AND enabled = 1 LIMIT 1")
      .bind(slug)
      .first();

    if (exact) return mapRouteRecord(exact);

    const siteRoute = await db
      .prepare(
        "SELECT * FROM routes WHERE kind = 'site' AND enabled = 1 AND (? = '/' || slug OR ? GLOB '/' || slug || '/*') ORDER BY LENGTH(slug) DESC LIMIT 1"
      )
      .bind(routePath, routePath)
      .first();

    return siteRoute ? mapRouteRecord(siteRoute) : null;
  } catch (error) {
    throwIfSchemaMissing(error);
    throw error;
  }
}

export async function insertRoute(db, route) {
  try {
    const result = await db
      .prepare(
        `INSERT INTO routes
          (slug, kind, target_url, content, user_agent, enabled, strip_cookies, enable_cors, block_private_targets, rewrite_html, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        route.slug,
        route.kind,
        route.targetUrl,
        route.content,
        route.userAgent,
        route.enabled ? 1 : 0,
        route.stripCookies ? 1 : 0,
        route.enableCors ? 1 : 0,
        route.blockPrivateTargets ? 1 : 0,
        route.rewriteHtml ? 1 : 0,
        route.notes
      )
      .run();

    return getRouteById(db, result.meta.last_row_id);
  } catch (error) {
    throwIfSchemaMissing(error);
    if (String(error?.message || "").includes("UNIQUE constraint failed")) {
      throw new HttpError(409, "Route path already exists");
    }
    throw error;
  }
}

export async function updateRoute(db, routeId, route) {
  try {
    const existing = await getRouteById(db, routeId);
    if (!existing) return null;

    await db
      .prepare(
        `UPDATE routes
         SET slug = ?, kind = ?, target_url = ?, content = ?, user_agent = ?, enabled = ?, strip_cookies = ?, enable_cors = ?, block_private_targets = ?, rewrite_html = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`
      )
      .bind(
        route.slug,
        route.kind,
        route.targetUrl,
        route.content,
        route.userAgent,
        route.enabled ? 1 : 0,
        route.stripCookies ? 1 : 0,
        route.enableCors ? 1 : 0,
        route.blockPrivateTargets ? 1 : 0,
        route.rewriteHtml ? 1 : 0,
        route.notes,
        routeId
      )
      .run();

    return getRouteById(db, routeId);
  } catch (error) {
    throwIfSchemaMissing(error);
    if (String(error?.message || "").includes("UNIQUE constraint failed")) {
      throw new HttpError(409, "Route path already exists");
    }
    throw error;
  }
}

export async function deleteRoute(db, routeId) {
  try {
    const result = await db.prepare("DELETE FROM routes WHERE id = ?").bind(routeId).run();
    return result.meta.changes > 0;
  } catch (error) {
    throwIfSchemaMissing(error);
    throw error;
  }
}

async function getRouteById(db, routeId) {
  try {
    const row = await db.prepare("SELECT * FROM routes WHERE id = ? LIMIT 1").bind(routeId).first();
    return row ? mapRouteRecord(row) : null;
  } catch (error) {
    throwIfSchemaMissing(error);
    throw error;
  }
}

function mapRouteRecord(row) {
  return {
    id: row.id,
    slug: row.slug,
    kind: row.kind,
    targetUrl: row.target_url || "",
    content: row.content || "",
    userAgent: row.user_agent || "",
    enabled: Boolean(row.enabled),
    stripCookies: Boolean(row.strip_cookies),
    enableCors: Boolean(row.enable_cors),
    blockPrivateTargets: Boolean(row.block_private_targets),
    rewriteHtml: Boolean(row.rewrite_html),
    notes: row.notes || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publicPath: `/${row.slug}`,
  };
}

function throwIfSchemaMissing(error) {
  const message = String(error?.message || "").toLowerCase();
  if (message.includes("no such table: routes")) {
    throw new HttpError(503, ROUTES_SCHEMA_ERROR_MESSAGE, "SCHEMA_NOT_INITIALIZED");
  }
}

const SYSTEM_SETTINGS_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`;
let settingsSchemaReady = false;
const LOGIN_ATTEMPTS_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS login_attempts (
  key TEXT PRIMARY KEY,
  failures INTEGER NOT NULL DEFAULT 0,
  window_started_at INTEGER NOT NULL,
  blocked_until INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
)`;
let loginAttemptsSchemaReady = false;

async function ensureSystemSettingsSchema(db) {
  if (settingsSchemaReady) return;
  await db.prepare(SYSTEM_SETTINGS_SCHEMA_SQL).run();
  await db
    .prepare(
      `INSERT INTO system_settings(key, value)
       VALUES ('session_revision', '0')
       ON CONFLICT(key) DO NOTHING`
    )
    .run();
  settingsSchemaReady = true;
}

async function ensureLoginAttemptsSchema(db) {
  if (loginAttemptsSchemaReady) return;
  await db.prepare(LOGIN_ATTEMPTS_SCHEMA_SQL).run();
  loginAttemptsSchemaReady = true;
}

async function readSystemSettings(db, keys) {
  if (!keys.length) return {};
  const placeholders = keys.map(() => "?").join(", ");
  const result = await db
    .prepare(`SELECT key, value FROM system_settings WHERE key IN (${placeholders})`)
    .bind(...keys)
    .all();

  const out = {};
  for (const row of result.results || []) {
    out[row.key] = String(row.value ?? "");
  }
  return out;
}

async function upsertSystemSettings(db, entries) {
  if (!entries.length) return;
  const statements = entries.map(([key, value]) =>
    db
      .prepare(
        `INSERT INTO system_settings(key, value, updated_at)
         VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at = CURRENT_TIMESTAMP`
      )
      .bind(key, value)
  );
  await db.batch(statements);
}

function normalizeSecurityModeRecord(record) {
  const source = record || {};
  const enabled = toBoolean(source.enabled ?? source.security_mode_enabled, DEFAULT_SECURITY_MODE.enabled);
  const actionInput = String(source.action ?? source.security_mode_action ?? DEFAULT_SECURITY_MODE.action).trim();
  const action = SECURITY_MODE_ACTIONS.has(actionInput) ? actionInput : DEFAULT_SECURITY_MODE.action;
  const statusCode = normalizeStatusCode(source.statusCode ?? source.security_mode_status_code);
  const text = normalizeSecurityText(source.text ?? source.security_mode_text);

  return {
    enabled,
    action,
    statusCode,
    text,
  };
}

function normalizeDefaultRedirectSetting(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return url.toString();
  } catch {
    return "";
  }
}

function normalizeBackendPathSetting(value) {
  const clean = stripOuterSlashes(String(value || "").trim());
  if (!clean) return "";
  return clean;
}

function normalizeBootstrapFallbackMode(value, defaultRedirect) {
  const raw = String(value || "").trim();
  if (BOOTSTRAP_FALLBACK_MODES.has(raw)) return raw;
  return defaultRedirect ? "site" : "";
}

function normalizeBootstrapStatusCode(value) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 100 || numeric > 599) return 404;
  return numeric;
}

function normalizeBootstrapText(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  return raw.slice(0, MAX_BOOTSTRAP_TEXT_LENGTH);
}

function isBootstrapFallbackConfigured(state) {
  if (state.fallbackMode === "site") return Boolean(state.defaultRedirect);
  if (state.fallbackMode === "login") return true;
  if (state.fallbackMode === "text") return Boolean(state.defaultText);
  if (state.fallbackMode === "status_code") return Number.isInteger(Number(state.defaultStatusCode));
  return false;
}

function hasAnyBootstrapSetting(settings) {
  return [
    settings.backend_path,
    settings.console_password_hash,
    settings.console_password_iterations,
    settings.console_password_salt,
    settings.default_fallback_mode,
    settings.default_redirect_url,
    settings.default_response_text,
    settings.default_status_code,
  ].some((value) => String(value || "").trim() !== "");
}

function normalizeStatusCode(value) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric)) return DEFAULT_SECURITY_MODE.statusCode;
  if (numeric < 100 || numeric > 599) return DEFAULT_SECURITY_MODE.statusCode;
  return numeric;
}

function normalizeSecurityText(value) {
  const raw = String(value ?? "").trim();
  return raw || DEFAULT_SECURITY_MODE.text;
}

function normalizeSessionRevision(value) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 0) return 0;
  return numeric;
}

function toBoolean(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const lowered = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(lowered)) return true;
  if (["0", "false", "no", "off"].includes(lowered)) return false;
  return fallback;
}

function buildLoginThrottleState(source = {}) {
  return {
    blocked: Boolean(source.blocked),
    failures: Number(source.failures) || 0,
    remaining: Math.max(0, LOGIN_MAX_FAILURES - (Number(source.failures) || 0)),
    retryAfter: Math.max(0, Number(source.retryAfter) || 0),
  };
}

function nowInSeconds() {
  return Math.floor(Date.now() / 1000);
}
