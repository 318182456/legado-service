// legado-reader（hectorqin/reader）的实际路径布局：
//   · 前端静态资源由 StaticHandler 挂在后端根路径 /*（webRoot 为 jar 内的 web 目录）
//   · 接口与 WebDAV 硬编码在 /reader3/* 下
// 源码中并未读取 reader.server.contextPath，所以 READER_SERVER_CONTEXTPATH 环境变量不起作用，
// 本服务对外暴露的 /reader3/ 需要先区分「静态资源 / 接口」再决定是否剥离前缀。
const READER_PREFIX = '/reader3';

// 接口路径均为 /reader3/<单段且不含扩展名>（WebDAV 是唯一的多段例外），
// 静态资源则是首页、带扩展名的文件（index.html、sw.js、manifest.json 等）或多级目录下的资源。
function isStaticAsset(rest: string): boolean {
  const path = rest.startsWith('/') ? rest.slice(1) : rest;
  if (path === '') return true;
  if (path.startsWith('webdav')) return false;
  return path.includes('/') || path.includes('.');
}

function rewritePath(pathname: string): string {
  // 兼容前端把 api_prefix 配成 /reader3/reader3 的历史双写路径，剥掉多余的一层
  if (pathname === READER_PREFIX + READER_PREFIX || pathname.startsWith(READER_PREFIX + READER_PREFIX + '/')) {
    pathname = pathname.slice(READER_PREFIX.length);
  }

  if (pathname === READER_PREFIX || pathname.startsWith(READER_PREFIX + '/')) {
    const rest = pathname.slice(READER_PREFIX.length);
    // 静态资源位于后端根路径下，转发时剥离 /reader3 前缀
    if (isStaticAsset(rest)) {
      return rest === '' || rest === '/' ? '/' : rest;
    }
    // 接口与 WebDAV 本就在 /reader3/ 下，原样转发
    return pathname;
  }

  // 后端的 /epub/*、/assets/* 同样挂在根路径，原样转发
  if (pathname.startsWith('/epub/') || pathname.startsWith('/assets/')) {
    return pathname;
  }

  // 其余根级接口（/getBookshelf 等）补上 /reader3 前缀
  return READER_PREFIX + pathname;
}

const WEBDAV_PREFIX = READER_PREFIX + '/webdav';

function isWebdavPath(pathname: string): boolean {
  return pathname === WEBDAV_PREFIX || pathname.startsWith(WEBDAV_PREFIX + '/');
}

// 逐段传输头（RFC 7230 §6.1）不能透传，content-length 交给 fetch 按实际请求体重算。
// expect 也必须剥掉：100-continue 已由本服务的 HTTP 层应答完毕，
// 再转发给 undici 的话它会直接抛 UND_ERR_NOT_SUPPORTED，整个上传就变成 500。
const HOP_BY_HOP_REQUEST_HEADERS = new Set([
  'host', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length', 'expect',
]);

const HOP_BY_HOP_RESPONSE_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

// reader 的 webdavList 直接用 request.absoluteURI() 拼 <D:href>，经代理转发后它拿到的
// Host 是内网的 legado-reader:8080，于是 PROPFIND 结果里的 href 全是内网地址。
// legado 客户端备份收尾会用这些 href 去删除多余的旧备份，请求打到内网必然失败并抛异常，
// 结果是 zip 已经上传成功、app 却提示「WebDav备份失败」。
// 这里把 href 收敛成根相对路径 —— 也是 Nextcloud 等 WebDAV 服务端的通行写法。
function rewriteWebdavHref(xml: string): string {
  return xml.replace(
    new RegExp(`https?://[^/\\s"'<>]+(?=${WEBDAV_PREFIX})`, 'gi'),
    ''
  );
}

