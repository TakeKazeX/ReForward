import { UA_MAP } from "./constants.js";
import { baseResponseHeaders, HttpError } from "./utils.js";

export async function handlePublicRoute({ request, url, routePath, route }) {
  const publicBasePath = `/${route.slug}`;
  const publicProxyCacheControl = route.publicProxyCacheControl || "no-store";
  const publicProxyCacheTtlSeconds = Number(route.publicProxyCacheTtlSeconds) || 0;

  if (route.kind === "redirect") {
    return Response.redirect(route.targetUrl, 302);
  }

  if (route.kind === "text") {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: baseResponseHeaders(new Headers({ Allow: "GET, HEAD" })),
      });
    }

    return new Response(request.method === "HEAD" ? null : route.content, {
      status: 200,
      headers: baseResponseHeaders(new Headers({ "content-type": "text/plain; charset=utf-8" })),
    });
  }

  if (route.kind === "proxy") {
    const targetUrl = parseTargetUrl(route.targetUrl);
    appendSearchParams(targetUrl, url.searchParams);
    return performProxy({
      request,
      targetUrl,
      workerOrigin: url.origin,
      publicBasePath,
      targetBaseUrl: route.targetUrl,
      enableHtmlRewrite: false,
      enableCors: route.enableCors,
      stripCookies: route.stripCookies,
      blockPrivateTargets: route.blockPrivateTargets,
      userAgent: route.userAgent,
      publicProxyCacheControl,
      publicProxyCacheTtlSeconds,
    });
  }

  if (route.kind === "site") {
    const targetUrl = buildSiteTargetUrl(route.targetUrl, publicBasePath, routePath, url.search);
    return performProxy({
      request,
      targetUrl,
      workerOrigin: url.origin,
      publicBasePath,
      targetBaseUrl: route.targetUrl,
      enableHtmlRewrite: route.rewriteHtml,
      enableCors: route.enableCors,
      stripCookies: route.stripCookies,
      blockPrivateTargets: route.blockPrivateTargets,
      userAgent: route.userAgent,
      publicProxyCacheControl,
      publicProxyCacheTtlSeconds,
    });
  }

  throw new HttpError(400, "Unsupported route kind");
}

export async function handleFallbackSiteRoute({
  request,
  url,
  routePath,
  targetBaseUrl,
  publicProxyCacheControl = "no-store",
  publicProxyCacheTtlSeconds = 0,
}) {
  const targetUrl = buildSiteTargetUrl(targetBaseUrl, "", routePath, url.search);
  return performProxy({
    request,
    targetUrl,
    workerOrigin: url.origin,
    publicBasePath: "",
    targetBaseUrl,
    enableHtmlRewrite: true,
    enableCors: false,
    stripCookies: true,
    blockPrivateTargets: true,
    userAgent: "",
    publicProxyCacheControl,
    publicProxyCacheTtlSeconds,
  });
}

export function parseTargetUrl(rawUrl) {
  let targetUrl;
  try {
    targetUrl = new URL(rawUrl);
  } catch {
    throw new HttpError(400, "Invalid target URL");
  }

  if (targetUrl.protocol !== "http:" && targetUrl.protocol !== "https:") {
    throw new HttpError(400, "Only http/https targets are supported");
  }

  if (targetUrl.username || targetUrl.password) {
    throw new HttpError(400, "Target URL must not include credentials");
  }

  return targetUrl;
}

