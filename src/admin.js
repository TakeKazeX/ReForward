import {
  buildSessionCookie,
  createPasswordRecord,
  createSessionToken,
  getAdminSession,
  safeStringEqual,
  verifyPassword,
} from "./auth.js";
import { BOOTSTRAP_ROUTE_PATH, JSON_HEADERS, SESSION_COOKIE_NAME, SESSION_TTL_SECONDS } from "./constants.js";
import { resolveRuntimeConfig } from "./config.js";
import {
  bumpSessionRevision,
  clearLoginThrottle,
  deleteRoute,
  exportAdminBackup,
  getBootstrapState,
  getConsolePasswordRecord,
  getSecurityMode,
  getLoginThrottleState,
  getSessionRevision,
  getRoutesSchemaStatus,
  initializeBootstrap,
  insertRoute,
  listRoutes,
  persistBackendPath,
  recordLoginFailure,
  restoreAdminBackup,
  updateConsolePasswordRecord,
  updateSecurityMode,
  updateRoute,
} from "./db.js";
import { renderConsolePage, renderLoginPage, renderSetupPage } from "./render.js";
import { ROUTES_SCHEMA_SQL_PATH } from "./schema.js";
import { adminResponseHeaders, baseResponseHeaders, HttpError, parseJson, toAbsoluteUrl } from "./utils.js";
import {
  extractRouteId,
  validateBootstrapPayload,
  validateBackupRestorePayload,
  validatePasswordChangePayload,
  validateRoutePayload,
  validateSecurityModePayload,
} from "./validation.js";

