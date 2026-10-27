import type { CheckOptions, CheckOutcome } from './availability-check';
import { readSourceBody } from './source-http.ts';

type Stage = 'search' | 'toc' | 'content';
const outcome = (verdict: CheckOutcome['verdict'], reason: string, detail: string): CheckOutcome => ({ verdict, reason, detail });

export function classifyReaderFailure(message: string, stage: Stage): CheckOutcome {
  if (/^reader-/.test(message)) return outcome('skipped', 'reader-unavailable', 'reader 服务未就绪或认证失效，请检查 reader 配置');
  if (/请先登录|登录后|需要登录|未登录|login.required|unauthorized|\b401\b/i.test(message)) return outcome('unavailable', 'login-required', '书源要求登录，按设置禁用');
  if (/验证码|captcha|cloudflare|challenge|人机验证|安全验证|\b403\b/i.test(message)) return outcome('skipped', 'anti-bot', '被验证或防护拦截');
  if (/\b429\b|too many|限流/i.test(message)) return outcome('skipped', 'rate-limited', '站点限流，请稍后复检');
  if (/timeout|timed out|AbortError|TimeoutError|超时/i.test(message)) return outcome('skipped', 'timeout', '请求超时，请稍后复检');
  if (/UnknownHost|ENOTFOUND|Name or service not known/i.test(message)) return outcome('unavailable', 'dns-failure', '源站域名无法解析');
  if (/ECONNREFUSED|Connection refused/i.test(message)) return outcome('unavailable', 'connection-refused', '源站拒绝连接');
  if (/\b404\b|\b410\b/.test(message)) return outcome('unavailable', 'http-error', '请求地址不存在');
  if (/Unsupported|not supported|WebView|webView|not defined|not a function|SSL|TLS|CERT|Socket|connect|\b50[0234]\b/i.test(message)) return outcome('skipped', 'engine-or-network', '检测引擎能力或网络暂时不满足，请复检');
  if (/ScriptException|EcmaError|JsonPath|XPath|解析|规则|为空|empty/i.test(message)) return outcome('unavailable', stage + '-rule-error', `${stage === 'search' ? '搜索' : stage === 'toc' ? '目录' : '正文'}规则执行失败`);
  return outcome('skipped', 'engine-error', '引擎未完成验证，请复检');
}

/** reader 真正执行原书源规则，兼容 JS/编码/签名。只做搜索和 cache=1 的试读。 */
export async function checkWithReader(src: any, options: CheckOptions): Promise<CheckOutcome> {
  const reader = options.reader!;
  const budget = AbortSignal.timeout(options.totalTimeoutMs ?? 45000);
  const call = async (path: string, payload: Record<string, unknown>) => {
    const url = `${reader.url.replace(/\/+$/, '')}/reader3${path}${reader.accessToken ? '?accessToken=' + encodeURIComponent(reader.accessToken) : ''}`;
    const res = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, bookSource: src }),
      signal: AbortSignal.any([budget, AbortSignal.timeout(options.timeoutMs ?? 15000)]),
    });
    if (res.status === 401 || res.status === 403) throw new Error('reader-auth-unavailable');
    if (!res.ok) throw new Error('reader-service-unavailable');
    const body = await readSourceBody(res);
    if (body.truncated) throw new Error('reader-response-too-large');
    const data = JSON.parse(new TextDecoder().decode(body.bytes));
    if (data.isSuccess === false || data.success === false) {
      const error = String(data.errorMsg || 'reader-error');
      if (error === '请登录后使用' || /^NEED_LOGIN\b/.test(error)) throw new Error('reader-auth-unavailable');
      throw new Error(error);
    }
    if (data.isSuccess !== true && data.success !== true) throw new Error('reader-protocol-invalid');
    return data.data;
  };
  let stage: Stage = 'search';
  try {
    const keywords = [...new Set([options.keyword || src.ruleSearch?.checkKeyWord || src.checkKeyWord || '我的', '我'])];
    let books: any[] = [];
    for (const key of keywords) {
      const result = await call('/searchBook', { key, page: 1 });
      if (!Array.isArray(result)) return outcome('skipped', 'engine-protocol', '搜索接口没有返回书籍列表');
      books = result.filter(b => b && typeof b.name === 'string' && b.name.trim() && typeof b.bookUrl === 'string' && b.bookUrl.trim());
      if (books.length) break;
    }
    if (!books.length) return outcome('skipped', 'empty-result', '测试关键词无结果，不能据此判断整个书源失效');
    if (options.depth !== 'content') return outcome('available', 'search-verified', '规则引擎已解析书名和书籍地址；尚未验证正文');
    if (Number(src.bookSourceType || 0) !== 0) return outcome('skipped', 'non-text-source', '非文字书源已通过搜索，正文检测暂不支持此类型');
    let last: CheckOutcome = outcome('skipped', 'content-unverified', '搜索可用，未能确认正文');
    for (const book of books.slice(0, 2)) {
      try {
        stage = 'toc';
        const chapters = await call('/getChapterList', { url: book.bookUrl });
        if (!Array.isArray(chapters) || !chapters.length) { last = outcome('unavailable', 'empty-toc', '试读书籍目录为空'); continue; }
        const index = chapters.findIndex(c => c && !c.isVolume && c.url && !c.isVip && !c.isPay);
        if (index < 0) { last = outcome('skipped', 'no-free-chapter', '没有可试读的免费章节'); continue; }
        stage = 'content';
        const content = await call('/getBookContent', { url: book.bookUrl, index, cache: 1 });
        if (typeof content !== 'string') { last = outcome('skipped', 'content-unverified', '正文接口返回类型不受支持'); continue; }
        if (/请先登录|请登录后|登录后阅读/.test(content)) return outcome('unavailable', 'login-required', '正文要求登录，按设置禁用');
        if (/请输入验证码|人机验证|verify you are human|cf-chl/i.test(content)) return outcome('skipped', 'anti-bot', '正文被验证拦截');
        const text = content.replace(/<[^>]*>/g, '').replace(/\s/g, '');
        if (text.length < 20) { last = outcome('unavailable', 'empty-content', '试读正文为空或不足 20 字'); continue; }
        return outcome('available', 'content-verified', '搜索、目录、免费章节正文均已通过');
      } catch (error) {
        last = classifyReaderFailure(error instanceof Error ? error.message : String(error), stage);
        if (last.reason === 'login-required' || budget.aborted) return last;
      }
    }
    return last;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/^reader-/.test(message) || error instanceof SyntaxError) return outcome('skipped', 'reader-unavailable', 'reader 服务未就绪或认证失效，请检查 reader 配置');
    return classifyReaderFailure(message, stage);
  }
}
