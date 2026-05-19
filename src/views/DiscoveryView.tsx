import React, { useState, useEffect } from 'react';
import { RefreshCw, Search, Globe, Power, CheckCircle, AlertTriangle, ExternalLink } from 'lucide-react';
import * as api from '../api';

export default function DiscoveryView() {
  const [sources, setSources] = useState<api.RssSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'none' | 'valid' | 'invalid'>('all');
  const [togglingIndex, setTogglingIndex] = useState<number | null>(null);

  const fetchSources = async () => {
    setLoading(true);
    try {
      const data = await api.getRssSources();
      setSources(data);
    } catch (e) {
      console.error('获取发现订阅源失败', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSources();
  }, []);

  const handleToggle = async (index: number, status: 'none' | 'valid' | 'invalid') => {
    setTogglingIndex(index);
    try {
      await api.toggleRssSource(index, status);
      setSources(prev =>
        prev.map(item => (item.index === index ? { ...item, status } : item))
      );
    } catch (e) {
      alert('标记状态更新失败: ' + String(e));
    } finally {
      setTogglingIndex(null);
    }
  };

  // 搜索和状态过滤逻辑
  const filteredSources = sources.filter(item => {
    const matchesSearch =
      item.sourceName.toLowerCase().includes(query.toLowerCase()) ||
      item.sourceGroup.toLowerCase().includes(query.toLowerCase());
    
    if (filter === 'valid') return matchesSearch && item.status === 'valid';
    if (filter === 'invalid') return matchesSearch && item.status === 'invalid';
    if (filter === 'none') return matchesSearch && item.status === 'none';
    return matchesSearch;
  });

  // 统计数据
  const totalCount = sources.length;
  const validCount = sources.filter(s => s.status === 'valid').length;
  const invalidCount = sources.filter(s => s.status === 'invalid').length;
  const unmarkedCount = totalCount - validCount - invalidCount;

  if (loading && sources.length === 0) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="animate-spin text-primary" size={32} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* 顶部标题与说明 */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">发现订阅管理</h2>
          <p className="text-sm text-secondary mt-1">管理仿苗公子发现订阅源（mochen_sources.json），检查和标记不可用的失效源。</p>
        </div>
        <button
          onClick={fetchSources}
          className="flex items-center gap-2 px-3 py-1.5 border border-outline-variant rounded-lg bg-surface-container-lowest hover:bg-surface-container-low text-xs font-semibold transition-colors shrink-0"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          刷新数据
        </button>
      </div>

      {/* 3 个精美统计卡片 */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-surface-container-lowest border border-outline-variant rounded-xl p-5 shadow-sm flex items-center gap-4 relative overflow-hidden group">
          <div className="w-12 h-12 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0">
            <Globe size={24} />
          </div>
          <div>
            <div className="text-xs text-secondary font-medium uppercase tracking-wider">订阅源总数</div>
            <div className="text-2xl font-black mt-1 font-mono">{totalCount} <span className="text-xs text-secondary font-normal font-sans">({unmarkedCount} 未标)</span></div>
          </div>
          <div className="absolute right-0 bottom-0 opacity-[0.03] text-primary group-hover:scale-110 transition-transform -mr-2 -mb-2">
            <Globe size={96} />
          </div>
        </div>

        <div className="bg-surface-container-lowest border border-outline-variant rounded-xl p-5 shadow-sm flex items-center gap-4 relative overflow-hidden group">
          <div className="w-12 h-12 rounded-xl bg-success-container/30 text-success flex items-center justify-center shrink-0">
            <CheckCircle size={24} />
          </div>
          <div>
            <div className="text-xs text-secondary font-medium uppercase tracking-wider">标记有效数</div>
            <div className="text-2xl font-black mt-1 text-success font-mono">{validCount}</div>
          </div>
          <div className="absolute right-0 bottom-0 opacity-[0.03] text-success group-hover:scale-110 transition-transform -mr-2 -mb-2">
            <CheckCircle size={96} />
          </div>
        </div>

        <div className="bg-surface-container-lowest border border-outline-variant rounded-xl p-5 shadow-sm flex items-center gap-4 relative overflow-hidden group">
          <div className="w-12 h-12 rounded-xl bg-error-container/30 text-error flex items-center justify-center shrink-0">
            <AlertTriangle size={24} />
          </div>
          <div>
            <div className="text-xs text-secondary font-medium uppercase tracking-wider">标记失效数</div>
            <div className="text-2xl font-black mt-1 text-error font-mono">{invalidCount}</div>
          </div>
          <div className="absolute right-0 bottom-0 opacity-[0.03] text-error group-hover:scale-110 transition-transform -mr-2 -mb-2">
            <AlertTriangle size={96} />
          </div>
        </div>
      </div>

      {/* 搜索与筛选工具条 */}
      <div className="flex flex-col sm:flex-row justify-between items-center gap-3 bg-surface-container-lowest border border-outline-variant rounded-xl p-4 shadow-sm">
        <div className="relative w-full sm:w-80">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-outline" size={14} />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索源名称或分组..."
            className="w-full bg-surface-container-low border border-outline-variant rounded-lg pl-9 pr-4 py-2 text-xs outline-none focus:border-primary transition-all"
          />
        </div>

        <div className="flex items-center gap-2 w-full sm:w-auto shrink-0 justify-end">
          <span className="text-xs text-secondary font-medium whitespace-nowrap">状态筛选:</span>
          <select
            value={filter}
            onChange={(e: any) => setFilter(e.target.value)}
            className="bg-surface-container-low border border-outline-variant text-xs rounded-lg px-3 py-1.5 outline-none focus:border-primary font-medium"
          >
            <option value="all">全部 ({totalCount})</option>
            <option value="none">⏳ 待确认 ({unmarkedCount})</option>
            <option value="valid">✅ 标记有效 ({validCount})</option>
            <option value="invalid">❌ 标记失效 ({invalidCount})</option>
          </select>
        </div>
      </div>

      {/* 发现源卡片列表网格 */}
      {filteredSources.length === 0 ? (
        <div className="bg-surface-container-lowest border border-outline-variant border-dashed rounded-xl p-12 text-center shadow-sm">
          <Globe className="mx-auto text-secondary mb-4 opacity-40" size={48} />
          <p className="text-secondary font-medium">没有找到符合条件的订阅源</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {filteredSources.map((item) => {
            const isToggling = togglingIndex === item.index;

            return (
              <div
                key={item.index}
                className={`bg-surface-container-lowest rounded-2xl p-5 shadow-sm flex flex-col justify-between relative overflow-hidden transition-all duration-300 hover:shadow-md ${
                  item.status === 'invalid'
                    ? 'opacity-70 bg-surface-container-low/40 border border-outline-variant'
                    : item.status === 'none'
                    ? 'border-2 border-warning/50 bg-warning/5'
                    : 'border border-outline-variant'
                }`}
              >
                {/* 状态角标 */}
                <div className="absolute top-4 right-4">
                  {item.status === 'valid' && (
                    <span className="text-[9px] px-2 py-0.5 rounded-full font-bold uppercase tracking-wider bg-success-container/20 text-success border border-success/20">
                      有效
                    </span>
                  )}
                  {item.status === 'invalid' && (
                    <span className="text-[9px] px-2 py-0.5 rounded-full font-bold uppercase tracking-wider bg-error-container/20 text-error border border-error/20">
                      失效
                    </span>
                  )}
                  {item.status === 'none' && (
                    <span className="text-[9px] px-2 py-0.5 rounded-full font-bold uppercase tracking-wider bg-warning/15 text-warning border border-warning/30">
                      待确认
                    </span>
                  )}
                </div>

                {/* 订阅源核心信息 */}
                <div className="space-y-4">
                  <div className="flex items-center gap-3">
                    <div className="w-12 h-12 rounded-xl bg-surface-container-low border border-outline-variant/60 flex items-center justify-center shrink-0">
                      <img
                        src={item.sourceIcon || '/repo/logo.png'}
                        alt={item.sourceName}
                        className="w-8 h-8 rounded-lg object-contain"
                        onError={(e) => {
                          (e.target as HTMLImageElement).src = '/repo/logo.png';
                        }}
                      />
                    </div>
                    <div className="min-w-0">
                      <h4 className="font-extrabold text-sm text-on-surface truncate pr-10" title={item.sourceName}>
                        {item.sourceName}
                      </h4>
                      <p className="text-[10px] text-secondary font-bold uppercase mt-1 bg-surface-container-low px-1.5 py-0.5 rounded w-fit">
                        {item.sourceGroup}
                      </p>
                    </div>
                  </div>

                  {/* 链接显示 */}
                  <div className="space-y-1">
                    <span className="text-[9px] text-secondary font-medium">原始链接:</span>
                    <p
                      className="text-[10px] text-secondary truncate font-mono bg-surface-container-low/60 p-1.5 rounded border border-outline-variant/30 leading-normal"
                      title={item.sourceUrl}
                    >
                      {item.sourceUrl || '(无原始链接)'}
                    </p>
                  </div>
                </div>

                {/* 操作按键栏 */}
                <div className="grid grid-cols-3 gap-1.5 mt-5 pt-3 border-t border-outline-variant/30 shrink-0">
                  {(() => {
                    const url = item.sourceUrl || '';
                    const isHttpUrl = url.startsWith('http://') || url.startsWith('https://');
                    return isHttpUrl ? (
                      <a
                        href={url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center justify-center gap-1 py-1.5 rounded-lg text-[10px] font-bold border border-outline-variant bg-surface-container-low hover:bg-surface-container transition-colors"
                      >
                        <ExternalLink size={10} />
                        电脑打开
                      </a>
                    ) : (
                      <span
                        className="flex items-center justify-center gap-1 py-1.5 rounded-lg text-[10px] font-bold border border-outline-variant/40 bg-surface-container-low/40 text-secondary/40 cursor-not-allowed select-none"
                        title={url ? `不支持的链接格式: ${url}` : '无原始链接'}
                      >
                        <ExternalLink size={10} />
                        电脑打开
                      </span>
                    );
                  })()}

                  <button
                    onClick={() => handleToggle(item.index, item.status === 'valid' ? 'none' : 'valid')}
                    disabled={isToggling}
                    className={`flex items-center justify-center gap-1 py-1.5 rounded-lg text-[10px] font-bold transition-all border ${
                      item.status === 'valid'
                        ? 'bg-success-container/30 text-success border-success/30 hover:bg-success-container/45'
                        : 'border-outline-variant bg-surface-container-low hover:bg-surface-container'
                    } disabled:opacity-50`}
                  >
                    <CheckCircle size={10} />
                    {item.status === 'valid' ? '已标有效' : '标记有效'}
                  </button>

                  <button
                    onClick={() => handleToggle(item.index, item.status === 'invalid' ? 'none' : 'invalid')}
                    disabled={isToggling}
                    className={`flex items-center justify-center gap-1 py-1.5 rounded-lg text-[10px] font-bold transition-all border ${
                      item.status === 'invalid'
                        ? 'bg-error-container/30 text-error border-error/30 hover:bg-error-container/45'
                        : 'border-outline-variant bg-surface-container-low hover:bg-surface-container'
                    } disabled:opacity-50`}
                  >
                    <Power size={10} />
                    {item.status === 'invalid' ? '已标失效' : '标记失效'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
