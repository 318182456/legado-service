import { ok, err, parseBody } from "../utils";
import { Env } from "../types";
import path from "path";
import fs from "fs-extra";
import { unzipSync } from "fflate";

const GITHUB_REPO = "318182456/legado-service"; // 请确认您的仓库地址
export async function handleGetVersion(env: Env) {
  let currentVersion = "1.0.0";
  try {
    const versionPath = path.join(process.cwd(), "VERSION");
    if (await fs.pathExists(versionPath)) {
      currentVersion = (await fs.readFile(versionPath, "utf-8")).trim();
    }
  } catch (_) {}

  // 读取用户配置的 GitHub 加速网址
  let githubProxy = "https://edgeone.gh-proxy.org/";
  try {
    const row = await env.DB.prepare("SELECT value FROM system_config WHERE key = 'github_proxy'").first() as any;
    if (row && row.value !== undefined && row.value !== null) {
      githubProxy = row.value.trim();
    }
  } catch (_) {}
  const proxyPrefix = githubProxy ? (githubProxy.endsWith("/") ? githubProxy : githubProxy + "/") : "";

  try {
    const targetUrl = `${proxyPrefix}https://raw.githubusercontent.com/${GITHUB_REPO}/main/VERSION`;
    console.log(`[VersionCheck] 正在从镜像获取最新版本... 目标 URL: ${targetUrl}`);
    const res = await fetch(targetUrl, {
      headers: { "User-Agent": "LegadoSubscription-Updater" }
    });
    if (!res.ok) throw new Error("无法获取 GitHub 版本信息");
    const rawText = await res.text();
    const latestVersion = rawText.trim();
    
    return ok({
      current: currentVersion,
      latest: latestVersion,
      hasUpdate: latestVersion !== currentVersion,
      changelog: "最新开发分支版本，包含全国内加速、全新分类网页导入、后台异步测速与极速新增订阅等升级。"
    });
  } catch (e) {
    console.error("[VersionCheck] 获取版本失败，使用本地版本:", e);
    return ok({ current: currentVersion, latest: currentVersion, hasUpdate: false });
  }
}

export async function handlePerformUpdate(env: Env) {
  try {
    console.log("Starting self-update...");

    // 读取用户配置的 GitHub 加速网址
    let githubProxy = "https://edgeone.gh-proxy.org/";
    try {
      const row = await env.DB.prepare("SELECT value FROM system_config WHERE key = 'github_proxy'").first() as any;
      if (row && row.value !== undefined && row.value !== null) {
        githubProxy = row.value.trim();
      }
    } catch (_) {}
    const proxyPrefix = githubProxy ? (githubProxy.endsWith("/") ? githubProxy : githubProxy + "/") : "";

    const targetUrl = `${proxyPrefix}https://github.com/${GITHUB_REPO}/archive/refs/heads/main.zip`;
    console.log(`[SelfUpdate] 正在从镜像下载更新包... 目标 URL: ${targetUrl}`);
    const res = await fetch(targetUrl, {
      headers: { "User-Agent": "LegadoSubscription-Updater" }
    });
    if (!res.ok) throw new Error("下载更新包失败");
    
    const buffer = await res.arrayBuffer();
    const unzipped = unzipSync(new Uint8Array(buffer));
    
    // GitHub ZIP 的第一层通常是 "user-repo-hash/"
    const entries = Object.keys(unzipped);
    const rootDir = entries[0].split('/')[0] + '/';
    
    const projectRoot = process.cwd();
    const updatedFiles: string[] = [];
    
    for (const [name, data] of Object.entries(unzipped)) {
      if (name.endsWith('/') || !name.startsWith(rootDir)) continue;
      
      const relativePath = name.replace(rootDir, "");
      if (!relativePath) continue;
      
      const destPath = path.join(projectRoot, relativePath);
      
      let isNew = true;
      let isModified = false;
      
      if (await fs.pathExists(destPath)) {
        isNew = false;
        const oldContent = await fs.readFile(destPath);
        if (!oldContent.equals(Buffer.from(data))) {
          isModified = true;
        }
      }
      
      if (isNew || isModified) {
        await fs.ensureDir(path.dirname(destPath));
        await fs.writeFile(destPath, data);
        updatedFiles.push(`${isNew ? "[NEW]" : "[MOD]"} ${relativePath}`);
      }
    }
    
    try {
      console.log("Compiling frontend assets...");
      const { execSync } = await import("child_process");
      execSync("npm run build", { cwd: projectRoot });
      console.log("Frontend assets compiled successfully!");
    } catch (buildErr) {
      console.error("Frontend build failed:", buildErr);
    }
    
    console.log("Update applied successfully. Restarting...");
    
    // 延迟退出，确保响应能发出
    setTimeout(() => {
      process.exit(0); 
    }, 1000);
    
    return ok({ message: "更新已应用，系统正在重启...", updatedFiles });
  } catch (e) {
    console.error("Update failed:", e);
    return err(`更新失败: ${(e as Error).message}`);
  }
}

export async function handleGetConfig(env: Env) {
  try {
    const rows = await env.DB.prepare("SELECT key, value FROM system_config").all();
    const config: Record<string, string> = {};
    rows.results.forEach((row: any) => {
      config[row.key as string] = row.value as string;
    });
    if (!config.github_proxy) {
      config.github_proxy = "https://edgeone.gh-proxy.org/";
    }
    return ok(config);
  } catch (e: any) {
    return err(`获取配置失败: ${e.message}`);
  }
}

export async function handleSaveConfig(request: Request, env: Env) {
  const body = await parseBody<Record<string, string>>(request);
  if (!body) return err("请求体不能为空");
  
  try {
    const stmts = Object.entries(body).map(([key, value]) => {
      return env.DB.prepare(
        "INSERT INTO system_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      ).bind(key, value);
    });
    if (stmts.length > 0) {
      await env.DB.batch(stmts);
    }
    return ok({ message: "配置保存成功" });
  } catch (e: any) {
    return err(`保存配置失败: ${e.message}`);
  }
}
