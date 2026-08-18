import {
  startRegistration,
  startAuthentication,
} from "@simplewebauthn/browser";

// ---------- 类型 ----------

export interface PasskeyItem {
  id: string;
  name: string;
  created_at: string;
}

export interface Subscription {
  id: number;
  name: string;
  url: string;
  type: "source" | "rule" | "txtTocRule" | "dictRule";
  enabled: number;
  last_synced: string | null;
  item_count: number;
  created_at: string;
}

export interface Stats {
  subscriptions: {
    total: number;
    sources: number;
    rules: number;
  };
  sources: { enabled: number };
  rules: { enabled: number };
}

// ---------- Token 持久化 ----------

const TOKEN_KEY = "legado_token";
export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t: string) => localStorage.setItem(TOKEN_KEY, t);
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

// ---------- 基础请求 ----------

async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(path, { ...options, headers });
  
  // 提前解析 JSON 以便统一处理 ok 字段
  const body = (await res.json().catch(() => ({ ok: false, error: res.statusText }))) as {
    ok?: boolean;
    data?: T;
    error?: string;
  };

  if (res.status === 401) {
    if (!path.includes("/api/auth/login")) {
      clearToken();
      window.dispatchEvent(new CustomEvent("unauthorized"));
    }
    throw new Error("认证失败");
  }

  if (!res.ok || body.ok === false) {
    throw new Error(body.error || res.statusText);
  }

  // 自动解包 Worker 的 { ok: true, data: T } 结构
  return body.data as T;
}

// ---------- Auth ----------

export async function login(password: string): Promise<string> {
  const data = await apiFetch<{ token: string }>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ password }),
  });
  setToken(data.token);
  return data.token;
}

export async function getPasskeyStatus(): Promise<number> {
  const data = await apiFetch<{ count: number }>("/api/auth/passkey/status");
  return data.count;
}

export async function getPasskeyList(): Promise<PasskeyItem[]> {
  return apiFetch<PasskeyItem[]>("/api/auth/passkey/list");
}

export async function deletePasskey(id: string): Promise<void> {
  await apiFetch(`/api/auth/passkey/delete/${id}`, { method: "DELETE" });
}

export async function registerPasskey(): Promise<string> {
  const options = await apiFetch<any>("/api/auth/passkey/register/begin", {
    method: "POST",
  });
  const response = await startRegistration(options);
  const result = await apiFetch<{ name: string }>(
    "/api/auth/passkey/register/finish",
    { method: "POST", body: JSON.stringify(response) }
  );
  return result.name;
}

export async function loginWithPasskey(): Promise<string> {
  const options = await apiFetch<any>("/api/auth/passkey/login/begin", {
    method: "POST",
  });
  const response = await startAuthentication(options);
  const data = await apiFetch<{ token: string }>(
    "/api/auth/passkey/login/finish",
    { method: "POST", body: JSON.stringify(response) }
  );
  setToken(data.token);
  return data.token;
}

// ---------- API ----------

export const getStats = () => apiFetch<Stats>("/api/stats");

export const getSubscriptions = () => apiFetch<Subscription[]>("/api/subscriptions");

export const addSubscription = (data: { name: string; url: string; type: "source" | "rule" }) =>
  apiFetch<any>("/api/subscriptions", { method: "POST", body: JSON.stringify(data) });

export const deleteSubscription = (id: number) =>
  apiFetch<any>(`/api/subscriptions/${id}`, { method: "DELETE" });

export const toggleSubscription = (id: number, enabled: boolean) =>
  apiFetch<any>(`/api/subscriptions/${id}`, { method: "PATCH", body: JSON.stringify({ enabled }) });

export const syncAll = () => apiFetch<any>("/api/sync", { method: "POST" });
export const syncOne = (id: number) => apiFetch<any>(`/api/sync/${id}`, { method: "POST" });

export const getSources = (q = "", page = 1, filter = "all", excludeDuplicate = false) => 
  apiFetch<{ sources: any[], total: number, totalPages: number, stats: any, hasMore: boolean }>(`/api/sources?q=${q}&page=${page}&filter=${filter}&exclude_duplicate=${excludeDuplicate}`);
export const getAllSourceIds = () => apiFetch<number[]>("/api/sources/ids");
export const getRules = (q = "", page = 1) => 
  apiFetch<{ rules: any[], total: number, totalPages: number, page: number, limit: number, hasMore: boolean }>(`/api/rules?q=${q}&page=${page}`);
export const addRule = (data: { name: string; pattern: string; replacement: string }) => apiFetch<any>("/api/rules", { method: "POST", body: JSON.stringify(data) });

export const getResources = () => apiFetch<any>("/api/resources");
export const refreshResources = () => apiFetch<any>("/api/resources/refresh", { method: "POST" });

/** verdict 为 skipped 表示本地无法判定（动态 JS 规则等），该源的可用状态保持不变 */
export type SourceCheckVerdict = "available" | "unavailable" | "skipped";
export const testSources = (ids: number[]) =>
  apiFetch<{
    verdicts: Record<number, SourceCheckVerdict>;
    reasons: Record<number, string>;
    summary: { available: number; unavailable: number; skipped: number };
  }>("/api/sources/test", { method: "POST", body: JSON.stringify({ ids }) });
