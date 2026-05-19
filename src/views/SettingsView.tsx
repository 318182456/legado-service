import React, { useState, useEffect } from 'react';
import { Fingerprint, ShieldCheck, Plus, RefreshCw, Info, Package, Globe, SlidersHorizontal } from 'lucide-react';
import * as api from '../api';

const formatDate = (dateInput: string | number | Date) => {
  if (!dateInput) return '-';
  try {
    const date = new Date(dateInput);
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).format(date).replace(/\//g, '-');
  } catch (e) {
    return String(dateInput);
  }
};

export default function SettingsView() {
  const [passkeys, setPasskeys] = useState<api.PasskeyItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncingAll, setSyncingAll] = useState(false);
  const [versionInfo, setVersionInfo] = useState<any>(null);
  const [isUpdating, setIsUpdating] = useState(false);
  const [updatedFiles, setUpdatedFiles] = useState<string[] | null>(null);
  const [githubProxy, setGithubProxy] = useState('https://edgeone.gh-proxy.org/');
  const [defaultPageAnim, setDefaultPageAnim] = useState('2');
  const [savingConfig, setSavingConfig] = useState(false);

  const fetchPasskeys = async () => {
    try {
      const list = await api.getPasskeyList();
      setPasskeys(list);
    } catch (e) {
      console.error('获取 Passkey 失败', e);
    } finally {
      setLoading(false);
    }
  };

  const fetchVersion = async () => {
    try {
      const info = await api.getSystemVersion();
      setVersionInfo(info);
    } catch (e) {
      console.error('获取系统版本失败', e);
    }
  };

  const fetchConfig = async () => {
    try {
      const config = await api.getSystemConfig();
      if (config) {
        if (config.github_proxy) {
          setGithubProxy(config.github_proxy);
        }
        if (config.default_page_anim !== undefined) {
          setDefaultPageAnim(config.default_page_anim);
        }
      }
    } catch (e) {
      console.error('获取系统配置失败', e);
    }
  };

  useEffect(() => {
    fetchPasskeys();
    fetchVersion();
    fetchConfig();
  }, []);

  const handleUpdate = async () => {
    if (!confirm('确定要更新到最新代码版本并自动重启吗？')) return;
    setIsUpdating(true);
    setUpdatedFiles(null);
    try {
      const res = await api.performUpdate() as any;
      if (res && res.updatedFiles) {
        setUpdatedFiles(res.updatedFiles);
      }
      
      // 开始高可用健康轮询检测重启状态
      let attempts = 0;
      const interval = setInterval(async () => {
        attempts++;
        try {
          const info = await api.getSystemVersion();
          if (info && info.current) {
            clearInterval(interval);
            window.location.reload();
          }
        } catch (e) {
          console.log('正在监测系统重启状态...', attempts);
        }
        
        if (attempts > 30) { // 最多等待 30 秒
          clearInterval(interval);
          alert('系统重启可能需要较长时间，请稍后手动刷新页面。');
          setIsUpdating(false);
        }
      }, 1000);
    } catch (e) {
      alert('更新失败: ' + String(e));
      setIsUpdating(false);
    }
  };

  const handleRegister = async () => {
    try {
      const name = await api.registerPasskey();
      alert(`注册成功: ${name}`);
      fetchPasskeys();
    } catch (e) {
      alert(`注册失败: ${String(e)}`);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('确定删除此 Passkey 吗？')) return;
    try {
      await api.deletePasskey(id);
      fetchPasskeys();
    } catch (e) {
      alert(`删除失败: ${String(e)}`);
    }
  };

  const handleSyncAll = async () => {
    if (syncingAll) return;
    setSyncingAll(true);
    try {
      await api.syncAll();
      alert('同步成功');
    } catch (e) {
      alert(`同步失败: ${String(e)}`);
    } finally {
      setSyncingAll(false);
    }
  };

  const handleSaveConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingConfig(true);
    try {
      await api.saveSystemConfig({ 
        github_proxy: githubProxy.trim(),
        default_page_anim: defaultPageAnim
      });
      alert('系统与画面配置保存成功！');
    } catch (e) {
      alert(`保存失败: ${String(e)}`);
    } finally {
      setSavingConfig(false);
    }
  };


  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-3xl font-bold tracking-tight text-on-background">设置</h2>
        <p className="text-sm text-secondary mt-1">管理系统偏好、认证方式和同步配置。</p>
      </div>

      <div className="flex flex-col gap-6 max-w-4xl">
        <section className="bg-surface-container-lowest border border-outline-variant rounded-xl overflow-hidden shadow-sm">
          <div className="px-8 py-5 border-b border-outline-variant bg-surface-bright flex justify-between items-center">
            <div>
              <h3 className="font-semibold text-lg text-on-surface">Passkey 身份认证</h3>
              <p className="text-xs text-secondary mt-1">使用生物识别或硬件密钥安全登录，无需输入密码。</p>
            </div>
            <Fingerprint className="text-primary" size={24} />
          </div>
          <div className="p-8 space-y-6">
            {loading ? (
              <div className="text-center py-4 text-secondary">加载中...</div>
            ) : (
              <div className="space-y-4">
                {passkeys.length === 0 ? (
                  <div className="bg-surface-container-low p-4 rounded-lg text-center border border-dashed border-outline-variant">
                    <p className="text-sm text-secondary">尚未注册任何 Passkey</p>
                  </div>
                ) : (
                  <div className="divide-y divide-outline-variant">
                    {passkeys.map((pk) => (
                      <div key={pk.id} className="py-3 flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <ShieldCheck className="text-primary" size={20} />
                          <div>
                            <p className="text-sm font-medium">{pk.name}</p>
                            <p className="text-xs text-secondary">注册于 {formatDate(pk.created_at)}</p>
                          </div>
                        </div>
                        <button 
                          onClick={() => handleDelete(pk.id)}
                          className="text-xs text-error hover:underline"
                        >
                          删除
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <button 
                  onClick={handleRegister}
                  className="w-full flex items-center justify-center gap-2 bg-primary text-on-primary py-2.5 rounded-lg text-sm font-semibold hover:opacity-90 transition-all shadow-sm"
                >
                  <Plus size={18} />
                  注册新 Passkey
                </button>
              </div>
            )}
          </div>
          <div className="px-8 py-4 bg-surface border-t border-outline-variant">
            <div className="text-xs text-secondary flex items-start gap-2">
              <Info className="mt-0.5 shrink-0" size={16} />
              建议在常用的设备上注册 Passkey，以获得更便捷的登录体验。
            </div>
          </div>
        </section>

        <section className="bg-surface-container-lowest border border-outline-variant rounded-xl overflow-hidden shadow-sm">
          <div className="px-8 py-5 border-b border-outline-variant bg-surface-bright flex justify-between items-center">
            <div>
              <h3 className="font-semibold text-lg text-on-surface">系统版本与更新</h3>
              <p className="text-xs text-secondary mt-1">管理系统版本并获取最新功能。</p>
            </div>
            <Package className="text-primary" size={24} />
          </div>
          <div className="p-8 space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold">当前版本：v{versionInfo?.current || '1.0.0'}</p>
                <p className="text-xs text-secondary mt-1">
                  {versionInfo?.hasUpdate 
                    ? `发现新版本 v${versionInfo.latest}，建议立即升级。` 
                    : '已是最新版本。若有新提交，也可通过右侧按钮强制拉取主线最新代码进行升级。'}
                </p>
              </div>
              <button 
                onClick={handleUpdate}
                disabled={isUpdating}
                className="bg-primary text-on-primary px-4 py-2 rounded-lg text-sm font-semibold hover:opacity-90 transition-all shadow-sm flex items-center gap-2 disabled:opacity-50"
              >
                <RefreshCw size={16} className={isUpdating ? 'animate-spin' : ''} />
                {isUpdating ? '正在更新...' : versionInfo?.hasUpdate ? '立即升级' : '强制在线更新'}
              </button>
            </div>

            {updatedFiles && (
              <div className="mt-4 border border-outline-variant bg-[#1e1e1e] text-[#d4d4d4] font-mono text-xs rounded-lg overflow-hidden shadow-inner">
                <div className="bg-[#2d2d2d] px-4 py-2 border-b border-[#3c3c3c] flex justify-between items-center text-[#9b9b9b]">
                  <span>已更新文件列表 ({updatedFiles.length} 个项目)</span>
                  <span className="flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-full bg-[#ff5f56]" />
                    <span className="w-2.5 h-2.5 rounded-full bg-[#ffbd2e]" />
                    <span className="w-2.5 h-2.5 rounded-full bg-[#27c93f]" />
                  </span>
                </div>
                <div className="p-4 max-h-60 overflow-y-auto space-y-1 scrollbar-thin">
                  {updatedFiles.length === 0 ? (
                    <div className="text-[#858585] text-center py-2">所有代码文件均已是最新，无文件发生实际变更。</div>
                  ) : (
                    updatedFiles.map((file, idx) => {
                      const isNew = file.startsWith("[NEW]");
                      return (
                        <div key={idx} className="flex gap-2 leading-relaxed">
                          <span className={isNew ? "text-[#4fc1ff]" : "text-[#ce9178]"}>
                            {file.split(" ")[0]}
                          </span>
                          <span className="text-[#9cdcfe]">
                            {file.split(" ").slice(1).join(" ")}
                          </span>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            )}
          </div>
        </section>

        <section className="bg-surface-container-lowest border border-outline-variant rounded-xl overflow-hidden shadow-sm">
          <div className="px-8 py-5 border-b border-outline-variant bg-surface-bright flex justify-between items-center">
            <div>
              <h3 className="font-semibold text-lg text-on-surface">系统与画面配置</h3>
              <p className="text-xs text-secondary mt-1">配置全局网络代理加速源与默认画面排版参数。</p>
            </div>
            <Globe className="text-primary" size={24} />
          </div>
          <form onSubmit={handleSaveConfig} className="p-8 space-y-6">
            <div className="space-y-2">
              <label htmlFor="github-proxy" className="block text-sm font-medium text-on-surface">
                GitHub 代理/加速网址
              </label>
              <input
                id="github-proxy"
                type="url"
                placeholder="https://edgeone.gh-proxy.org/"
                value={githubProxy}
                onChange={(e) => setGithubProxy(e.target.value)}
                className="w-full px-4 py-2.5 bg-surface-container-low border border-outline-variant rounded-lg text-sm text-on-surface placeholder-secondary focus:outline-none focus:border-primary transition-colors"
              />
              <p className="text-xs text-secondary">
                默认值为 <code className="font-mono bg-surface-container-high px-1.5 py-0.5 rounded text-primary">https://edgeone.gh-proxy.org/</code>。留空或输入 <code className="font-mono bg-surface-container-high px-1.5 py-0.5 rounded text-primary">https://github.com/</code> 则代表直连 GitHub（无代理）。
              </p>
            </div>

            <div className="space-y-2 pt-4 border-t border-outline-variant">
              <div className="flex items-center gap-2">
                <SlidersHorizontal size={16} className="text-primary" />
                <label htmlFor="default-page-anim" className="block text-sm font-medium text-on-surface">
                  默认翻页方式
                </label>
              </div>
              <select
                id="default-page-anim"
                value={defaultPageAnim}
                onChange={(e) => setDefaultPageAnim(e.target.value)}
                className="w-full px-4 py-2.5 bg-surface-container-low border border-outline-variant rounded-lg text-sm text-on-surface focus:outline-none focus:border-primary transition-colors"
              >
                <option value="0">覆盖</option>
                <option value="1">滑动</option>
                <option value="2">仿真</option>
                <option value="3">滚动</option>
                <option value="4">无动画</option>
              </select>
              <p className="text-xs text-secondary">
                用于新建空白主题或重置主题配置时，系统的全局默认翻页动画效果。
              </p>
            </div>

            <div className="flex justify-end pt-2">
              <button
                type="submit"
                disabled={savingConfig}
                className="bg-primary text-on-primary px-6 py-2.5 rounded-lg text-sm font-semibold hover:opacity-90 transition-all shadow-sm disabled:opacity-50"
              >
                {savingConfig ? '正在保存...' : '保存配置'}
              </button>
            </div>
          </form>
        </section>

        <section className="bg-surface-container-lowest border border-outline-variant rounded-xl overflow-hidden shadow-sm">
          <div className="px-8 py-5 border-b border-outline-variant bg-surface-bright">
            <h3 className="font-semibold text-lg text-on-surface">系统同步</h3>
          </div>
          <div className="p-8 space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold">手动触发全局同步</p>
                <p className="text-xs text-secondary">立即从所有上游订阅源更新数据</p>
              </div>
              <button 
                onClick={handleSyncAll}
                disabled={syncingAll}
                className="bg-surface-container-high px-4 py-2 rounded-lg text-sm font-medium hover:bg-surface-container-highest transition-colors flex items-center gap-2 disabled:opacity-50"
              >
                <RefreshCw size={16} className={syncingAll ? 'animate-spin' : ''} />
                {syncingAll ? '同步中...' : '立即同步'}
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