async function performProxy({
  request,
  targetUrl,
  workerOrigin,
  publicBasePath,
  targetBaseUrl,
  enableHtmlRewrite,
  enableCors,
  stripCookies,
  blockPrivateTargets,
  userAgent,
  publicProxyCacheControl,
  publicProxyCacheTtlSeconds,
}) {
  if (blockPrivateTargets && isBlockedHost(targetUrl.hostname)) {
    throw new HttpError(403, "Blocked target");
  }

  if (request.method === "CONNECT" || request.method === "TRACE") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: baseResponseHeaders(new Headers()),
    });
  }

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: enableCors ? 204 : 405,
      headers: buildProxyResponseHeaders(
        new Headers(),
        enableCors,
        stripCookies,
        enableHtmlRewrite,
        publicProxyCacheControl
      ),
    });
  }

  const newHeaders = new Headers(request.headers);

  for (const name of [...newHeaders.keys()]) {
    const lower = name.toLowerCase();
    if (lower.startsWith("cf-") || lower.startsWith("x-forwarded")) {
      newHeaders.delete(name);
    }
  }

  if (stripCookies) newHeaders.delete("cookie");
  newHeaders.delete("authorization");
  newHeaders.delete("host");

  if (newHeaders.has("origin")) {
    newHeaders.set("origin", targetUrl.origin);
  }

  if (userAgent) {
    newHeaders.set("user-agent", UA_MAP[userAgent] || userAgent);
  }

  const upstreamReferer = newHeaders.get("referer");
  if (upstreamReferer) {
    const mappedReferer = mapPublicUrlToTarget(upstreamReferer, workerOrigin, publicBasePath, targetBaseUrl);
    newHeaders.set("referer", mappedReferer || `${targetUrl.origin}/`);
  } else {
    newHeaders.set("referer", `${targetUrl.origin}/`);
  }

  const upstreamResponse = await fetch(targetUrl.toString(), {
    method: request.method,
    headers: newHeaders,
    body: canHaveBody(request.method) ? request.body : undefined,
    redirect: "manual",
    cf: buildProxyCfOptions(request.method, stripCookies, publicProxyCacheTtlSeconds),
  });

  const outHeaders = new Headers(upstreamResponse.headers);
  buildProxyResponseHeaders(outHeaders, enableCors, stripCookies, enableHtmlRewrite, publicProxyCacheControl);

  if ([301, 302, 303, 307, 308].includes(upstreamResponse.status)) {
    const location = upstreamResponse.headers.get("location");
    if (location) {
      const absolute = new URL(location, targetUrl).toString();
      outHeaders.set(
        "location",
        buildPublicUrl(absolute, workerOrigin, publicBasePath, targetBaseUrl)
      );
    }
  }

  const contentType = (upstreamResponse.headers.get("content-type") || "").toLowerCase();

  if (enableHtmlRewrite && contentType.includes("text/html")) {
    outHeaders.delete("content-length");

    const rewriteState = {
      currentBaseUrl: new URL(targetUrl.toString()),
      workerOrigin,
      publicBasePath,
      targetBaseUrl: new URL(targetBaseUrl),
    };

    const rewriter = new HTMLRewriter()
      .on("meta[http-equiv]", makeMetaHttpEquivHandler(rewriteState))
      .on("a[href]", makeAttrHandler("href", rewriteState))
      .on("link[href]", makeAttrHandler("href", rewriteState))
      .on("script[src]", makeAttrHandler("src", rewriteState))
      .on("img[src]", makeAttrHandler("src", rewriteState))
      .on("img[srcset]", makeSrcsetHandler(rewriteState))
      .on("source[src]", makeAttrHandler("src", rewriteState))
      .on("source[srcset]", makeSrcsetHandler(rewriteState))
      .on("video[src]", makeAttrHandler("src", rewriteState))
      .on("audio[src]", makeAttrHandler("src", rewriteState))
      .on("track[src]", makeAttrHandler("src", rewriteState))
      .on("iframe[src]", makeAttrHandler("src", rewriteState))
      .on("form[action]", makeAttrHandler("action", rewriteState))
      .on("base[href]", makeBaseHandler(rewriteState))
      .on("[style]", makeStyleAttrHandler(rewriteState))
      .on("style", makeStyleTagHandler(rewriteState))
      .on("head", {
        element(el) {
          el.append(makePrefixPatchScript(publicBasePath), { html: true });
        },
      });

    return rewriter.transform(
      new Response(upstreamResponse.body, {
        status: upstreamResponse.status,
        headers: outHeaders,
      })
    );
  }

  if (enableHtmlRewrite && contentType.includes("text/css")) {
    outHeaders.delete("content-length");
    const css = await upstreamResponse.text();
    const rewritten = rewriteCss(css, {
      currentBaseUrl: new URL(targetUrl.toString()),
      workerOrigin,
      publicBasePath,
      targetBaseUrl: new URL(targetBaseUrl),
    });
    return new Response(rewritten, {
      status: upstreamResponse.status,
      headers: outHeaders,
    });
  }

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    headers: outHeaders,
  });
}

function canHaveBody(method) {
  return method !== "GET" && method !== "HEAD";
}

function buildSiteTargetUrl(targetBaseUrl, publicBasePath, routePath, search) {
  const targetUrl = parseTargetUrl(targetBaseUrl);
  const suffix = routePath === publicBasePath ? "/" : routePath.slice(publicBasePath.length);
  targetUrl.pathname = joinTargetPath(targetUrl.pathname, suffix || "/");
  appendSearchParams(targetUrl, new URLSearchParams(search));
  return targetUrl;
}

