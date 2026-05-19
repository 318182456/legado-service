function rewritePath(pathname: string): string {
  // 静态资源保持原样（它们本来就包含 /reader3 且在 contextPath 下也是位于 /reader3 根目录）
  const isStaticAsset = 
    pathname === '/reader3' || 
    pathname === '/reader3/' ||
    pathname === '/reader3/index.html' ||
    pathname === '/reader3/manifest.json' ||
    pathname === '/reader3/sw.js' ||
    pathname === '/reader3/robots.txt' ||
    pathname.startsWith('/reader3/static/') ||
    pathname.startsWith('/reader3/js/') ||
    pathname.startsWith('/reader3/css/') ||
    pathname.startsWith('/reader3/img/') ||
    pathname.startsWith('/reader3/fonts/') ||
    pathname.startsWith('/reader3/favicon.ico');

  if (isStaticAsset) {
    return pathname;
  }

  // 针对 WebDAV 或是其它 API，如果已经是 /reader3 开头的非静态资源，重写为 /reader3/reader3/...
  // 如果是 /epub 或 /getBookshelf 等其它被代理的根级路由，重写为 /reader3/epub/... 或 /reader3/getBookshelf
  return '/reader3' + pathname;
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
    // 过滤掉 host 字段，避免目标服务器因 Host 不匹配而拒绝服务
    if (key.toLowerCase() === 'host') continue;
    headers.set(key, value);
  }

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
    let body: ArrayBuffer | Uint8Array = await res.arrayBuffer();

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

    const responseHeaders = new Headers();
    // 复制目标服务器的所有响应头
    for (const [key, value] of res.headers.entries()) {
      responseHeaders.set(key, value);
    }

    // 强制追加 CORS 响应头，确保跨域安全
    responseHeaders.set('Access-Control-Allow-Origin', '*');
    responseHeaders.set('Access-Control-Allow-Credentials', 'true');
    responseHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PROPFIND, MKCOL, MOVE, COPY, LOCK, UNLOCK');
    responseHeaders.set('Access-Control-Allow-Headers', '*');

    // ─── 修正 Content-Length 头部防止 sw.js 被截断 ───
    if (url.pathname === '/reader3/sw.js' && res.status === 200) {
      responseHeaders.set('Content-Length', body.byteLength.toString());
    }

    const hasNullBody = [101, 204, 205, 304].includes(res.status);
    return new Response(hasNullBody ? null : body, {
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
