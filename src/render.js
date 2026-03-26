import { BOOTSTRAP_ROUTE_PATH } from "./constants.js";
import { adminDocumentHeaders, escapeHtml } from "./utils.js";
import loginHtml from "./pages/login.html";
import setupHtml from "./pages/setup.html";
import consoleHtml from "./pages/console.html";

export function renderLoginPage({ config, errorMessage }, status = 200) {
  const errorBlock = errorMessage
    ? `<p class="error">${escapeHtml(errorMessage)}</p>`
    : "";

  const html = loginHtml
    .replace("{{BACKEND_BASE_PATH}}", escapeHtml(config.backendBasePath))
    .replace("{{ERROR_BLOCK}}", errorBlock);

  return new Response(html, {
    status,
    headers: adminDocumentHeaders(new Headers({ "content-type": "text/html; charset=utf-8" })),
  });
}

export function renderSetupPage({ config, errorMessage, values, requestUrl, schemaStatus = {} }, status = 200) {
  const errorBlock = errorMessage
    ? `<p class="error">${escapeHtml(errorMessage)}</p>`
    : "";
  const setupValues = {
    backendPath: values?.backendPath || "",
    defaultRedirectUrl: stripHttpsPrefix(values?.defaultRedirectUrl || ""),
    defaultText: values?.defaultText || "",
    defaultStatusCode: values?.defaultStatusCode || "404",
    fallbackMode: values?.fallbackMode || "site",
  };
  const requestOrigin = requestUrl ? new URL(requestUrl).origin : "";

  const html = setupHtml
    .replaceAll("{{SETUP_POST_PATH}}", escapeHtml(BOOTSTRAP_ROUTE_PATH))
    .replace("{{REQUEST_ORIGIN}}", escapeHtml(requestOrigin))
    .replace("{{BACKEND_PATH_VALUE}}", escapeHtml(setupValues.backendPath))
    .replace("{{DEFAULT_REDIRECT_VALUE}}", escapeHtml(setupValues.defaultRedirectUrl))
    .replace("{{DEFAULT_TEXT_VALUE}}", escapeHtml(setupValues.defaultText))
    .replace("{{DEFAULT_STATUS_CODE_VALUE}}", escapeHtml(setupValues.defaultStatusCode))
    .replace("{{SITE_MODE_CHECKED}}", setupValues.fallbackMode === "site" ? "checked" : "")
    .replace("{{LOGIN_MODE_CHECKED}}", setupValues.fallbackMode === "login" ? "checked" : "")
    .replace("{{TEXT_MODE_CHECKED}}", setupValues.fallbackMode === "text" ? "checked" : "")
    .replace("{{STATUS_MODE_CHECKED}}", setupValues.fallbackMode === "status_code" ? "checked" : "")
    .replace("{{ERROR_BLOCK}}", errorBlock)
    .replace("{{SCHEMA_HIDDEN}}", schemaStatus.ready ? "hidden" : "")
    .replace("{{SCHEMA_INIT_FILE}}", escapeHtml(schemaStatus.initSqlPath || "migrations/0001_initial_schema.sql"))
    .replace("{{SCHEMA_SQL}}", escapeHtml(schemaStatus.sql || ""));

  return new Response(html, {
    status,
    headers: adminDocumentHeaders(new Headers({ "content-type": "text/html; charset=utf-8" })),
  });
}

export function renderConsolePage({ config, requestUrl, session, bootstrap }) {
  const publicOrigin = requestUrl.origin;
  const defaultEntrySummary = describeDefaultEntry(bootstrap, config.backendBasePath);

  const html = consoleHtml
    .replace("{{BACKEND_BASE_PATH}}", escapeHtml(config.backendBasePath))
    .replace("{{CSRF_TOKEN}}", escapeHtml(session.csrf || ""))
    .replace("\"{{CSRF_TOKEN_JSON}}\"", JSON.stringify(session.csrf || ""))
    .replace("{{DEFAULT_REDIRECT}}", escapeHtml(defaultEntrySummary))
    .replace("{{PUBLIC_ORIGIN}}", escapeHtml(publicOrigin))
    .replace("\"{{ADMIN_BASE_JSON}}\"", JSON.stringify(config.backendBasePath));

  return new Response(html, {
    headers: adminDocumentHeaders(new Headers({ "content-type": "text/html; charset=utf-8" })),
  });
}

function describeDefaultEntry(bootstrap, backendBasePath) {
  if (bootstrap.fallbackMode === "site") return bootstrap.defaultRedirect;
  if (bootstrap.fallbackMode === "login") return `登录页 ${backendBasePath || "/"}`;
  if (bootstrap.fallbackMode === "text") return `纯文本：${bootstrap.defaultText}`;
  if (bootstrap.fallbackMode === "status_code") return `HTTP ${bootstrap.defaultStatusCode}`;
  return "未配置";
}

function stripHttpsPrefix(value) {
  return String(value || "").replace(/^https?:\/\//i, "");
}