function joinTargetPath(basePath, suffixPath) {
  const normalizedBasePath = normalizeTargetBasePath(basePath);
  const normalizedSuffix = suffixPath && suffixPath !== "/" ? suffixPath : "";

  if (normalizedBasePath === "/") {
    return normalizedSuffix || "/";
  }

  return `${normalizedBasePath}${normalizedSuffix}` || "/";
}

function normalizeTargetBasePath(pathname) {
  if (!pathname || pathname === "/") return "/";
  return pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

function buildPublicUrl(absoluteUrl, workerOrigin, publicBasePath, targetBaseUrl) {
  if (publicBasePath == null || !targetBaseUrl) return absoluteUrl;

  const resolved = new URL(absoluteUrl);
  const targetBase = targetBaseUrl instanceof URL ? targetBaseUrl : new URL(targetBaseUrl);
  if (resolved.origin !== targetBase.origin) return absoluteUrl;

  const basePath = normalizeTargetBasePath(targetBase.pathname);
  let suffix = null;

  if (basePath === "/") {
    suffix = resolved.pathname;
  } else if (resolved.pathname === basePath) {
    suffix = "/";
  } else if (resolved.pathname.startsWith(`${basePath}/`)) {
    suffix = resolved.pathname.slice(basePath.length);
  }

  if (suffix == null) return absoluteUrl;

  const publicPath = suffix === "/" ? publicBasePath : `${publicBasePath}${suffix}`;
  return `${workerOrigin}${publicPath}${resolved.search}${resolved.hash}`;
}

function mapPublicUrlToTarget(referer, workerOrigin, publicBasePath, targetBaseUrl) {
  try {
    const url = new URL(referer);
    if (url.origin !== workerOrigin) return null;
    if (url.pathname !== publicBasePath && !url.pathname.startsWith(`${publicBasePath}/`)) return null;

    const suffix = url.pathname === publicBasePath ? "/" : url.pathname.slice(publicBasePath.length);
    const target = new URL(targetBaseUrl);
    target.pathname = joinTargetPath(target.pathname, suffix);
    target.search = url.search;
    target.hash = url.hash;
    return target.toString();
  } catch {
    return null;
  }
}

function makeAttrHandler(attrName, rewriteState) {
  return {
    element(el) {
      const raw = el.getAttribute(attrName);
      const rewritten = rewriteAttrUrl(raw, rewriteState);
      if (rewritten !== raw) {
        el.setAttribute(attrName, rewritten);
      }
    },
  };
}

function makeSrcsetHandler(rewriteState) {
  return {
    element(el) {
      const raw = el.getAttribute("srcset");
      if (!raw) return;

      const rewritten = raw
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => {
          const pieces = part.split(/\s+/);
          const nextUrl = rewriteAttrUrl(pieces[0], rewriteState);
          return pieces.length > 1 ? `${nextUrl} ${pieces.slice(1).join(" ")}` : nextUrl;
        })
        .join(", ");

      if (rewritten !== raw) {
        el.setAttribute("srcset", rewritten);
      }
    },
  };
}

function makeStyleAttrHandler(rewriteState) {
  return {
    element(el) {
      const raw = el.getAttribute("style");
      if (!raw) return;
      const rewritten = rewriteCss(raw, rewriteState);
      if (rewritten !== raw) {
        el.setAttribute("style", rewritten);
      }
    },
  };
}

function makeStyleTagHandler(rewriteState) {
  return {
    text(text) {
      const rewritten = rewriteCss(text.text, rewriteState);
      if (rewritten !== text.text) {
        text.replace(rewritten, { html: false });
      }
    },
  };
}