export const testAllSources = () => apiFetch<any>("/api/sources/test/all", { method: "POST" });
export const stopTestSources = () => apiFetch<any>("/api/sources/test/stop", { method: "POST" });
export const getTestProgress = () => 
  apiFetch<{ current: number; total: number; running: boolean }>("/api/sources/test/progress");
export const toggleSource = (id: number, enabled: boolean) => apiFetch<any>(`/api/sources/${id}`, { method: "PATCH", body: JSON.stringify({ enabled: enabled ? 1 : 0 }) });
export const deleteSource = (id: number) => apiFetch<any>(`/api/sources/${id}`, { method: "DELETE" });
export const deleteAllSources = () => apiFetch<any>("/api/sources/all", { method: "DELETE" });
export const cleanupSources = () => apiFetch<{ markedInvalid: number; markedDuplicates: number }>("/api/sources/cleanup", { method: "POST" });
export const toggleRule = (id: number, enabled: boolean) => apiFetch<any>(`/api/rules/${id}`, { method: "PATCH", body: JSON.stringify({ enabled: enabled ? 1 : 0 }) });
export const deleteRule = (id: number) => apiFetch<any>(`/api/rules/${id}`, { method: "DELETE" });
export const updateRule = (id: number, data: { name: string; pattern: string; replacement: string }) => apiFetch<any>(`/api/rules/${id}`, { method: "PUT", body: JSON.stringify(data) });

export const getTxtTocRules = (q = "", page = 1) =>
  apiFetch<{ rules: any[], total: number, totalPages: number, page: number, limit: number }>(`/api/txt-toc-rules?q=${q}&page=${page}`);
export const addTxtTocRule = (data: { name: string; rule: string; example?: string; serialNumber?: number }) => apiFetch<any>("/api/txt-toc-rules", { method: "POST", body: JSON.stringify(data) });
export const updateTxtTocRule = (id: number, data: { name: string; rule: string; example?: string; serialNumber?: number }) => apiFetch<any>(`/api/txt-toc-rules/${id}`, { method: "PUT", body: JSON.stringify(data) });
export const toggleTxtTocRule = (id: number, enabled: boolean) => apiFetch<any>(`/api/txt-toc-rules/${id}`, { method: "PATCH", body: JSON.stringify({ enabled: enabled ? 1 : 0 }) });
export const deleteTxtTocRule = (id: number) => apiFetch<any>(`/api/txt-toc-rules/${id}`, { method: "DELETE" });
export const importTxtTocRules = (rules: any[]) => apiFetch<any>("/api/txt-toc-rules/import", { method: "POST", body: JSON.stringify({ rules }) });

export const getDictRules = (q = "", page = 1) =>
  apiFetch<{ rules: any[], total: number, totalPages: number, page: number, limit: number }>(`/api/dict-rules?q=${q}&page=${page}`);
export const addDictRule = (data: { name: string; urlRule: string; showRule?: string; sortNumber?: number }) => apiFetch<any>("/api/dict-rules", { method: "POST", body: JSON.stringify(data) });
export const updateDictRule = (id: number, data: { name: string; urlRule: string; showRule?: string; sortNumber?: number }) => apiFetch<any>(`/api/dict-rules/${id}`, { method: "PUT", body: JSON.stringify(data) });
export const toggleDictRule = (id: number, enabled: boolean) => apiFetch<any>(`/api/dict-rules/${id}`, { method: "PATCH", body: JSON.stringify({ enabled: enabled ? 1 : 0 }) });
export const deleteDictRule = (id: number) => apiFetch<any>(`/api/dict-rules/${id}`, { method: "DELETE" });
export const importDictRules = (rules: any[]) => apiFetch<any>("/api/dict-rules/import", { method: "POST", body: JSON.stringify({ rules }) });

export const importReplaceRules = (rules: any[]) => apiFetch<any>("/api/rules/import", { method: "POST", body: JSON.stringify({ rules }) });
export const importSources = (sources: any[]) => apiFetch<any>("/api/sources/import", { method: "POST", body: JSON.stringify({ sources }) });
export const importSubscriptions = (subscriptions: any[]) => apiFetch<any>("/api/subscriptions/import", { method: "POST", body: JSON.stringify({ subscriptions }) });


export const parseLinks = (url: string) => apiFetch<{ name: string; url: string }[]>(`/api/parse-links?url=${encodeURIComponent(url)}`);
export const getParseHistory = () => apiFetch<string[]>("/api/parse-history");
export const deleteParseHistory = (url?: string) =>
  apiFetch<any>(`/api/parse-history${url ? `?url=${encodeURIComponent(url)}` : ""}`, { method: "DELETE" });

export const getCustomThemes = () => apiFetch<any[]>(`/api/custom-themes?t=${Date.now()}`);
export const saveCustomTheme = (data: { name: string; config: string; preview_url?: string }) => 
  apiFetch<any>("/api/custom-themes", { method: "POST", body: JSON.stringify(data) });
