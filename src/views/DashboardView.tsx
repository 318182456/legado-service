import React, { useState, useEffect } from 'react';
import { Book, Sparkles, RefreshCw, Copy, Zap, MoreVertical } from 'lucide-react';
import QRCode from 'qrcode';
import * as api from '../api';
import { StatCard } from '../components/StatCard';

interface DashboardViewProps {
  onImport: () => void;
}

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

export default function DashboardView({ onImport }: DashboardViewProps) {
  const [stats, setStats] = useState<api.Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [recentSources, setRecentSources] = useState<any[]>([]);
  const [qrCodeUrl, setQrCodeUrl] = useState<string>('');

  const fetchData = async () => {
    setLoading(true);
    try {
      const [s, sources] = await Promise.all([
        api.getStats(),
        api.getSources()
      ]);
      setStats(s);
      setRecentSources(sources.sources.slice(0, 4));
    } catch (e) {
      console.error('获取统计数据失败', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  useEffect(() => {
    const generateQR = async () => {
      try {
        const url = `${window.location.origin}/subscribe/info.json`;
          
        const dataUrl = await QRCode.toDataURL(url, {
          width: 140,
          margin: 1,
          color: {
            dark: '#1e1b4b', // 采用深紫色，体现高端品质感
            light: '#ffffff'
          }
        });
        setQrCodeUrl(dataUrl);
      } catch (err) {
        console.error('生成二维码失败', err);
      }
    };
    generateQR();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="flex flex-col items-center gap-4">
          <RefreshCw className="animate-spin text-primary" size={32} />
          <p className="text-secondary text-sm">加载统计信息中...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">控制台摘要</h2>
          <p className="text-sm text-secondary mt-1">系统当前运行状态概览</p>
        </div>
        <div className="flex gap-3">
          <a 
            href="/reader3/"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 px-4 py-2 bg-primary text-on-primary rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors shadow-sm"
          >
            <Book size={16} />
            进入在线阅读器
          </a>
          <button 
            onClick={fetchData}
            className="flex items-center gap-2 px-4 py-2 bg-surface-container-lowest border border-outline-variant text-primary rounded-lg text-sm font-medium hover:bg-surface-container-low transition-colors"
          >
            <RefreshCw size={16} />
            刷新数据
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="flex flex-col gap-6">
          <StatCard icon={<Book size={24} />} label="已启用阅读源" value={stats?.sources?.total?.toLocaleString() || '0'} color="bg-surface-container text-primary" />
          <StatCard icon={<Sparkles size={24} />} label="净化规则数" value={stats?.rules?.total?.toLocaleString() || '0'} color="bg-tertiary-container/10 text-tertiary" />
          <StatCard icon={<RefreshCw size={24} />} label="启用订阅总数" value={stats?.subscriptions?.total?.toLocaleString() || '0'} color="bg-secondary-container text-on-surface" />
        </div>

        <div className="md:col-span-2 bg-primary text-on-primary rounded-xl p-8 relative overflow-hidden flex flex-col justify-between">
          <div className="absolute top-0 right-0 w-64 h-64 bg-white/10 rounded-full blur-3xl -translate-y-1/2 translate-x-1/4 pointer-events-none" />
          
          <div className="flex flex-col lg:flex-row gap-6 justify-between items-stretch relative z-10 w-full h-full">
            {/* 左侧内容区 */}
            <div className="flex-1 flex flex-col justify-between space-y-6">
              <div>
                <div className="flex items-center gap-2 mb-4 text-2xl font-bold">
                  <Copy size={28} />
                  整合订阅链接
                </div>
                <p className="text-primary-container font-medium text-sm md:text-base max-w-lg">
                  使用此链接在您的阅读应用中直接导入所有已启用的书源和净化规则。链接会自动保持最新状态。
                </p>
              </div>
              
              <div className="space-y-2 w-full">
                <label className="text-xs font-semibold text-primary-container">整合索引地址 (仿苗公子订阅页面)</label>
                <div className="flex gap-2">
                  <input 
                    readOnly 
                    value={`${window.location.origin}/subscribe/index`}
                    className="flex-1 bg-surface-container-lowest text-on-background border border-outline-variant rounded-lg px-4 py-2 text-sm outline-none min-w-0"
                  />
                  <button 
                    onClick={() => {
                      navigator.clipboard.writeText(`${window.location.origin}/subscribe/index`);
                      alert('复制成功');
                    }}
                    title="复制链接"
                    className="bg-surface-container-lowest text-primary px-3 py-2 rounded-lg text-sm font-semibold hover:bg-surface-container-low transition-colors shadow-sm shrink-0"
                  >
                    <Copy size={16} />
                  </button>
                  <a 
                    href={`yuedu://rsssource/importonline?src=${window.location.origin}/subscribe/info.json`}
                    className="bg-surface-container-lowest text-tertiary px-3 py-2 rounded-lg text-sm font-semibold hover:bg-surface-container-low transition-colors shadow-sm shrink-0 flex items-center gap-1.5"
                  >
                    <Zap size={16} /> 导入阅读
                  </a>
                </div>
              </div>
            </div>

            {/* 右侧二维码区 */}
            <div className="flex flex-col items-center justify-center bg-white/5 backdrop-blur-md rounded-xl p-4 border border-white/10 shrink-0 self-center lg:self-stretch min-w-[170px]">
              {qrCodeUrl ? (
                <div className="bg-white p-2 rounded-lg shadow-inner">
                  <img src={qrCodeUrl} alt="订阅二维码" className="w-[110px] h-[110px] select-none pointer-events-none" />
                </div>
              ) : (
                <div className="w-[110px] h-[110px] flex items-center justify-center text-xs text-primary-container">
                  生成二维码中...
                </div>
              )}
              
              <span className="text-[10px] font-medium text-primary-container mt-2 text-center max-w-[140px] leading-tight">
                使用阅读 App「扫码导入」直接添加
              </span>
            </div>
          </div>
        </div>
      </div>

      <section className="bg-surface-container-lowest border border-outline-variant rounded-xl overflow-hidden shadow-sm">
        <div className="px-6 py-5 border-b border-outline-variant flex justify-between items-center">
          <h3 className="font-semibold text-lg">最近同步书源</h3>
          <button className="text-sm font-medium text-primary hover:underline">查看全部</button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="bg-surface text-secondary text-xs font-medium uppercase tracking-wider border-b border-outline-variant">
                <th className="py-3 px-6">源名称</th>
                <th className="py-3 px-6">最后更新</th>
                <th className="py-3 px-6">状态</th>
                <th className="py-3 px-6 text-right">操作</th>
              </tr>
            </thead>
            <tbody className="text-sm">
              {recentSources.length === 0 ? (
                <tr>
                  <td colSpan={4} className="py-8 text-center text-secondary">暂无书源数据</td>
                </tr>
              ) : (
                recentSources.map((source, idx) => (
                  <tr key={idx} className="border-b border-outline-variant/30 hover:bg-surface-container-low transition-colors">
                    <td className="py-4 px-6 font-medium">{source.name}</td>
                    <td className="py-4 px-6 text-secondary">{formatDate(source.updated_at)}</td>
                    <td className="py-4 px-6">
                      <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${
                        source.enabled ? 'bg-surface-container-high text-primary' : 'bg-secondary-container text-secondary'
                      }`}>
                        <span className={`w-2 h-2 rounded-full ${source.enabled ? 'bg-primary' : 'bg-secondary'}`} />
                        {source.enabled ? '已启用' : '已禁用'}
                      </span>
                    </td>
                    <td className="py-4 px-6 text-right">
                      <button className="p-1 text-secondary hover:text-primary transition-colors"><MoreVertical size={18} /></button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