function makeMetaHttpEquivHandler(rewriteState) {
  return {
    element(el) {
      const httpEquiv = (el.getAttribute("http-equiv") || "").toLowerCase();
      if (httpEquiv === "content-security-policy") {
        el.remove();
        return;
      }

      if (httpEquiv === "refresh") {
        const content = el.getAttribute("content") || "";
        const match = content.match(/^\s*(\d+)\s*;\s*url\s*=\s*(.+)\s*$/i);
        if (!match) return;

        const delay = match[1];
        const rawUrl = match[2].replace(/^['"]|['"]$/g, "");
        const nextUrl = rewriteAttrUrl(rawUrl, rewriteState);
        el.setAttribute("content", `${delay}; url=${nextUrl}`);
      }
    },
  };
}

function makeBaseHandler(rewriteState) {
  return {
    element(el) {
      const raw = el.getAttribute("href");
      if (!raw) return;

      try {
        rewriteState.currentBaseUrl = raw.startsWith("//")
          ? new URL(`${rewriteState.currentBaseUrl.protocol}${raw}`)
          : new URL(raw, rewriteState.currentBaseUrl);
      } catch {
        return;
      }

      const rewritten = buildPublicUrl(
        rewriteState.currentBaseUrl.toString(),
        rewriteState.workerOrigin,
        rewriteState.publicBasePath,
        rewriteState.targetBaseUrl
      );

      if (rewritten !== raw) {
        el.setAttribute("href", rewritten);
      }
    },
  };
}

function rewriteAttrUrl(raw, rewriteState) {
  if (!raw) return raw;

  const trimmed = raw.trim();
  if (
    trimmed.startsWith("#") ||
    trimmed.startsWith("data:") ||
    trimmed.startsWith("mailto:") ||
    trimmed.startsWith("tel:") ||
    trimmed.startsWith("javascript:")
  ) {
    return raw;
  }

  let absolute;
  try {
    absolute = trimmed.startsWith("//")
      ? new URL(`${rewriteState.currentBaseUrl.protocol}${trimmed}`)
      : new URL(trimmed, rewriteState.currentBaseUrl);
  } catch {
    return raw;
  }

  return buildPublicUrl(
    absolute.toString(),
    rewriteState.workerOrigin,
    rewriteState.publicBasePath,
    rewriteState.targetBaseUrl
  );
}

function rewriteCss(cssText, rewriteState) {
  let out = cssText;

  out = out.replace(/@import\s+(url\()?['"]?([^'")\s]+)['"]?\)?\s*;/gi, (full, _url, value) => {
    const nextUrl = rewriteAttrUrl(value, rewriteState);
    return full.replace(value, nextUrl);
  });

  out = out.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (_full, _quote, value) => {
    const nextUrl = rewriteAttrUrl(value, rewriteState);
    return `url("${nextUrl}")`;
  });

  return out;
}

function makePrefixPatchScript(publicBasePath) {
  const safePrefix = publicBasePath.replace(/"/g, '\\"');
  return `<script>
(() => {
  const prefix = "${safePrefix}";
  const shouldRewrite = (url) => typeof url === "string" && url.startsWith("/") && !url.startsWith(prefix + "/") && url !== prefix;
  const fix = (url) => shouldRewrite(url) ? prefix + url : url;
  const rewriteSameOrigin = (url) => {
    try {
      const parsed = url instanceof URL ? url : new URL(String(url), location.origin);
      if (parsed.origin !== location.origin) return url;
      return fix(parsed.pathname + parsed.search + parsed.hash);
    } catch {
      return url;
    }
  };

  const originalFetch = window.fetch;
  window.fetch = function(input, init) {
    try {
      if (typeof input === "string") {
        return originalFetch.call(this, input.startsWith("/") ? fix(input) : rewriteSameOrigin(input), init);
      }
      if (input instanceof URL) {
        return originalFetch.call(this, rewriteSameOrigin(input), init);
      }
      if (typeof Request !== "undefined" && input instanceof Request) {
        const original = new URL(input.url);
        if (original.origin === location.origin) {
          const fixed = fix(original.pathname + original.search + original.hash);
          if (fixed !== original.pathname + original.search + original.hash) {
            return originalFetch.call(this, new Request(new URL(fixed, location.origin).toString(), input), init);
          }
        }
      }
    } catch {}
    return originalFetch.call(this, input, init);
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    try {
      url = typeof url === "string" && url.startsWith("/") ? fix(url) : rewriteSameOrigin(url);
    } catch {}
    return originalOpen.call(this, method, url, ...rest);
  };
})();
</script>`;
}

function appendSearchParams(targetUrl, incomingSearchParams) {
  const query = incomingSearchParams.toString();
  if (!query) return;
  targetUrl.search = targetUrl.search ? `${targetUrl.search}&${query}` : `?${query}`;
}

function isBlockedHost(hostname) {
  const lowered = hostname.toLowerCase();
  if (
    lowered === "localhost" ||
    lowered.endsWith(".localhost") ||
    lowered.endsWith(".local") ||
    lowered.endsWith(".internal") ||
    lowered.endsWith(".home.arpa")
  ) {
    return true;
  }

  const ipv4 = parseIpv4Address(lowered);
  if (ipv4) return isBlockedIpv4(ipv4);

  const ipv6 = parseIpv6Address(lowered);
  if (ipv6) return isBlockedIpv6(ipv6);

  return false;
}

function buildProxyCfOptions(method, stripCookies, publicProxyCacheTtlSeconds) {
  if (!["GET", "HEAD"].includes(method)) return undefined;
  if (!stripCookies) return undefined;
  if (!Number.isInteger(publicProxyCacheTtlSeconds) || publicProxyCacheTtlSeconds <= 0) return undefined;
  return {
    cacheEverything: true,
    cacheTtl: publicProxyCacheTtlSeconds,
  };
}

function buildProxyResponseHeaders(
  headers,
  enableCors,
  stripCookies = false,
  enableHtmlRewrite = false,
  publicProxyCacheControl = "no-store"
) {
  headers.set("x-robots-tag", "noindex, nofollow, nosnippet");
  headers.set("referrer-policy", "no-referrer");
  headers.set("allow", "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS");
  headers.set("x-content-type-options", "nosniff");

  if (publicProxyCacheControl !== "pass-through") {
    headers.set("cache-control", publicProxyCacheControl || "no-store");
  }

  if (enableHtmlRewrite) {
    headers.delete("content-security-policy");
    headers.delete("content-security-policy-report-only");
  }

  if (stripCookies) {
    headers.delete("set-cookie");
  }

  if (enableCors) {
    headers.set("access-control-allow-origin", "*");
    headers.set("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS, PATCH");
    headers.set("access-control-allow-headers", "*");
  } else {
    headers.delete("access-control-allow-origin");
    headers.delete("access-control-allow-methods");
    headers.delete("access-control-allow-headers");
  }

  return headers;
}

function parseIpv4Address(hostname) {
  const match = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return null;

  const octets = match.slice(1).map(Number);
  if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }

  return octets;
}

function isBlockedIpv4(octets) {
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 0) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
}