export async function proxyToReader(request: Request, readerUrl: string): Promise<Response> {
  const url = new URL(request.url);
  
  // 确保拼接后的 URL 正确，处理 readerUrl 尾部斜杠问题
  const cleanReaderUrl = readerUrl.endsWith('/') ? readerUrl.slice(0, -1) : readerUrl;
  const rewrittenPath = rewritePath(url.pathname);
  const targetUrl = `${cleanReaderUrl}${rewrittenPath}${url.search}`;

  const headers = new Headers();
  // 复制所有传入请求头，特别是 Authorization, Depth, Destination, Overwrite, Timeout 等
  for (const [key, value] of request.headers.entries()) {
    // 逐段传输头不能转发，其中 host 还会让目标服务器因 Host 不匹配而拒绝服务
    if (HOP_BY_HOP_REQUEST_HEADERS.has(key.toLowerCase())) continue;
    headers.set(key, value);
  }
  // fetch 会自动解压 gzip 响应体，却把 content-encoding、content-length 原样留在响应头里，
  // 透传出去客户端就会拿声明为 gzip 的明文去解压。上游是内网，直接要求不压缩最省事。
  headers.set('accept-encoding', 'identity');

  // 针对 MOVE 和 COPY 方法，修改其 Destination 目标地址
  // 因为 Destination 头是绝对 URI，需将其 Host 替换为后台 reader 服务地址
  const destination = request.headers.get('destination');
  if (destination) {
    try {
      const destUrl = new URL(destination);
      const rewrittenDestPath = rewritePath(destUrl.pathname);
      const targetDestUrl = `${cleanReaderUrl}${rewrittenDestPath}${destUrl.search}`;
      headers.set('destination', targetDestUrl);
      console.log(`[Proxy] 重写 WebDAV Destination 头: ${destination} -> ${targetDestUrl}`);
    } catch (e) {
      console.error('[Proxy] 解析 Destination 头失败:', e);
    }
  }

  const reqInit: RequestInit = {
    method: request.method,
    headers,
  };

  // 非 GET/HEAD 请求读取请求体
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    try {
      reqInit.body = await request.arrayBuffer();
    } catch (e) {
      console.error('[Proxy] 读取请求体失败:', e);
    }
  }

  try {
    const res = await fetch(targetUrl, reqInit);

    const responseHeaders = new Headers();
    // 复制目标服务器的响应头，逐段传输头与 set-cookie 除外
    for (const [key, value] of res.headers.entries()) {
      const lower = key.toLowerCase();
      if (HOP_BY_HOP_RESPONSE_HEADERS.has(lower) || lower === 'set-cookie') continue;
      responseHeaders.set(key, value);
    }
    // entries() 会把多条 set-cookie 并成一行逗号串，必须逐条取出重新 append
    const setCookies = (res.headers as any).getSetCookie?.() as string[] | undefined;
    if (setCookies && setCookies.length > 0) {
      for (const cookie of setCookies) responseHeaders.append('set-cookie', cookie);
    } else {
      const cookie = res.headers.get('set-cookie');
      if (cookie) responseHeaders.append('set-cookie', cookie);
    }

    // 强制追加 CORS 响应头，确保跨域安全
    responseHeaders.set('Access-Control-Allow-Origin', '*');
    responseHeaders.set('Access-Control-Allow-Credentials', 'true');
    responseHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PROPFIND, MKCOL, MOVE, COPY, LOCK, UNLOCK');
    responseHeaders.set('Access-Control-Allow-Headers', '*');

    const hasNullBody = [101, 204, 205, 304].includes(res.status);
    if (hasNullBody) {
      return new Response(null, { status: res.status, headers: responseHeaders });
    }

    const needsSwPatch = url.pathname === '/reader3/sw.js' && res.status === 200;
    // PROPFIND 的 207 multistatus 需要修正 href；其余 WebDAV 响应没有 body 或是文件流
    const needsHrefRewrite = res.status === 207 && isWebdavPath(url.pathname);

    // 无需改写的响应直接流式转发，避免备份/下载这类大文件在代理里整份进内存
    if (!needsSwPatch && !needsHrefRewrite) {
      return new Response(res.body, { status: res.status, headers: responseHeaders });
    }

    let body: any = await res.arrayBuffer();

    // ─── 动态注入 sw.js 异常捕获，防止 Uncaught (in promise) Failed to fetch ───
    if (url.pathname === '/reader3/sw.js' && res.status === 200) {
      try {
        const textDecoder = new TextDecoder('utf-8');
        let swText = textDecoder.decode(body);

        // 1. 拦截并优化同源 /reader3/ API 调用的 fetch 异常
        const apiTarget = 'if (request.url.indexOf("/reader3/") !== -1) {\n    return fetch(request);\n  }';
        const apiReplacement = `if (request.url.indexOf("/reader3/") !== -1) {
    return fetch(request).catch(err => {
      console.warn("ServiceWorker fetch API failed:", request.url, err);
      return new Response(JSON.stringify({ isSuccess: false, errorMsg: "网络请求失败，请检查网络连接" }), {
        status: 502,
        headers: { "Content-Type": "application/json; charset=utf-8" }
      });
    });
  }`;

        if (swText.includes(apiTarget)) {
          swText = swText.replace(apiTarget, apiReplacement);
        } else {
          swText = swText.replace(
            /if\s*\(\s*request\.url\.indexOf\(\s*["']\/reader3\/["']\s*\)\s*!==\s*-1\s*\)\s*\{\s*return\s+fetch\(\s*request\s*\);\s*\}/g,
            apiReplacement
          );
        }

        // 2. 拦截并优化 doRequest (如跨域外网图片等) 的 fetch 异常
        const fetchTarget = `    // 对于不在 caches 中的资源进行请求
    return fetch(request).then(fetchRes => {
      if (fetchRes.type === "opaque") {
        let resClone = fetchRes.clone();
        opaqueCache.put(originRequest, fetchRes);
        return resClone;
      }
      // 这里只缓存成功 && 请求是 GET 方式的结果，对于 POST 等请求，可把 indexDB 给用上
      if (!fetchRes || fetchRes.status !== 200 || request.method !== "GET") {
        return fetchRes;
      }

      // 只能缓存同源的图片、字体，跨域的资源都访问不了
      let resClone = fetchRes.clone();
      if (isImage(fetchRes) || isFont(fetchRes)) {
        siteCache.put(originRequest, fetchRes);
      }

      return resClone;
    });`;

        const fetchReplacement = `    // 对于不在 caches 中的资源进行请求
    return fetch(request).then(fetchRes => {
      if (fetchRes.type === "opaque") {
        let resClone = fetchRes.clone();
        opaqueCache.put(originRequest, fetchRes);
        return resClone;
      }
      // 这里只缓存成功 && 请求是 GET 方式的结果，对于 POST 等请求，可把 indexDB 给用上
      if (!fetchRes || fetchRes.status !== 200 || request.method !== "GET") {
        return fetchRes;
      }

      // 只能缓存同源的图片、字体，跨域的资源都访问不了
      let resClone = fetchRes.clone();
      if (isImage(fetchRes) || isFont(fetchRes)) {
        siteCache.put(originRequest, fetchRes);
      }

      return resClone;
    }).catch(err => {
      console.warn("ServiceWorker fetch failed for:", request.url, err);
      return new Response("", { status: 404, statusText: "Fetch failed" });
    });`;

        if (swText.includes(fetchTarget)) {
          swText = swText.replace(fetchTarget, fetchReplacement);
        } else {
          // 正则备用方案
          swText = swText.replace(
            /return\s+fetch\(\s*request\s*\)\.then\([\s\S]+?\}\s*\);\s*\n\s*\}\s*;/g,
            (match) => {
              return match.replace(/\)\s*;\s*\}\s*;\s*$/, ")\n    .catch(err => {\n      console.warn(\"ServiceWorker fetch failed for:\", request.url, err);\n      return new Response(\"\", { status: 404, statusText: \"Fetch failed\" });\n    });\n  };");
            }
          );
        }

        const textEncoder = new TextEncoder();
        body = textEncoder.encode(swText);
        console.log("[Proxy] 已成功对 /reader3/sw.js 进行动态 Promise.catch 异常捕获注入！");
      } catch (rewriteError) {
        console.error("[Proxy] 动态改写 sw.js 失败:", rewriteError);
      }
    }

    // ─── 把 PROPFIND 结果里的内网 href 改成根相对路径 ───
    if (needsHrefRewrite) {
      try {
        const xml = new TextDecoder('utf-8').decode(body);
        const rewritten = rewriteWebdavHref(xml);
        if (rewritten !== xml) {
          body = new TextEncoder().encode(rewritten);
          console.log(`[Proxy] 已修正 WebDAV PROPFIND 响应中的 href: ${url.pathname}`);
        }
      } catch (rewriteError) {
        console.error('[Proxy] 改写 WebDAV href 失败:', rewriteError);
      }
    }

    // 改写过的响应体长度已变，Content-Length 必须按实际字节数重算，否则会被截断
    responseHeaders.set('Content-Length', body.byteLength.toString());

    return new Response(body, {
      status: res.status,
      headers: responseHeaders,
    });
  } catch (err) {
    console.error('[Proxy] 代理请求失败:', err);
    return new Response(JSON.stringify({
      isSuccess: false,
      errorMsg: `无法连接到本地 Reader 后端服务。请检查 Reader 容器运行状态或配置 (READER_URL: ${cleanReaderUrl})`
    }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }
}
