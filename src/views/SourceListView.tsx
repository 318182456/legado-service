import React, { useState, useEffect } from 'react';
import { RefreshCw, Search, Zap, ShieldCheck, Upload, BookOpen, CheckCircle2, AlertCircle, MoreVertical, Copy, Trash2, ChevronLeft, ChevronRight, Sparkles } from 'lucide-react';
import * as api from '../api';
import { useLatestRequest } from '../hooks/useLatestRequest';
import { WorkspaceHeader, WorkspaceTabs, WorkspaceSearch } from '../components/Workspace';

interface SourceListViewProps {
  onImport: () => void;
  testingIds: Set<number>;
  testProgress: { current: number; total: number };
  isTestingAll: boolean;
  onTest: (ids: number[], onFinished?: () => void, depth?: api.SourceCheckDepth) => Promise<void>;
  onTestAll: (onFinished?: () => void, depth?: api.SourceCheckDepth) => Promise<void>;
}

export default function SourceListView({
  onImport, testingIds, testProgress, isTestingAll, onTest, onTestAll
}: SourceListViewProps) {
  const [sources, setSources] = useState<any[]>([]);
  const { loading, error, run, invalidate } = useLatestRequest();
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [stats, setStats] = useState({ total: 0, available: 0, unavailable: 0, unchecked: 0 });
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [cleaning, setCleaning] = useState(false);
  const [checkDepth, setCheckDepth] = useState<api.SourceCheckDepth>(() => localStorage.getItem('legado_check_depth') === 'search' ? 'search' : 'content');
  const [excludeDuplicate, setExcludeDuplicate] = useState(() => {
    return localStorage.getItem('legado_exclude_duplicate') === 'true';
  });

  const fetchSources = (q = '', p = 1, f = 'all', exDup = false) =>
    run(signal => api.getSources(q, p, f, exDup, signal), data => {
      setSources(data.sources);
      setTotal(data.total);
      setTotalPages(data.totalPages);
      setStats(data.stats);
      setPage(data.page);
      setSelectedIds(prev => new Set([...prev].filter(id => data.sources.some(s => s.id === id))));
    });

  useEffect(() => {
    const timer = setTimeout(() => {
      fetchSources(query, 1, filter, excludeDuplicate);
    }, 500);
    return () => { clearTimeout(timer); invalidate(); };
  }, [query, filter, excludeDuplicate]);

  useEffect(() => {
    const handler = () => fetchSources(query, page, filter, excludeDuplicate);
    window.addEventListener('refresh-data', handler);
    return () => window.removeEventListener('refresh-data', handler);
  }, [query, page, filter, excludeDuplicate]);

  const handleLocalTest = (ids: number[]) => {
    onTest(ids, () => window.dispatchEvent(new CustomEvent('refresh-data')), checkDepth);
  };

  const handleLocalTestAll = () => {
    if (isTestingAll) {
      onTestAll();
      return;
    }

    if (!confirm('确定要开始全库测试吗？\n全库测试完成后系统将自动执行“去重与标记失效”软清理操作。')) return;

    onTestAll(async () => {
      setCleaning(true);
      try {
        const res = await api.cleanupSources();
        // 通知当前页面刷新，避免任务期间切换筛选后被旧条件覆盖。
        window.dispatchEvent(new CustomEvent('refresh-data'));
        alert(`全库测试与自动标记完成！\n- 自动禁用并归类失效书源: ${res.markedInvalid} 个\n- 自动禁用并归类重复书源: ${res.markedDuplicates} 个`);
      } catch (e) {
        alert('自动标记清理失败: ' + String(e));
      } finally {
        setCleaning(false);
      }
    }, checkDepth);
  };

  const toggleAll = () => {
    if (selectedIds.size === sources.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(sources.map(s => s.id)));
    }
  };

  const toggleOne = (id: number) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
  };

  const handleToggleSource = async (id: number, enabled: boolean) => {
    try {
      await api.toggleSource(id, !enabled);
      setSources(prev => prev.map(s => s.id === id ? { ...s, enabled: !enabled ? 1 : 0 } : s));
    } catch (e) {
      alert('操作失败: ' + String(e));
    }
  };

  const handleDeleteSource = async (id: number) => {
    if (!confirm('确定要删除此书源吗？')) return;
    try {
      await api.deleteSource(id);
      await fetchSources(query, page, filter, excludeDuplicate);
    } catch (e) {
      alert('删除失败: ' + String(e));
    }
  };

  const handleCopyUrl = (url: string) => {
    navigator.clipboard.writeText(url);
    alert('已复制到剪贴板');
  };


  return (
    <div className="studio-view sources-workbench">
      <WorkspaceHeader eyebrow="CONTENT / SOURCES" title="书源工作台" description="查找、验证和整理书源，让每次阅读都有可靠的来源。"
        actions={<><button className="button-secondary" onClick={() => fetchSources(query, page, filter, excludeDuplicate)} disabled={loading}><RefreshCw size={15} className={loading ? 'animate-spin' : ''} />刷新</button><button className="button-primary" onClick={onImport}><Upload size={16} />导入书源</button></>} />
      <div className="source-health" aria-label="书源检测概况">
        {[{id:'all',label:'书源总数',value:stats.total,icon:BookOpen,detail:'所有已收录的书源'}, {id:'available',label:'已验证通过',value:stats.available,icon:CheckCircle2,detail:'通过原书源规则检测'}, {id:'unavailable',label:'确认不可用',value:stats.unavailable,icon:AlertCircle,detail:'检测失败或需要登录'}, {id:'unchecked',label:'待检测与确认',value:stats.unchecked || 0,icon:ShieldCheck,detail:'等待验证的内容来源'}].map(item => <button key={item.id} onClick={() => setFilter(item.id)} aria-pressed={filter === item.id} className={`health-item health-${item.id}`}><span><item.icon size={17} />{item.label}</span><strong>{item.value.toLocaleString()}</strong><small>{item.detail}</small></button>)}
      </div>
      <div className="source-test-panel">
        <span className="test-panel-icon"><ShieldCheck size={24} /></span><div className="test-panel-description"><strong>{isTestingAll ? '书源检测正在进行' : cleaning ? '正在整理检测结果' : '检查你的书源库'}</strong><p>快速检测搜索结果，或完整验证目录与免费正文。需登录的书源会禁用。</p></div>
        <select aria-label="检测深度" value={checkDepth} disabled={isTestingAll || testingIds.size > 0} onChange={event => { const depth = event.target.value as api.SourceCheckDepth; setCheckDepth(depth); localStorage.setItem('legado_check_depth', depth); }}><option value="search">快速检测 · 搜索</option><option value="content">完整检测 · 搜索与正文</option></select>
        <button className="button-primary" onClick={handleLocalTestAll} disabled={cleaning || (loading && testingIds.size > 0 && !isTestingAll)}><Zap size={15} />{isTestingAll ? `停止检测 ${testProgress.current}/${testProgress.total}` : cleaning ? '整理中…' : '检测全部书源'}</button>
        {isTestingAll && testProgress.total > 0 && <div className="test-panel-progress" role="progressbar" aria-label="全库检测进度" aria-valuenow={testProgress.current} aria-valuemin={0} aria-valuemax={testProgress.total}><span style={{width:`${testProgress.current / testProgress.total * 100}%`}} /></div>}
      </div>
      <section className="studio-collection">
        <WorkspaceTabs label="书源筛选" value={filter} onChange={setFilter} items={[{id:'all',label:'全部书源'},{id:'available',label:'验证通过'},{id:'unavailable',label:'不可用'},{id:'skipped',label:'待确认'},{id:'unchecked',label:'未检测'},{id:'need_login',label:'带登录配置'}]} />
        <div className="collection-toolbar"><WorkspaceSearch value={query} onChange={setQuery} label="搜索书源" placeholder="搜索书源名称、地址或分组" /><label className="duplicate-filter"><input type="checkbox" checked={excludeDuplicate} onChange={event => {setExcludeDuplicate(event.target.checked);localStorage.setItem('legado_exclude_duplicate',String(event.target.checked));}} />排除重复</label><details className="collection-more"><summary>更多操作</summary><button className="text-error" onClick={async () => {if(confirm('确定要清空所有书源吗？此操作不可撤销！')) {try {await api.deleteAllSources();fetchSources(query,1,filter,excludeDuplicate);}catch(error){alert('删除失败: '+String(error));}}}}>清空所有书源</button></details></div>
        {selectedIds.size > 0 && <div className="source-selection" role="status"><strong>已选 {selectedIds.size} 个书源</strong><button onClick={() => handleLocalTest(Array.from(selectedIds))} disabled={loading || isTestingAll || [...selectedIds].some(id => testingIds.has(id))}><Zap size={14} />检测选中</button><button onClick={() => setSelectedIds(new Set())}>取消选择</button></div>}
      {error && (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-xl border border-error/30 bg-error/5 p-3 text-sm text-error">
          <span>加载失败：{error}</span>
          <button onClick={() => fetchSources(query, page, filter, excludeDuplicate)} className="shrink-0 font-bold">重试</button>
        </div>
      )}
      {loading && <div role="status" className="text-xs text-secondary">正在加载…</div>}

      <div className="source-results">
        <div className="source-mobile-list">
          <label className="mobile-select-all"><input type="checkbox" checked={selectedIds.size === sources.length && sources.length > 0} onChange={toggleAll} />选择本页书源</label>
          {sources.length === 0 ? <p className="studio-loading">{loading ? '正在加载…' : '没有匹配的书源'}</p> : sources.map(source => <article className="source-mobile-card" key={source.id}>
            <div><input type="checkbox" aria-label={`选择书源：${source.name}`} checked={selectedIds.has(source.id)} onChange={() => toggleOne(source.id)} /><h3>{source.name}</h3><button className={`status-badge ${source.enabled ? 'is-enabled' : ''}`} onClick={() => handleToggleSource(source.id,!!source.enabled)}>{source.enabled ? '已启用' : '已禁用'}</button></div>
            <p>{source.book_source_url}</p><span className="source-group">{source.group_name || '未分组'}</span>
            <div className="source-mobile-status"><span className={source.check_verdict === 'unavailable' ? 'text-error' : 'text-secondary'}>{testingIds.has(source.id) ? '检测中…' : source.check_verdict === 'available' ? '验证通过' : source.check_reason === 'login-required' || source.check_reason === 'login-redirect' ? '需登录（已禁用）' : source.check_verdict === 'unavailable' ? '不可用' : source.check_verdict === 'skipped' ? '待确认' : '待验证'}</span><small>{source.check_detail}</small></div>
            <div className="table-row-actions"><button onClick={() => handleLocalTest([source.id])} disabled={isTestingAll || testingIds.has(source.id)}><Zap size={14} />检测</button><button onClick={() => handleCopyUrl(source.book_source_url)}><Copy size={14} />复制</button><button className="danger" onClick={() => handleDeleteSource(source.id)} aria-label={`删除书源：${source.name}`}><Trash2 size={14} /></button></div>
          </article>)}
        </div>
        <div className="sources-table-desktop overflow-x-auto min-h-[300px]">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-surface text-secondary text-xs font-bold uppercase tracking-wider border-b border-outline-variant">
                <th className="py-2 px-4 w-10 text-center">
                  <input
                    type="checkbox"
                    checked={selectedIds.size === sources.length && sources.length > 0}
                    onChange={toggleAll}
                    className="rounded border-outline text-primary focus:ring-primary h-3.5 w-3.5 cursor-pointer"
                  />
                </th>
                <th className="py-2 px-4">源名称</th>
                <th className="py-2 px-4">URL / 分组</th>
                <th className="py-2 px-4 text-center">状态 / 可用性</th>
                <th className="py-2 px-4 text-right w-24">操作</th>
              </tr>
            </thead>
            <tbody className="text-sm divide-y divide-outline-variant/30">
              {sources.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-12 text-center text-secondary">暂无数据</td>
                </tr>
              ) : (
                sources.map((source, idx) => (
                  <tr key={source.id} className={`hover:bg-surface-container-low/50 transition-colors group relative ${!source.enabled ? 'opacity-60' : ''}`}>
                    <td className="py-2 px-4 text-center">
                      <input
                        type="checkbox"
                        checked={selectedIds.has(source.id)}
                        onChange={() => toggleOne(source.id)}
                        className="rounded border-outline text-primary focus:ring-primary h-3.5 w-3.5 cursor-pointer"
                      />
                    </td>
                    <td className="py-2 px-4">
                      <div className="flex items-center gap-3">
                        <div className="w-6 h-6 rounded bg-surface-container-high flex items-center justify-center text-primary font-bold text-xs shrink-0">
                          {Array.from(source.name || "?")[0]}
                        </div>
                        <span className="font-bold text-sm truncate">{source.name}</span>
                      </div>
                    </td>
                    <td className="py-2 px-4">
                      <div className="text-xs text-secondary truncate max-w-[200px] font-mono">{source.book_source_url}</div>
                      <div className="mt-0.5 flex gap-1">
                        {source.group_name && (
                          <span className="text-[11px] bg-secondary-container/30 text-secondary px-1.5 py-0.2 rounded">{source.group_name}</span>
                        )}
                      </div>
                    </td>
                    <td className="py-2 px-4 text-center">
                      <div className="flex flex-col items-center gap-0.5">
                        <button
                          onClick={() => handleToggleSource(source.id, !!source.enabled)}
                          className={`inline-flex items-center gap-1 px-1.5 py-0.2 rounded-full text-[11px] font-bold transition-colors ${
                            source.enabled ? 'bg-primary/10 text-primary hover:bg-primary/20' : 'bg-secondary/10 text-secondary hover:bg-secondary/20'
                          }`}
                        >
                          <span className={`w-1 h-1 rounded-full ${source.enabled ? 'bg-primary' : 'bg-secondary'}`} />
                          {source.enabled ? '已启用' : '已禁用'}
                        </button>
                        {testingIds.has(source.id) ? (
                          <span className="text-[11px] text-tertiary animate-pulse font-bold">测试中...</span>
                        ) : (
                          <span title={source.check_detail || '重新检测后显示具体结果'} className={`text-[11px] font-bold ${source.check_verdict === 'available' ? 'text-green-700' : source.check_verdict === 'unavailable' ? 'text-error' : 'text-secondary'}`}>
                            {source.check_verdict === 'available' ? '通过' : source.check_reason === 'login-required' || source.check_reason === 'login-redirect' ? '需登录（已禁用）' : source.check_verdict === 'unavailable' ? '不可用' : source.check_verdict === 'skipped' ? '待确认' : source.last_checked ? '待复检' : '未检测'}
                          </span>
                        )}
                        {source.check_detail && <span className="text-[10px] text-secondary max-w-[220px] truncate" title={source.check_detail}>{source.check_detail}</span>}
                      </div>
                    </td>
                    <td className="py-2 px-4 text-right"><div className="table-row-actions"><button aria-label={`检测书源：${source.name}`} onClick={() => handleLocalTest([source.id])} disabled={isTestingAll || testingIds.has(source.id)}><Zap size={15} /></button><button aria-label={`复制书源地址：${source.name}`} onClick={() => handleCopyUrl(source.book_source_url)}><Copy size={15} /></button><button aria-label={`删除书源：${source.name}`} className="danger" onClick={() => handleDeleteSource(source.id)}><Trash2 size={15} /></button></div></td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        <div className="px-4 py-3 border-t border-outline-variant/30 flex flex-col sm:flex-row items-center justify-between gap-4 bg-surface-container-lowest">
          <div className="text-xs text-secondary font-medium">
            共 <span className="text-on-surface font-bold">{total.toLocaleString()}</span> 条书源
            <span className="mx-2 opacity-30">|</span>
            第 <span className="text-on-surface font-bold">{page}</span> / {totalPages} 页
          </div>

          <div className="flex items-center gap-1">
            <button
              onClick={() => fetchSources(query, page - 1, filter, excludeDuplicate)}
              disabled={page <= 1 || loading}
              className="p-1.5 rounded-lg border border-outline-variant hover:bg-surface-container-low disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              title="上一页"
            >
              <ChevronLeft size={16} />
            </button>

            <div className="flex items-center px-3 h-8 rounded-lg border border-outline-variant bg-surface-container-low text-xs font-bold min-w-12 justify-center">
              {page}
            </div>

            <button
              onClick={() => fetchSources(query, page + 1, filter, excludeDuplicate)}
              disabled={page >= totalPages || loading}
              className="p-1.5 rounded-lg border border-outline-variant hover:bg-surface-container-low disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              title="下一页"
            >
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
      </div>
      </section>
    </div>
  );
}