export async function handleAdminRequest({ request, env, config, url, routePath, bootstrap: initialBootstrap = null }) {
  let bootstrap = initialBootstrap || (await getBootstrapState(env.DB));
  if (!bootstrap.backendPathValue && config.legacyBackendPathValue && bootstrap.hasBootstrapData) {
    await persistBackendPath(env.DB, config.legacyBackendPathValue);
    bootstrap = await getBootstrapState(env.DB);
  }

  const runtimeConfig = resolveRuntimeConfig(config, bootstrap);
  const appReady = Boolean(
    bootstrap.passwordConfigured && runtimeConfig.backendPathValue && bootstrap.fallbackConfigured
  );
  const sessionRevision = await getSessionRevision(env.DB);
  const session = appReady
    ? await getAdminSession(request, runtimeConfig.sessionSecret, sessionRevision)
    : { valid: false };
  const isApi = runtimeConfig.backendBasePath
    ? routePath.startsWith(`${runtimeConfig.backendBasePath}/api/`) || routePath === `${runtimeConfig.backendBasePath}/api`
    : false;

  if (!appReady) {
    if (bootstrap.hasBootstrapData) {
      if (routePath === BOOTSTRAP_ROUTE_PATH && request.method === "POST") {
        throw new HttpError(409, "OOBE is locked because bootstrap settings already exist");
      }

      return new Response("Bootstrap settings already exist. OOBE is locked.", {
        status: 503,
        headers: baseResponseHeaders(new Headers({ "content-type": "text/plain; charset=utf-8" })),
      });
    }

    if (routePath === BOOTSTRAP_ROUTE_PATH && request.method === "POST") {
      const schemaStatus = await getRoutesSchemaStatus(env.DB);
      if (!schemaStatus.ready) {
        throw new HttpError(503, "D1 数据库尚未初始化，请先执行 SQL。");
      }
      return handleSetup({ request, env, config: runtimeConfig, url, bootstrap });
    }

    if (isApi) {
      return adminJsonError(503, "Setup required");
    }

    if (request.method === "GET" || request.method === "HEAD") {
      const schemaStatus = await getRoutesSchemaStatus(env.DB);
      return renderSetupPage({
        config: runtimeConfig,
        errorMessage: null,
        values: buildSetupDefaults(runtimeConfig),
        requestUrl: url,
        schemaStatus,
      });
    }

    return new Response("Setup required", {
      status: 503,
      headers: baseResponseHeaders(new Headers({ "content-type": "text/plain; charset=utf-8" })),
    });
  }

  if (routePath === BOOTSTRAP_ROUTE_PATH) {
    return new Response("Not Found", {
      status: 404,
      headers: baseResponseHeaders(new Headers({ "content-type": "text/plain; charset=utf-8" })),
    });
  }

  if (routePath === runtimeConfig.backendBasePath && (request.method === "GET" || request.method === "HEAD")) {
    if (!session.valid) {
      return renderLoginPage({ config: runtimeConfig, errorMessage: null });
    }
    return renderConsolePage({
      config: runtimeConfig,
      requestUrl: url,
      session,
      bootstrap,
    });
  }

  if (routePath === `${runtimeConfig.backendBasePath}/login` && request.method === "POST") {
    return handleLogin({ request, env, config: runtimeConfig, sessionRevision, url });
  }

  if (!session.valid) {
    if (isApi) {
      return adminJsonError(401, "Unauthorized");
    }
    return Response.redirect(toAbsoluteUrl(runtimeConfig.backendBasePath, url), 302);
  }

  if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    await verifyAdminMutation(request, session, url);
  }

  if (routePath === `${runtimeConfig.backendBasePath}/logout` && request.method === "POST") {
    return handleLogout(runtimeConfig, url);
  }

  if (routePath === `${runtimeConfig.backendBasePath}/api/meta` && request.method === "GET") {
    const [schema, securityMode] = await Promise.all([getRoutesSchemaStatus(env.DB), getSecurityMode(env.DB)]);
    return Response.json(
      {
        backendPath: runtimeConfig.backendPathValue,
        defaultEntry: {
          mode: bootstrap.fallbackMode,
          redirectUrl: bootstrap.defaultRedirect,
          text: bootstrap.defaultText,
          statusCode: bootstrap.defaultStatusCode,
        },
        sessionHours: SESSION_TTL_SECONDS / 3600,
        schema,
        securityMode,
        storage: {
          routeData: "Cloudflare D1",
          settings: [
            "backend_path",
            "default_fallback_mode",
            "default_redirect_url",
            "console_password_hash",
          ],
          runtime: [`session:${runtimeConfig.sessionSecretMode}`],
        },
      },
      { headers: adminResponseHeaders(new Headers(JSON_HEADERS)) }
    );
  }

  if (routePath === `${runtimeConfig.backendBasePath}/api/routes` && request.method === "GET") {
    try {
      const routes = await listRoutes(env.DB);
      return Response.json(
        {
          routes,
        },
        { headers: adminResponseHeaders(new Headers(JSON_HEADERS)) }
      );
    } catch (error) {
      return handleAdminApiError(error);
    }
  }

  if (routePath === `${runtimeConfig.backendBasePath}/api/routes` && request.method === "POST") {
    try {
      const payload = await parseJson(request);
      const input = validateRoutePayload(payload, runtimeConfig);
      const route = await insertRoute(env.DB, input);
      return Response.json(route, {
        status: 201,
        headers: adminResponseHeaders(new Headers(JSON_HEADERS)),
      });
    } catch (error) {
      return handleAdminApiError(error);
    }
  }

  if (routePath === `${runtimeConfig.backendBasePath}/api/security-mode` && request.method === "GET") {
    try {
      const securityMode = await getSecurityMode(env.DB);
      return Response.json(
        {
          securityMode,
        },
        { headers: adminResponseHeaders(new Headers(JSON_HEADERS)) }
      );
    } catch (error) {
      return handleAdminApiError(error);
    }
  }

  if (routePath === `${runtimeConfig.backendBasePath}/api/security-mode` && request.method === "PUT") {
    try {
      const payload = await parseJson(request);
      const input = validateSecurityModePayload(payload);
      let sessionTerminated = false;

      const currentSecurityMode = await getSecurityMode(env.DB);
      const shouldTerminateSessions =
        input.enabled &&
        input.action === "terminate_session" &&
        (!currentSecurityMode.enabled || currentSecurityMode.action !== "terminate_session");

      if (shouldTerminateSessions) {
        await bumpSessionRevision(env.DB);
        sessionTerminated = true;
      }

      const securityMode = await updateSecurityMode(env.DB, input);
      return Response.json(
        {
          securityMode,
          sessionTerminated,
        },
        { headers: adminResponseHeaders(new Headers(JSON_HEADERS)) }
      );
    } catch (error) {
      return handleAdminApiError(error);
    }
  }

  if (routePath === `${runtimeConfig.backendBasePath}/api/password` && request.method === "PUT") {
    try {
      const payload = await parseJson(request);
      const input = validatePasswordChangePayload(payload);
      const passwordRecord = await getConsolePasswordRecord(env.DB);
      if (!passwordRecord) {
        throw new HttpError(503, "Console password is not configured");
      }
      if (!(await verifyPassword(input.currentPassword, passwordRecord))) {
        throw new HttpError(400, "Current password is incorrect");
      }

      const nextPasswordRecord = await createPasswordRecord(input.newPassword);
      await updateConsolePasswordRecord(env.DB, nextPasswordRecord);
      await bumpSessionRevision(env.DB);

      return Response.json(
        {
          ok: true,
          sessionTerminated: true,
        },
        { headers: adminResponseHeaders(new Headers(JSON_HEADERS)) }
      );
    } catch (error) {
      return handleAdminApiError(error);
    }
  }

  if (routePath === `${runtimeConfig.backendBasePath}/api/backup` && request.method === "GET") {
    try {
      const backup = await exportAdminBackup(env.DB);
      return Response.json(backup, {
        headers: adminResponseHeaders(new Headers(JSON_HEADERS)),
      });
    } catch (error) {
      return handleAdminApiError(error);
    }
  }

  if (routePath === `${runtimeConfig.backendBasePath}/api/backup` && request.method === "POST") {
    try {
      const payload = await parseJson(request);
      const { backup, overridePassword } = validateBackupRestorePayload(payload);
      if (overridePassword) {
        backup.bootstrap.passwordRecord = await createPasswordRecord(overridePassword);
      }
      const restored = await restoreAdminBackup(env.DB, backup);
      await bumpSessionRevision(env.DB);

      return Response.json(
        {
          ok: true,
          sessionTerminated: true,
          routeCount: restored.routeCount,
          backendBasePath: `/${restored.backendPath}`,
        },
        {
          headers: adminResponseHeaders(new Headers(JSON_HEADERS)),
        }
      );
    } catch (error) {
      return handleAdminApiError(error);
    }
  }

  const routeId = extractRouteId(routePath, runtimeConfig.backendBasePath);
  if (routeId != null && request.method === "PUT") {
    try {
      const payload = await parseJson(request);
      const input = validateRoutePayload(payload, runtimeConfig);
      const route = await updateRoute(env.DB, routeId, input);
      if (!route) return adminJsonError(404, "Route not found");
      return Response.json(route, {
        headers: adminResponseHeaders(new Headers(JSON_HEADERS)),
      });
    } catch (error) {
      return handleAdminApiError(error);
    }
  }

  if (routeId != null && request.method === "DELETE") {
    try {
      const deleted = await deleteRoute(env.DB, routeId);
      if (!deleted) return adminJsonError(404, "Route not found");
      return Response.json(
        { ok: true },
        {
          headers: adminResponseHeaders(new Headers(JSON_HEADERS)),
        }
      );
    } catch (error) {
      return handleAdminApiError(error);
    }
  }

  if (isApi) {
    return adminJsonError(404, "Not Found");
  }

  return new Response("Not Found", {
    status: 404,
    headers: baseResponseHeaders(new Headers({ "content-type": "text/plain; charset=utf-8" })),
  });
}

