import { JSON_HEADERS } from "./constants.js";

export function stripOuterSlashes(value) {
  return String(value || "").replace(/^\/+|\/+$/g, "");
}

export function normalizeRoutePath(pathname) {
  return pathname.endsWith("/") && pathname.length > 1 ? pathname.slice(0, -1) : pathname;
}

export function isAdminPath(routePath, backendBasePath) {
  if (!backendBasePath) return false;
  return routePath === backendBasePath || routePath.startsWith(`${backendBasePath}/`);
}

export function baseResponseHeaders(headers) {
  headers.set("cache-control", "no-store");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-robots-tag", "noindex, nofollow, nosnippet");
  return headers;
}

export function adminResponseHeaders(headers) {
  baseResponseHeaders(headers);
  headers.set("permissions-policy", "camera=(), geolocation=(), microphone=()");
  headers.set("x-frame-options", "DENY");
  return headers;
}

export function adminDocumentHeaders(headers) {
  adminResponseHeaders(headers);
  headers.set(
    "content-security-policy",
    "default-src 'self'; base-uri 'none'; connect-src 'self'; form-action 'self'; " +
      "frame-ancestors 'none'; img-src 'self' data:; script-src 'self' 'unsafe-inline'; " +
      "style-src 'self' 'unsafe-inline'"
  );
  return headers;
}

export async function parseJson(request) {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}

export function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function toAbsoluteUrl(path, requestUrl) {
  const url = requestUrl instanceof URL ? requestUrl : new URL(String(requestUrl || ""));
  return new URL(String(path || "/"), url).toString();
}

export function jsonError(status, message) {
  return Response.json(
    { error: message },
    {
      status,
      headers: baseResponseHeaders(new Headers(JSON_HEADERS)),
    }
  );
}

export class HttpError extends Error {
  constructor(status, message, code = null) {
    super(message);
    this.status = status;
    this.code = code;
  }

  toResponse() {
    return new Response(this.message, {
      status: this.status,
      headers: baseResponseHeaders(new Headers({ "content-type": "text/plain; charset=utf-8" })),
    });
  }
}