function parseIpv6Address(hostname) {
  if (!hostname.includes(":")) return null;

  let head = hostname;
  let ipv4Tail = null;
  if (hostname.includes(".")) {
    const lastColon = hostname.lastIndexOf(":");
    if (lastColon === -1) return null;
    ipv4Tail = parseIpv4Address(hostname.slice(lastColon + 1));
    if (!ipv4Tail) return null;
    head = hostname.slice(0, lastColon);
  }

  const pieces = head.split("::");
  if (pieces.length > 2) return null;

  const left = pieces[0] ? pieces[0].split(":").filter(Boolean) : [];
  const right = pieces.length === 2 && pieces[1] ? pieces[1].split(":").filter(Boolean) : [];
  const mappedIpv4Groups = ipv4Tail ? 2 : 0;
  const requiredZeroGroups = 8 - left.length - right.length - mappedIpv4Groups;
  if (requiredZeroGroups < 0) return null;
  if (pieces.length === 1 && requiredZeroGroups !== 0) return null;

  const groups = [
    ...left.map(parseIpv6Group),
    ...new Array(requiredZeroGroups).fill(0),
    ...right.map(parseIpv6Group),
  ];
  if (groups.some((value) => value == null)) return null;

  if (ipv4Tail) {
    groups.push((ipv4Tail[0] << 8) | ipv4Tail[1], (ipv4Tail[2] << 8) | ipv4Tail[3]);
  }

  return groups.length === 8 ? groups : null;
}

function parseIpv6Group(value) {
  if (!/^[0-9a-f]{1,4}$/i.test(value)) return null;
  return Number.parseInt(value, 16);
}

function isBlockedIpv6(groups) {
  if (groups.every((value) => value === 0)) return true;
  if (groups.slice(0, 7).every((value) => value === 0) && groups[7] === 1) return true;
  if ((groups[0] & 0xfe00) === 0xfc00) return true;
  if ((groups[0] & 0xffc0) === 0xfe80) return true;
  if ((groups[0] & 0xff00) === 0xff00) return true;

  const isIpv4Mapped =
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0xffff;
  if (isIpv4Mapped) {
    return isBlockedIpv4([
      groups[6] >> 8,
      groups[6] & 0xff,
      groups[7] >> 8,
      groups[7] & 0xff,
    ]);
  }

  return false;
}
