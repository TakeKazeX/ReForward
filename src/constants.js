export const DEFAULT_REDIRECT_FALLBACK = "https://example.com";
export const DEFAULT_PUBLIC_PROXY_CACHE_CONTROL = "no-store";
export const BOOTSTRAP_ROUTE_PATH = "/_oobe";
export const DEFAULT_ENABLE_CORS = false;
export const DEFAULT_STRIP_COOKIES = true;
export const DEFAULT_BLOCK_PRIVATE_TARGETS = true;
export const SESSION_COOKIE_NAME = "rf_admin_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 12;
export const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
export const MAX_SLUG_LENGTH = 256;
export const MAX_TARGET_URL_LENGTH = 2048;
export const MAX_ROUTE_NOTES_LENGTH = 200;
export const MAX_TEXT_CONTENT_LENGTH = 20000;
export const MAX_USER_AGENT_LENGTH = 1024;
export const MIN_CONSOLE_PASSWORD_LENGTH = 8;
export const MAX_CONSOLE_PASSWORD_LENGTH = 128;
export const MAX_BOOTSTRAP_TEXT_LENGTH = 4000;
export const MAX_PUBLIC_PROXY_CACHE_CONTROL_LENGTH = 256;
export const MAX_PUBLIC_PROXY_CACHE_TTL_SECONDS = 31536000;
export const PASSWORD_HASH_ITERATIONS = 50000;
export const LOGIN_WINDOW_SECONDS = 15 * 60;
export const LOGIN_MAX_FAILURES = 10;
export const LOGIN_BLOCK_SECONDS = 15 * 60;
export const HTML_REWRITE_KINDS = new Set(["site"]);
export const ALLOWED_ROUTE_KINDS = new Set(["proxy", "site", "redirect", "text"]);
export const BOOTSTRAP_FALLBACK_MODES = new Set(["site", "login", "text", "status_code"]);
export const SECURITY_MODE_ACTIONS = new Set(["default_redirect", "status_code", "text", "terminate_session"]);
export const DEFAULT_SECURITY_MODE = Object.freeze({
  enabled: false,
  action: "default_redirect",
  statusCode: 503,
  text: "Access temporarily disabled by security mode.",
});
export const BACKUP_FILE_FORMAT = "reforward-backup";
export const BACKUP_FILE_VERSION = 1;

export const UA_MAP = {
  mihomo: "mihomo",
  "clash.meta": "clash.meta",
  "sing-box": "sing-box",
  default:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
};