async function handleLogin({ request, env, config, sessionRevision, url }) {
  verifySameOrigin(request, url);
  const throttleKey = await buildLoginThrottleKey(request, config.sessionSecret);
  const throttleState = await getLoginThrottleState(env.DB, throttleKey);
  if (throttleState.blocked) {
    return renderLoginPage(
      {
        config,
        errorMessage: `尝试过于频繁，请 ${throttleState.retryAfter} 秒后再试`,
      },
      429
    );
  }

  const form = await request.formData();
  const password = String(form.get("password") || "");
  const passwordRecord = await getConsolePasswordRecord(env.DB);
  if (!passwordRecord) {
    return renderSetupPage(
      {
        config,
        errorMessage: "ReForward 尚未初始化，请先完成首次配置。",
        values: buildSetupDefaults(config),
        requestUrl: url,
      },
      503
    );
  }

  if (!(await verifyPassword(password, passwordRecord))) {
    const nextState = await recordLoginFailure(env.DB, throttleKey);
    const errorMessage = nextState.blocked
      ? `尝试过于频繁，请 ${nextState.retryAfter} 秒后再试`
      : "密码不正确";
    return renderLoginPage({ config, errorMessage }, nextState.blocked ? 429 : 401);
  }

  await clearLoginThrottle(env.DB, throttleKey);
  const token = await createSessionToken(config.sessionSecret, SESSION_TTL_SECONDS, sessionRevision);
  const headers = new Headers({ Location: toAbsoluteUrl(config.backendBasePath, url) });
  headers.append(
    "Set-Cookie",
    buildSessionCookie({
      name: SESSION_COOKIE_NAME,
      value: token,
      path: config.backendBasePath,
      maxAge: SESSION_TTL_SECONDS,
      secure: url.protocol === "https:",
    })
  );

  return new Response(null, {
    status: 303,
    headers: adminResponseHeaders(headers),
  });
}

