import { handleAdminRequest } from "./admin.js";
import { BOOTSTRAP_ROUTE_PATH } from "./constants.js";
import { getAppConfig, resolveRuntimeConfig, validateBootConfig } from "./config.js";
import { findPublicRoute, getBootstrapAndSecurityState } from "./db.js";
import { handleFallbackSiteRoute, handlePublicRoute } from "./public.js";
import { baseResponseHeaders, HttpError, isAdminPath, normalizeRoutePath } from "./utils.js";
import { renderLoginPage } from "./render.js";

export default {
  async fetch(request, env) {
    try {
      const config = getAppConfig(env);
      const url = new URL(request.url);
      const routePath = normalizeRoutePath(url.pathname);

      validateBootConfig(config, env);

      if (routePath === "/robots.txt") {
        return new Response("User-agent: *\nDisallow: /\n", {
          headers: baseResponseHeaders(new Headers({ "content-type": "text/plain; charset=utf-8" })),
        });
      }

      const { bootstrap, securityMode } = await getBootstrapAndSecurityState(env.DB);
      const runtimeConfig = resolveRuntimeConfig(config, bootstrap);
      const appReady = Boolean(
        bootstrap.passwordConfigured && runtimeConfig.backendPathValue && bootstrap.fallbackConfigured
      );

      if (!appReady) {
        return handleAdminRequest({ request, env, config, url, routePath, bootstrap });
      }

      if (isAdminPath(routePath, runtimeConfig.backendBasePath)) {
        return handleAdminRequest({ request, env, config, url, routePath, bootstrap });
      }

      if (routePath === "/" || routePath === "") {
        if (securityMode.enabled) {
          return buildSecurityModeResponse({ request, url, routePath, config: runtimeConfig, bootstrap, securityMode });
        }
        return buildDefaultEntryResponse({ request, url, routePath: "/", config: runtimeConfig, bootstrap });
      }

      if (securityMode.enabled) {
        return buildSecurityModeResponse({ request, url, routePath, config: runtimeConfig, bootstrap, securityMode });
      }

      const route = await findPublicRoute(env.DB, routePath);
      if (!route) {
        return buildDefaultEntryResponse({ request, url, routePath, config: runtimeConfig, bootstrap });
      }

      return handlePublicRoute({
        request,
        url,
        routePath,
        route: {
          ...route,
          publicProxyCacheControl: runtimeConfig.publicProxyCacheControl,
          publicProxyCacheTtlSeconds: runtimeConfig.publicProxyCacheTtlSeconds,
        },
      });
    } catch (error) {
      if (error instanceof HttpError) {
        return error.toResponse();
      }

      console.error("ReForward worker error", error);
      return new Response("Worker Error", {
        status: 500,
        headers: baseResponseHeaders(new Headers({ "content-type": "text/plain; charset=utf-8" })),
      });
    }
  },
};

function buildSecurityModeResponse({ request, url, routePath, config, bootstrap, securityMode }) {
  if (securityMode.action === "default_redirect") {
    return buildDefaultEntryResponse({ request, url, routePath, config, bootstrap });
  }

  if (securityMode.action === "status_code") {
    return new Response("Blocked by security mode", {
      status: securityMode.statusCode,
      headers: baseResponseHeaders(new Headers({ "content-type": "text/plain; charset=utf-8" })),
    });
  }

  if (securityMode.action === "text") {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: baseResponseHeaders(new Headers({ Allow: "GET, HEAD" })),
      });
    }

    return new Response(request.method === "HEAD" ? null : securityMode.text, {
      status: 200,
      headers: baseResponseHeaders(new Headers({ "content-type": "text/plain; charset=utf-8" })),
    });
  }

  if (securityMode.action === "terminate_session") {
    return new Response("Access disabled", {
      status: 401,
      headers: baseResponseHeaders(new Headers({ "content-type": "text/plain; charset=utf-8" })),
    });
  }

  return new Response("Blocked by security mode", {
    status: 503,
    headers: baseResponseHeaders(new Headers({ "content-type": "text/plain; charset=utf-8" })),
  });
}

function buildDefaultEntryResponse({ request, url, routePath, config, bootstrap }) {
  if (bootstrap.fallbackMode === "site") {
    return handleFallbackSiteRoute({
      request,
      url,
      routePath,
      targetBaseUrl: bootstrap.defaultRedirect,
      publicProxyCacheControl: config.publicProxyCacheControl,
      publicProxyCacheTtlSeconds: config.publicProxyCacheTtlSeconds,
    });
  }

  if (bootstrap.fallbackMode === "login") {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: baseResponseHeaders(new Headers({ Allow: "GET, HEAD" })),
      });
    }

    return renderLoginPage({ config, errorMessage: null }, 200);
  }

  if (bootstrap.fallbackMode === "text") {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: baseResponseHeaders(new Headers({ Allow: "GET, HEAD" })),
      });
    }

    return new Response(request.method === "HEAD" ? null : bootstrap.defaultText, {
      status: 200,
      headers: baseResponseHeaders(new Headers({ "content-type": "text/plain; charset=utf-8" })),
    });
  }

  if (bootstrap.fallbackMode === "status_code") {
    return new Response("Not Found", {
      status: bootstrap.defaultStatusCode,
      headers: baseResponseHeaders(new Headers({ "content-type": "text/plain; charset=utf-8" })),
    });
  }

  return new Response("Not Found", {
    status: 404,
    headers: baseResponseHeaders(new Headers({ "content-type": "text/plain; charset=utf-8" })),
  });
}
