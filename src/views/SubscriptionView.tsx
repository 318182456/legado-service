import React, { useState, useEffect } from 'react';
import { RefreshCw, Plus, Search, Globe, ListRestart, Sparkles, Trash2, Book } from 'lucide-react';
import * as api from '../api';
import { WorkspaceHeader, WorkspaceTabs, WorkspaceSearch, WorkspaceEmpty } from '../components/Workspace';

interface SubscriptionViewProps {
  onImport: () => void;
  onExplore: () => void;
  onJsonImport: () => void;
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

export default function SubscriptionView({ onImport, onExplore, onJsonImport }: SubscriptionViewProps) {
  const [subs, setSubs] = useState<api.Subscription[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [error, setError] = useState('');
  const [syncing, setSyncing] = useState<number | null>(null);

  const fetchSubs = async () => {
    setLoading(true);
    setError('');
    try {
      const list = await api.getSubscriptions();
      setSubs(list);
    } catch (e) {
      setError('暂时无法加载订阅，请重试。');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSubs();
    window.addEventListener('refresh-data', fetchSubs);
    return () => window.removeEventListener('refresh-data', fetchSubs);
  }, []);

  const handleToggle = async (id: number, enabled: boolean) => {
    try {
      await api.toggleSubscription(id, !enabled);
      setSubs(prev => prev.map(s => s.id === id ? { ...s, enabled: !enabled ? 1 : 0 } : s));
    } catch (e) {
      alert('操作失败: ' + String(e));
    }
  };

  const handleSync = async (id: number) => {
    setSyncing(id);
    try {
      const result = await api.syncOne(id);
      await fetchSubs();
      if (result.failed || result.skipped) alert(api.describeSync(result));
    } catch (e) {
      alert('同步失败: ' + String(e));
    } finally {
      setSyncing(null);
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('确定要删除此订阅吗？相关书源也将被移除。')) return;
    try {
      await api.deleteSubscription(id);
      setSubs(prev => prev.filter(s => s.id !== id));
    } catch (e) {
      alert('删除失败: ' + String(e));
    }
  };

  const types = [
    { id: 'all', label: '全部订阅' }, { id: 'source', label: '书源' },
    { id: 'rule', label: '净化规则' }, { id: 'txtTocRule', label: '目录' }, { id: 'dictRule', label: '字典' },
  ];
  const visible = subs.filter(sub => (category === 'all' || sub.type === category)
    && `${sub.name} ${sub.url}`.toLowerCase().includes(query.toLowerCase()));

  return (
    <div className="studio-view">
      <WorkspaceHeader eyebrow="CONTENT / SUBSCRIPTIONS" title="订阅管理"
        description="连接你的内容来源。一次添加，持续同步。"
        actions={<><button className="button-secondary" onClick={onJsonImport}>导入 JSON</button><button className="button-primary" onClick={onImport}><Plus size={16} />添加订阅</button></>} />
      <div className="subscription-overview">
        <div><span>订阅库</span><strong>{subs.length}<small>个订阅</small></strong></div>
        <div><span>正在启用</span><strong>{subs.filter(s => s.enabled).length}<small>个来源</small></strong></div>
        <div><span>包含项目</span><strong>{subs.reduce((sum, sub) => sum + (sub.item_count || 0), 0).toLocaleString()}<small>条内容</small></strong></div>
        <button onClick={onExplore}><Globe size={22} /><span><strong>发现新的内容来源</strong><small>从网页解析并导入订阅</small></span><Plus size={18} /></button>
      </div>
      <section className="studio-collection">
        <WorkspaceTabs label="订阅类型" items={types.map(type => ({ ...type, count: subs.filter(s => type.id === 'all' || s.type === type.id).length }))} value={category} onChange={setCategory} />
        <div className="collection-toolbar"><WorkspaceSearch value={query} onChange={setQuery} label="搜索订阅" placeholder="搜索订阅名称或链接" /><span>{visible.length} 个订阅</span><button className="button-secondary" onClick={fetchSubs} disabled={loading}><RefreshCw size={15} className={loading ? 'animate-spin' : ''} />刷新</button></div>
        {error && <div role="alert" className="notice-error">{error}<button onClick={fetchSubs}>重试</button></div>}
        {loading ? <div className="studio-loading" role="status"><RefreshCw className="animate-spin" size={22} />正在加载订阅…</div> : visible.length === 0 ?
          <WorkspaceEmpty icon={<ListRestart size={28} />} title={query || category !== 'all' ? '没有匹配的订阅' : '建立你的第一份订阅'} description={query ? '试试其他名称，或清除搜索条件。' : '添加一个订阅地址，将书源和规则集中管理。'} action={query ? '清除搜索' : '添加订阅'} onAction={query ? () => setQuery('') : onImport} /> :
          <div className="subscription-grid">{visible.map(sub => <article key={sub.id} className="subscription-tile">
            <div className="subscription-tile-top"><span className={`tile-icon type-${sub.type}`}>{sub.type === 'source' ? <Book size={23} /> : sub.type === 'rule' ? <Sparkles size={23} /> : <Globe size={23} />}</span><span className="type-label">{types.find(type => type.id === sub.type)?.label}</span><span className={`status-badge ${sub.enabled ? 'is-enabled' : ''}`}><span />{sub.enabled ? '已启用' : '已暂停'}</span></div>
            <h3>{sub.name || '未命名订阅'}</h3><p className="subscription-tile-url" title={sub.url}>{sub.url}</p>
            <div className="subscription-tile-meta"><div><span>包含内容</span><strong>{(sub.item_count || 0).toLocaleString()} <small>条</small></strong></div><div><span>上次同步</span><strong className="sync-date">{sub.last_synced ? formatDate(sub.last_synced) : '尚未同步'}</strong></div></div>
            <div className="subscription-tile-footer"><button className="tile-switch" role="switch" aria-checked={!!sub.enabled} aria-label={`启用订阅：${sub.name}`} onClick={() => handleToggle(sub.id, !!sub.enabled)}><span /><small>{sub.enabled ? '同步已开启' : '同步已暂停'}</small></button><button className="tile-icon-button danger" aria-label={`删除订阅：${sub.name}`} onClick={() => handleDelete(sub.id)}><Trash2 size={16} /></button><button className="tile-sync" onClick={() => handleSync(sub.id)} disabled={syncing !== null}><RefreshCw size={14} className={syncing === sub.id ? 'animate-spin' : ''} />{syncing === sub.id ? '同步中' : '立即同步'}</button></div>
          </article>)}</div>}
      </section>
    </div>
  );
}