async function handleSetup({ request, env, config, url, bootstrap }) {
  verifySameOrigin(request, url);
  if (bootstrap.hasBootstrapData) {
    throw new HttpError(409, "OOBE is locked because bootstrap settings already exist");
  }

  const form = await request.formData();
  let input;
  try {
    input = validateBootstrapPayload({
      backendPath: form.get("backendPath"),
      confirmPassword: form.get("confirmPassword"),
      defaultStatusCode: form.get("defaultStatusCode"),
      defaultText: form.get("defaultText"),
      fallbackMode: form.get("fallbackMode"),
      defaultRedirectUrl: form.get("defaultRedirectUrl"),
      password: form.get("password"),
    });
  } catch (error) {
    if (error instanceof HttpError) {
      return renderSetupPage(
        {
          config,
          errorMessage: error.message,
          values: {
            backendPath: String(form.get("backendPath") || "").trim(),
            defaultRedirectUrl: String(form.get("defaultRedirectUrl") || "").trim() || config.defaultRedirectSeed,
            defaultText: String(form.get("defaultText") || ""),
            defaultStatusCode: String(form.get("defaultStatusCode") || "404").trim() || "404",
            fallbackMode: String(form.get("fallbackMode") || "site").trim() || "site",
          },
          requestUrl: url,
        },
        error.status
      );
    }
    throw error;
  }

  const passwordRecord = await createPasswordRecord(input.password);
  await initializeBootstrap(env.DB, {
    backendPath: input.backendPath,
    defaultStatusCode: input.defaultStatusCode,
    defaultText: input.defaultText,
    defaultRedirect: input.defaultRedirectUrl,
    fallbackMode: input.fallbackMode,
    passwordHash: passwordRecord.hash,
    passwordIterations: passwordRecord.iterations,
    passwordSalt: passwordRecord.salt,
  });
  await bumpSessionRevision(env.DB);
  const nextLocation = toAbsoluteUrl(`/${input.backendPath}`, url);

  return new Response(null, {
    status: 303,
    headers: adminResponseHeaders(
      new Headers({
        Location: nextLocation,
        Refresh: `0; url=${nextLocation}`,
      })
    ),
  });
}

function handleLogout(config, url) {
  const headers = new Headers({ Location: toAbsoluteUrl(config.backendBasePath, url) });
  headers.append(
    "Set-Cookie",
    buildSessionCookie({
      name: SESSION_COOKIE_NAME,
      value: "",
      path: config.backendBasePath,
      maxAge: 0,
      secure: url.protocol === "https:",
    })
  );

  return new Response(null, {
    status: 303,
    headers: adminResponseHeaders(headers),
  });
}

