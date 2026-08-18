/**
 * Legado Subscription — Cloudflare Worker 入口
 */

import { Env } from "./types";
import {
  err,
  ensureDatabase,
  schemaVerified,
} from "./utils";

import * as auth from "./handlers/auth";
import * as subs from "./handlers/subscriptions";
import * as sources from "./handlers/sources";
import * as rules from "./handlers/rules";
import * as assets from "./handlers/assets";
import * as subscribe from "./handlers/subscribe";
import * as system from "./handlers/system";
import { handleScheduled } from "./handlers/scheduled";
import { proxyToReader } from "./handlers/proxy";
import * as txtTocRules from "./handlers/txt-toc-rules";
import * as dictRules from "./handlers/dict-rules";
import * as reviews from "./handlers/reviews";

export default {
  async fetch(request: Request, env: Env, ctx: any): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();

    // 拦截并代理所有 Reader 及 WebDAV 相关请求
    if (
      path.startsWith("/reader3/") ||
      path.startsWith("/epub/") ||
      path === "/assets/reader.css" ||
      path === "/getBookshelf" ||
      path === "/getChapterList" ||
      path === "/getBookContent" ||
      path === "/saveBookProgress" ||
      path === "/saveBook" ||
      path === "/deleteBook" ||
      path === "/getUserConfig" ||
      path === "/saveUserConfig" ||
      path === "/getBookSources" ||
      path === "/saveBookSource" ||
      path === "/deleteBookSource"
    ) {
      if (env.READER_URL) {
        return proxyToReader(request, env.READER_URL);
      }
    }

    // 数据库运行时初始化
    // 仅针对写操作或未经验证的实例执行初始化检查，且优先依赖内存缓存
    if (path.startsWith("/api/") || path.startsWith("/review/")) {
      const isWrite = method !== "GET";
      if (isWrite || !schemaVerified) {
        try {
          await ensureDatabase(env);
        } catch (e) {
          return err(`Database Init Failed: ${(e as Error).message}`, 500);
        }
      }
    }

    // OPTIONS 预检
    if (method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, DELETE, PATCH, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    try {
      // ── /subscribe/* (公开) ───────────────────────────────────────
      if (path === "/subscribe/sources" && method === "GET") return subscribe.handleSubscribeOutput(env, "sources");
      if (path === "/subscribe/rules" && method === "GET") return subscribe.handleSubscribeOutput(env, "rules");
      if (path === "/subscribe/txtTocRules" && method === "GET") return subscribe.handleSubscribeOutput(env, "txtTocRules");
      if (path === "/subscribe/dictRules" && method === "GET") return subscribe.handleSubscribeOutput(env, "dictRules");
      if (path === "/subscribe/index" && method === "GET") return subscribe.handleSubscribeIndex(request, env);
      if (path === "/subscribe/info.json" && method === "GET") return subscribe.handleSubscribeInfo(request);

      // ── /review/* (公开，供 Legado JS 书源调用) ───────────────────
      if (path === "/review/summary" && method === "POST") return reviews.handleReviewSummary(request, env);
      if (path === "/review/summary" && method === "GET") return reviews.handleReviewSummaryQuery(env, url);
      if (path === "/review/detail" && method === "GET") return reviews.handleReviewDetail(env, url);
      if (path === "/review/replies" && method === "GET") return reviews.handleReviewReplies(env, url);

      // ── /api/auth (公开) ──────────────────────────────────────────
      if (path === "/api/auth/login" && method === "POST") return auth.handleLogin(request, env);
      if (path === "/api/auth/passkey/status" && method === "GET") return auth.handlePasskeyStatus(env);
      if (path === "/api/auth/passkey/login/begin" && method === "POST") return auth.handlePasskeyLoginBegin(request, env);
      if (path === "/api/auth/passkey/login/finish" && method === "POST") return auth.handlePasskeyLoginFinish(request, env);

      // ── 鉴权检查 ──────────────────────────────────────────────────
      if (path.startsWith("/api/")) {
        const isPublicGet = method === "GET" && (
          path === "/api/custom-themes" || 
          path === "/api/resources" || 
          path === "/api/stats" ||
          path === "/api/zip/list" ||
          path.endsWith("/export")
        );
        if (!isPublicGet && !auth.isAuthed(request, env)) return err("Unauthorized", 401);
      }


      // ── /api/auth (鉴权) ──────────────────────────────────────────
      if (path === "/api/auth/passkey/register/begin" && method === "POST") return auth.handlePasskeyRegisterBegin(request, env);
      if (path === "/api/auth/passkey/register/finish" && method === "POST") return auth.handlePasskeyRegisterFinish(request, env);
      if (path === "/api/auth/passkey/list" && method === "GET") return auth.handlePasskeyList(env);
      if (path.startsWith("/api/auth/passkey/delete/") && method === "DELETE") {
        return auth.handlePasskeyDelete(path.split("/").pop()!, env);
      }

      // ── /api/stats ────────────────────────────────────────────────
      if (path === "/api/stats" && method === "GET") return sources.handleStats(env);

      // ── /api/sync ─────────────────────────────────────────────────
      if (path.startsWith("/api/sync") && method === "POST") {
        const idStr = path.replace("/api/sync", "").replace("/", "");
        return subs.handleSync(env, idStr ? Number(idStr) : null, ctx);
      }

      // ── /api/subscriptions ────────────────────────────────────────
      if (path === "/api/subscriptions") {
        if (method === "GET") return subs.handleListSubscriptions(env);
        if (method === "POST") return subs.handleAddSubscription(request, env, ctx);
      }
      if (path === "/api/subscriptions/import" && method === "POST") {
        return subs.handleImportSubscriptions(request, env);
      }


      const subMatch = path.match(/^\/api\/subscriptions\/(\d+)$/);
      if (subMatch) {
        const id = Number(subMatch[1]);
        if (method === "DELETE") return subs.handleDeleteSubscription(env, id);
        if (method === "PATCH") return subs.handleToggleSubscription(request, env, id);
      }

      // ── /api/sources / rules ──────────────────────────────────────
      if (path === "/api/sources" && method === "GET") return sources.handleListSources(env, url);
      if (path === "/api/sources/ids" && method === "GET") return sources.handleAllSourceIds(env);
      if (path === "/api/sources/test" && method === "POST") return sources.handleTestSources(env, request, ctx);
      if (path === "/api/sources/test/all" && method === "POST") return sources.handleTestAllSources(env, ctx);
      if (path === "/api/sources/test/stop" && method === "POST") return sources.handleStopTestSources(env);
      if (path === "/api/sources/test/progress" && method === "GET") return sources.handleGetTestProgress(env);
      if (path === "/api/sources/cleanup" && method === "POST") return sources.handleCleanupSources(env);
      if (path === "/api/sources/all" && method === "DELETE") return sources.handleSourceAction(env, 0, "delete-all");
      if (path === "/api/sources/import" && method === "POST") return sources.handleImportSources(request, env);
      if (path === "/api/parse-links" && method === "GET") return sources.handleParseLinks(env, url);
      if (path === "/api/parse-history") {
        if (method === "GET") return sources.handleListParseHistory(env);
        if (method === "DELETE") return sources.handleDeleteParseHistory(env, url);
      }

      if (path === "/api/rules") {
        if (method === "GET") return rules.handleListRules(env, url);
        if (method === "POST") return rules.handleAddRule(request, env);
      }
      if (path === "/api/rules/import" && method === "POST") return rules.handleImportRules(request, env);

      const srcMatch = path.match(/^\/api\/sources\/(\d+)$/);
      if (srcMatch) {
        const id = Number(srcMatch[1]);
        if (method === "DELETE") return sources.handleSourceAction(env, id, "delete");
        if (method === "PATCH") return sources.handleSourceAction(env, id, "toggle", request);
      }

      const ruleMatch = path.match(/^\/api\/rules\/(\d+)$/);
      if (ruleMatch) {
        const id = Number(ruleMatch[1]);
        if (method === "DELETE") return rules.handleRuleAction(env, id, "delete");
        if (method === "PATCH") return rules.handleRuleAction(env, id, "toggle", request);
        if (method === "PUT") return rules.handleRuleAction(env, id, "update", request);
      }

      // ── /api/txt-toc-rules ────────────────────────────────────────
      if (path === "/api/txt-toc-rules") {
        if (method === "GET") return txtTocRules.handleListTxtTocRules(env, url);
        if (method === "POST") return txtTocRules.handleAddTxtTocRule(request, env);
      }
      if (path === "/api/txt-toc-rules/import" && method === "POST") return txtTocRules.handleImportTxtTocRules(request, env);

      const txtTocMatch = path.match(/^\/api\/txt-toc-rules\/(\d+)$/);
      if (txtTocMatch) {
        const id = Number(txtTocMatch[1]);
        if (method === "DELETE") return txtTocRules.handleTxtTocRuleAction(env, id, "delete");
        if (method === "PATCH") return txtTocRules.handleTxtTocRuleAction(env, id, "toggle", request);
        if (method === "PUT") return txtTocRules.handleTxtTocRuleAction(env, id, "update", request);
      }

      // ── /api/dict-rules ───────────────────────────────────────────
      if (path === "/api/dict-rules") {
        if (method === "GET") return dictRules.handleListDictRules(env, url);
        if (method === "POST") return dictRules.handleAddDictRule(request, env);
      }
      if (path === "/api/dict-rules/import" && method === "POST") return dictRules.handleImportDictRules(request, env);

      const dictMatch = path.match(/^\/api\/dict-rules\/(\d+)$/);
      if (dictMatch) {
        const id = Number(dictMatch[1]);
        if (method === "DELETE") return dictRules.handleDictRuleAction(env, id, "delete");
        if (method === "PATCH") return dictRules.handleDictRuleAction(env, id, "toggle", request);
        if (method === "PUT") return dictRules.handleDictRuleAction(env, id, "update", request);
      }

      // ── /api/reviews (段评管理) ───────────────────────────────────
      if (path === "/api/reviews") {
        if (method === "GET") return reviews.handleListReviews(env, url);
        if (method === "POST") return reviews.handleAddReview(request, env);
      }
      if (path === "/api/reviews/books" && method === "GET") return reviews.handleListReviewBooks(env, url);
      if (path === "/api/reviews/config" && method === "GET") return reviews.handleGetReviewConfig(env);
      if (path === "/api/reviews/mixin" && method === "GET") return reviews.handleReviewMixinScript(request, env);
      if (path === "/api/reviews/js-source" && method === "GET") return reviews.handleReviewJsSourceTemplate(request, env);
      if (path === "/api/reviews/clear-ai" && method === "POST") return reviews.handleClearAiReviews(request, env);
      if (path === "/api/reviews/inject" && method === "POST") return reviews.handleInjectReviewRule(request, env);
      if (path === "/api/reviews/diagnose" && method === "POST") return reviews.handleDiagnoseReview(request, env);
      if (path === "/api/reviews/shelf" && method === "GET") return reviews.handleListReaderShelf(env);

      const reviewMatch = path.match(/^\/api\/reviews\/(\d+)$/);
      if (reviewMatch && method === "DELETE") {
        return reviews.handleDeleteReview(env, Number(reviewMatch[1]));
      }

      // ── /repo/* (R2 资源代理) ───────────────────────────────────
      if (path.startsWith("/repo/")) return assets.handleRepoProxy(request, env);

      // ── /api/resources (资源列表) ────────────────────────────────
      if (path === "/api/resources/refresh" && method === "POST") return assets.handleResourcesRefresh(env);
      if (path === "/api/resources" && method === "GET") return assets.handleResourcesList(env);

      // ── /api/r2-list (R2 完整文件清单) ─────────────────────────────
      if (path === "/api/r2-list" && method === "GET") return assets.handleR2List(request, env);

      // ── /api/assets/ensure (资源确保存储) ──────────────────────────
      if (path === "/api/assets/ensure" && method === "POST") return assets.handleEnsureAsset(request, env);

      // ── /api/zip (ZIP 资产管理) ───────────────────────────────────
      if (path === "/api/zip/list" && method === "GET") return assets.handleListZipAssets(request, env);
      if (path === "/api/zip/extract" && method === "POST") return assets.handleExtractAssetFromZip(request, env);

      // ── /api/custom-themes (精选主题) ──────────────────────────────
      if (path === "/api/custom-themes") {
        if (method === "GET") return assets.handleListCustomThemes(env);
        if (method === "POST") return assets.handleSaveCustomTheme(request, env);
      }
      if (path.startsWith("/api/custom-themes/") && method === "DELETE") {
        const id = Number(path.split("/").pop());
        return assets.handleDeleteCustomTheme(id, env);
      }

      const themeExportMatch = path.match(/^\/api\/custom-themes\/(\d+)\/export$/);
      if (themeExportMatch && method === "GET") {
        return assets.handleExportCustomTheme(request, env, themeExportMatch[1]);
      }

      // ── /api/system ─────────────────────────────────────────────
      if (path === "/api/system/version" && method === "GET") return system.handleGetVersion(env);
      if (path === "/api/system/update" && method === "POST") {
        if (!auth.isAuthed(request, env)) return err("Unauthorized", 401);
        return system.handlePerformUpdate(env);
      }
      if (path === "/api/system/config" && method === "GET") return system.handleGetConfig(env);
      if (path === "/api/system/config" && method === "POST") {
        if (!auth.isAuthed(request, env)) return err("Unauthorized", 401);
        return system.handleSaveConfig(request, env);
      }

      return err("Not Found", 404);
    } catch (e) {
      console.error(e);
      return new Response(JSON.stringify({ ok: false, error: `Internal Error: ${(e as Error).message}` }), {
        status: 500,
        headers: { 
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*" 
        }
      });
    }
  },

  async scheduled(event: any, env: Env, ctx: any) {
    ctx.waitUntil(handleScheduled(env));
  },
};
