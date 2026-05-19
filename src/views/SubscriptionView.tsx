import React, { useState, useEffect } from 'react';
import { RefreshCw, Plus, Search, Globe, ListRestart, Sparkles, Trash2, Book } from 'lucide-react';
import * as api from '../api';

interface SubscriptionViewProps {
  onImport: () => void;
  onExplore: () => void;
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

export default function SubscriptionView({ onImport, onExplore }: SubscriptionViewProps) {
  const [subs, setSubs] = useState<api.Subscription[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState<number | null>(null);

  const fetchSubs = async () => {
    setLoading(true);
    try {
      const list = await api.getSubscriptions();
      setSubs(list);
    } catch (e) {
      console.error('获取订阅失败', e);
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
      await api.syncOne(id);
      fetchSubs();
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

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="animate-spin text-primary" size={32} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">订阅管理</h2>
          <p className="text-sm text-secondary mt-1">配置第三方订阅链接，自动保持书源和规则同步。</p>
        </div>
        <div className="flex items-center gap-3">
          <button 
            onClick={onExplore}
            className="flex items-center gap-2 px-4 py-2 bg-tertiary text-on-tertiary rounded-lg text-sm font-bold hover:opacity-90 transition-all shadow-sm"
          >
            <Sparkles size={18} />
            从网页导入数据
          </button>
          <button 
            onClick={onImport}
            className="flex items-center gap-2 px-4 py-2 bg-primary text-on-primary rounded-lg text-sm font-bold hover:opacity-90 transition-all shadow-sm"
          >
            <Plus size={18} />
            添加订阅 URL
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4">
        {subs.length === 0 ? (
          <div className="bg-surface-container-lowest border border-outline-variant border-dashed rounded-xl p-12 text-center">
            <Globe className="mx-auto text-secondary mb-4" size={48} />
            <p className="text-secondary">尚未添加任何订阅 URL</p>
          </div>
        ) : (
          subs.map((sub) => (
            <div key={sub.id} className="bg-surface-container-lowest border border-outline-variant rounded-xl p-6 shadow-sm flex items-center justify-between group">
              <div className="flex items-center gap-4 flex-1 min-w-0">
                <div className={`w-12 h-12 rounded-full flex items-center justify-center shrink-0 ${
                  sub.type === 'source' ? 'bg-primary-container/20 text-primary' : 'bg-tertiary-container/20 text-tertiary'
                }`}>
                  {sub.type === 'source' ? <ListRestart size={24} /> : <Sparkles size={24} />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h4 className="font-bold truncate">{sub.name || '未命名订阅'}</h4>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold uppercase ${
                      sub.type === 'source' ? 'bg-primary text-on-primary' : 'bg-tertiary text-on-tertiary'
                    }`}>
                      {sub.type === 'source' ? '书源' : '规则'}
                    </span>
                  </div>
                  <p className="text-xs text-secondary truncate font-mono mt-1">{sub.url}</p>
                  <div className="flex items-center gap-4 mt-2 text-[10px] text-secondary font-medium">
                    <span className="flex items-center gap-1"><Book size={12} /> {sub.item_count} 条项目</span>
                    <span className="flex items-center gap-1"><RefreshCw size={12} /> {sub.last_synced ? formatDate(sub.last_synced) : '从未同步'}</span>
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-3 ml-6">
                <button 
                  onClick={() => handleToggle(sub.id, !!sub.enabled)}
                  className={`relative inline-flex h-5 w-10 shrink-0 cursor-pointer rounded-full transition-colors duration-200 ease-in-out focus:outline-none ${sub.enabled ? 'bg-primary' : 'bg-secondary-container'}`}
                >
                  <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out mt-0.5 ml-0.5 ${sub.enabled ? 'translate-x-5' : 'translate-x-0'}`} />
                </button>
                
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-all">
                  <button 
                    onClick={() => handleSync(sub.id)}
                    disabled={syncing === sub.id}
                    title="立即同步"
                    className="p-2 text-secondary hover:text-primary hover:bg-surface-container rounded-lg transition-colors disabled:opacity-50"
                  >
                    <RefreshCw size={18} className={syncing === sub.id ? 'animate-spin' : ''} />
                  </button>
                  <button 
                    onClick={() => handleDelete(sub.id)}
                    title="删除"
                    className="p-2 text-secondary hover:text-error hover:bg-error-container/20 rounded-lg transition-colors"
                  >
                    <Trash2 size={18} />
                  </button>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