function handleAdminApiError(error) {
  if (error instanceof HttpError && error.code === "SCHEMA_NOT_INITIALIZED") {
    return Response.json(
      {
        error: error.message,
        code: error.code,
        initSqlPath: ROUTES_SCHEMA_SQL_PATH,
      },
      {
        status: error.status,
        headers: adminResponseHeaders(new Headers(JSON_HEADERS)),
      }
    );
  }

  if (error instanceof HttpError) {
    return adminJsonError(error.status, error.message);
  }

  throw error;
}

async function verifyAdminMutation(request, session, url) {
  verifySameOrigin(request, url);

  let submittedToken = request.headers.get("x-rf-csrf") || "";
  const contentType = (request.headers.get("content-type") || "").toLowerCase();
  if (
    !submittedToken &&
    (contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data"))
  ) {
    const form = await request.clone().formData();
    submittedToken = String(form.get("csrf") || "");
  }

  if (!submittedToken || !safeStringEqual(submittedToken, session.csrf || "")) {
    throw new HttpError(403, "Invalid CSRF token");
  }
}

function verifySameOrigin(request, url) {
  let origin = request.headers.get("origin");
  if (origin === "null") origin = null;

  if (origin && !sameOrigin(origin, url.origin)) {
    throw new HttpError(403, `Invalid origin: ${origin} (expected ${url.origin})`);
  }

  if (origin) return;
  const referer = request.headers.get("referer");
  if (!referer) return;

  let refererOrigin = "";
  try {
    refererOrigin = new URL(referer).origin;
  } catch {
    throw new HttpError(403, "Invalid referer format");
  }

  if (!sameOrigin(refererOrigin, url.origin)) {
    throw new HttpError(403, `Invalid referer: ${referer} (expected ${url.origin})`);
  }
}

async function buildLoginThrottleKey(request, secret) {
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const data = new TextEncoder().encode(`${secret}:${ip}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (part) => part.toString(16).padStart(2, "0")).join("");
}

function adminJsonError(status, message) {
  return Response.json(
    { error: message },
    {
      status,
      headers: adminResponseHeaders(new Headers(JSON_HEADERS)),
    }
  );
}

function buildSetupDefaults(config) {
  return {
    backendPath: "",
    defaultRedirectUrl: config.defaultRedirectSeed || "",
    defaultText: "",
    defaultStatusCode: "404",
    fallbackMode: "site",
  };
}

function sameOrigin(left, right) {
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    if (leftUrl.protocol !== rightUrl.protocol) return false;
    if (normalizedPort(leftUrl) !== normalizedPort(rightUrl)) return false;
    if (leftUrl.hostname === rightUrl.hostname) return true;
    if (isLoopbackHostname(leftUrl.hostname) && isLoopbackHostname(rightUrl.hostname)) return true;
    if (isDevelopmentHostname(leftUrl.hostname) && isDevelopmentHostname(rightUrl.hostname)) return true;
    return false;
  } catch {
    return false;
  }
}

function normalizedPort(url) {
  if (url.port) return url.port;
  if (url.protocol === "https:") return "443";
  if (url.protocol === "http:") return "80";
  return "";
}

function isLoopbackHostname(hostname) {
  const lowered = String(hostname || "").toLowerCase();
  if (
    lowered === "localhost" ||
    lowered === "127.0.0.1" ||
    lowered === "0.0.0.0" ||
    lowered === "[::1]" ||
    lowered === "::1"
  ) {
    return true;
  }
  return false;
}

function isDevelopmentHostname(hostname) {
  const lowered = String(hostname || "").toLowerCase();
  if (isLoopbackHostname(lowered)) return true;
  if (lowered.endsWith(".local")) return true;

  const match = lowered.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return false;
  const [a, b] = match.slice(1).map(Number);
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}