export const deleteCustomTheme = (id: number) => 
  apiFetch<any>(`/api/custom-themes/${id}`, { method: "DELETE" });

export const ensureAsset = async (file: Blob, category: string, name: string) => {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('category', category);
  formData.append('name', name);

  // 注意：这里手动处理 fetch，因为 apiFetch 默认设置了 Content-Type: application/json
  const token = getToken();
  const res = await fetch('/api/assets/ensure', {
    method: 'POST',
    headers: token ? { "Authorization": `Bearer ${token}` } : {},
    body: formData
  });

  const body = (await res.json()) as { ok: boolean; path?: string; error?: string };
  if (!res.ok || body.ok === false) throw new Error(body.error || '上传失败');
  return body.path as string;
};

export const listZipAssets = (path: string) => 
  apiFetch<{ name: string; path: string; size: number }[]>(`/api/zip/list?path=${encodeURIComponent(path)}`);

export const extractAssetFromZip = (zipPath: string, internalPath: string, category: string) => 
  apiFetch<{ path: string }>("/api/zip/extract", { 
    method: "POST", 
    body: JSON.stringify({ zipPath, internalPath, category }) 
  });

export const getSystemVersion = () => 
  apiFetch<{ current: string, latest: string, hasUpdate: boolean, changelog?: string }>("/api/system/version");

export const performUpdate = () => 
  apiFetch<any>("/api/system/update", { method: "POST" });

export const getSystemConfig = () =>
  apiFetch<Record<string, string>>("/api/system/config");

export const saveSystemConfig = (config: Record<string, string>) =>
  apiFetch<any>("/api/system/config", {
    method: "POST",
    body: JSON.stringify(config)
  });

// ---------- 段评 ----------

export interface ReviewItem {
  id: number;
  book_key: string;
  chapter_key: string;
  para_index: number;
  author: string;
  badge: string | null;
  content: string;
  reply_to: number | null;
  origin: "ai" | "human";
  like_count: number;
  created_at: string;
}

export interface ReviewBook {
  book_key: string;
  book_name: string;
  author: string;
  chapter_count: number;
  failed_count: number;
}

export interface ReviewConfig {
  provider: string;
  model: string;
  baseUrl: string;
  hasApiKey: boolean;
  density: number;
  personas: string[];
  defaultPersonas: string[];
  autoFetch: boolean;
  readerUrl: string;
  effectiveReaderUrl: string;
  stats: { aiCount: number; humanCount: number; chapterCount: number; failedCount: number };
}

export const getReviewConfig = () => apiFetch<ReviewConfig>("/api/reviews/config");

export const getReviewBooks = (page = 1) =>
  apiFetch<{ books: ReviewBook[]; total: number; totalPages: number; page: number }>(
    `/api/reviews/books?page=${page}`
  );

export const getReviews = (bookKey = "", chapterKey = "", page = 1) =>
  apiFetch<{ reviews: ReviewItem[]; total: number; totalPages: number; page: number }>(
    `/api/reviews?bookKey=${encodeURIComponent(bookKey)}&chapterKey=${encodeURIComponent(chapterKey)}&page=${page}`
  );

export const addReview = (data: {
  bookName: string;
  author?: string;
  chapterTitle: string;
  paraIndex: number;
  content: string;
  penName?: string;
  replyTo?: number;
}) => apiFetch<{ id: number; bookKey: string; chapterKey: string }>("/api/reviews", {
  method: "POST",
  body: JSON.stringify(data),
});

export const deleteReview = (id: number) =>
  apiFetch<any>(`/api/reviews/${id}`, { method: "DELETE" });

export interface DiagStep {
  name: string;
  status: "ok" | "fail" | "skip";
  ok: boolean;
  detail: string;
}

export const diagnoseReview = (data: {
  bookName: string;
  author?: string;
  chapterTitle: string;
  bookUrl?: string;
  origin?: string;
  generate?: boolean;
}) =>
  apiFetch<{ steps: DiagStep[]; canGenerate: boolean }>("/api/reviews/diagnose", {
    method: "POST",
    body: JSON.stringify(data),
  });

export const getReviewMixin = () =>
  apiFetch<{ script: string }>("/api/reviews/mixin");

export const getReviewJsSource = () =>
  apiFetch<{ script: string }>("/api/reviews/js-source");

export interface InjectResult {
  mode: "inject" | "revoke";
  changed: number;
  renamed: number;
  jsSkipped: number;
  untouched: number;
  broken: number;
  hasToken: boolean;
  origin: string;
}

export const injectReviewRule = (
  opts: { subscriptionId?: number; revoke?: boolean; markName?: boolean; mark?: string } = {}
) =>
  apiFetch<InjectResult>("/api/reviews/inject", {
    method: "POST",
    body: JSON.stringify(opts),
  });

export const clearAiReviews = (bookKey: string, chapterKey?: string) =>
  apiFetch<any>("/api/reviews/clear-ai", {
    method: "POST",
    body: JSON.stringify({ bookKey, chapterKey }),
  });



