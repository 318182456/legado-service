export async function proxyToReader(request: Request, readerUrl: string): Promise<Response> {
  const url = new URL(request.url);
  
  // 确保拼接后的 URL 正确，处理 readerUrl 尾部斜杠问题
  const cleanReaderUrl = readerUrl.endsWith('/') ? readerUrl.slice(0, -1) : readerUrl;
  const targetUrl = `${cleanReaderUrl}${url.pathname}${url.search}`;
  
  console.log(`[Proxy] 代理请求: ${request.method} ${url.pathname} -> ${targetUrl}`);

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
      const targetDestUrl = `${cleanReaderUrl}${destUrl.pathname}${destUrl.search}`;
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
    const body = await res.arrayBuffer();

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
