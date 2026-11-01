import React, { useState, useEffect } from 'react';
import { BookOpen, Sparkles, RefreshCw, Copy, ArrowUpRight, ArrowRight, Check, Download, ListRestart, Upload, Package } from 'lucide-react';
import QRCode from 'qrcode';
import * as api from '../api';
import { StatCard } from '../components/StatCard';

interface DashboardViewProps {
  onImport: () => void;
  onNavigate: (tab: string) => void;
}

const formatDate = (value: string) => {
  const date = new Date(value);
  return value && !Number.isNaN(date.getTime())
    ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
    : '—';
};

export default function DashboardView({ onImport, onNavigate }: DashboardViewProps) {
  const [stats, setStats] = useState<api.Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [recentSources, setRecentSources] = useState<any[]>([]);
  const [qrCodeUrl, setQrCodeUrl] = useState('');
  const [copyMessage, setCopyMessage] = useState('');
  const subscriptionUrl = `${window.location.origin}/subscribe/index`;

  const fetchData = async () => {
    setLoading(true);
    setError('');
    try {
      const [summary, sources] = await Promise.all([api.getStats(), api.getSources()]);
      setStats(summary);
      setRecentSources(sources.sources.slice(0, 5));
    } catch {
      setError('暂时无法获取数据，请稍后重试。');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void fetchData(); }, []);
  useEffect(() => {
    let active = true;
    QRCode.toDataURL(`${window.location.origin}/subscribe/info.json`, {
      width: 160, margin: 1, color: { dark: '#172f29', light: '#ffffff' },
    }).then(url => { if (active) setQrCodeUrl(url); }).catch(() => {});
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!copyMessage) return;
    const timer = setTimeout(() => setCopyMessage(''), 3000);
    return () => clearTimeout(timer);
  }, [copyMessage]);

  const copySubscription = async () => {
    try {
      await navigator.clipboard.writeText(subscriptionUrl);
      setCopyMessage('订阅链接已复制');
    } catch {
      setCopyMessage('复制失败，请选中链接手动复制');
    }
  };

  return (
    <div className="dashboard space-y-7">
      <div className="page-heading">
        <div><p className="page-eyebrow">WORKSPACE OVERVIEW</p><h2>阅读，从这里开始。</h2><p className="page-description">书源、订阅与阅读资源，一处打理。</p></div>
        <div className="page-actions">
          <button onClick={fetchData} disabled={loading} className="button-secondary"><RefreshCw size={15} className={loading ? 'animate-spin' : ''} />刷新</button>
          <button onClick={onImport} className="button-primary"><Upload size={15} />导入数据</button>
        </div>
      </div>
      {error && <div className="notice-error" role="alert">{error}<button onClick={fetchData}>重新加载</button></div>}
      <div className="dashboard-stats" aria-busy={loading}>
        <StatCard icon={<BookOpen size={19} />} label="已启用书源" value={stats?.sources?.total?.toLocaleString() ?? '—'} color="bg-primary/10 text-primary" />
        <StatCard icon={<ListRestart size={19} />} label="已启用订阅" value={stats?.subscriptions?.total?.toLocaleString() ?? '—'} color="bg-primary/10 text-primary" />
        <StatCard icon={<Sparkles size={19} />} label="净化规则" value={stats?.rules?.total?.toLocaleString() ?? '—'} color="bg-tertiary/10 text-tertiary" />
      </div>
      <div className="dashboard-middle">
        <section className="subscription-panel" aria-labelledby="subscription-title">
          <div className="subscription-panel-copy">
            <span className="panel-eyebrow"><span /> ONE LINK, ALL YOUR SOURCES</span>
            <h3 id="subscription-title">一条链接，连接你的书库。</h3>
            <p>将已启用的书源与净化规则导入阅读 App，<br className="hidden sm:block" />订阅内容随同步自动更新。</p>
            <label htmlFor="subscription-address">整合订阅地址</label>
            <div className="subscription-address"><input id="subscription-address" value={subscriptionUrl} readOnly /><button onClick={copySubscription} aria-label="复制订阅链接" title="复制订阅链接">{copyMessage === '订阅链接已复制' ? <Check size={16} /> : <Copy size={16} />}</button></div>
            <div className="subscription-panel-bottom"><a href={`yuedu://rsssource/importonline?src=${encodeURIComponent(`${window.location.origin}/subscribe/info.json`)}`}><Download size={14} />导入阅读 App<ArrowUpRight size={13} /></a><span role="status">{copyMessage}</span></div>
          </div>
          <div className="subscription-qr">{qrCodeUrl ? <img src={qrCodeUrl} alt="整合订阅导入二维码" width={116} height={116} /> : <div className="qr-placeholder">二维码加载中</div>}<span>打开阅读 App<br />扫码导入订阅</span></div>
        </section>
        <section className="quick-panel" aria-labelledby="quick-title">
          <div className="section-heading"><h3 id="quick-title">常用操作</h3><span>QUICK ACCESS</span></div>
          {[
            { tab: 'subscriptions', icon: ListRestart, title: '管理订阅', description: '添加订阅与同步内容' },
            { tab: 'sources', icon: BookOpen, title: '整理书源', description: '检测可用性，管理分组' },
            { tab: 'assets', icon: Package, title: '阅读资源', description: '主题、字体与背景图片' },
          ].map(item => <button key={item.tab} onClick={() => onNavigate(item.tab)} className="quick-action"><span className="quick-action-icon"><item.icon size={18} /></span><span><strong>{item.title}</strong><small>{item.description}</small></span><ArrowUpRight size={15} /></button>)}
        </section>
      </div>
      <section className="recent-panel" aria-labelledby="recent-title">
        <div className="section-heading"><div><h3 id="recent-title">书源一览</h3><p>查看书源的启用状态与更新时间</p></div><button onClick={() => onNavigate('sources')} className="text-action">全部书源<ArrowRight size={14} /></button></div>
        <div className="overflow-x-auto"><table className="w-full text-left"><thead><tr><th>书源名称</th><th>分组</th><th>更新时间</th><th>状态</th><th><span className="sr-only">操作</span></th></tr></thead><tbody>
          {recentSources.length === 0 ? <tr><td colSpan={5} className="dashboard-empty">{loading ? '正在加载书源…' : error ? '数据暂不可用' : <><BookOpen size={28} /><p>还没有书源，从导入第一份订阅开始。</p><button onClick={onImport} className="text-action">导入数据<ArrowRight size={14} /></button></>}</td></tr> : recentSources.map(source => (
            <tr key={source.id}><td><div className="source-cell"><span className="source-monogram">{Array.from(source.name || '?')[0] as string}</span><span><strong>{source.name || '未命名书源'}</strong><small>{source.book_source_url}</small></span></div></td><td className="text-secondary">{source.group_name || '未分组'}</td><td className="text-secondary tabular-nums whitespace-nowrap">{formatDate(source.updated_at)}</td><td><span className={`status-badge ${source.enabled ? 'is-enabled' : ''}`}><span />{source.enabled ? '已启用' : '已禁用'}</span></td><td><button className="row-action" onClick={() => onNavigate('sources')} aria-label={`管理书源：${source.name}`}><ArrowUpRight size={16} /></button></td></tr>
          ))}
        </tbody></table></div>
      </section>
    </div>
  );
}
