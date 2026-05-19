import React, { useState, useEffect } from 'react';
import { motion } from 'motion/react';
import { Sparkles, X, RefreshCw, Plus, Search, Info } from 'lucide-react';
import * as api from '../../api';

interface WebDiscoveryModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAdded: () => void;
}

export function WebDiscoveryModal({ isOpen, onClose, onAdded }: WebDiscoveryModalProps) {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [list, setList] = useState<{ name: string; url: string; type: 'source' | 'rule' }[]>([]);
  const [history, setHistory] = useState<string[]>([]);
  const [editingNames, setEditingNames] = useState<Record<number, string>>({});
  const [adding, setAdding] = useState<string | null>(null);
  const [existingUrls, setExistingUrls] = useState<Set<string>>(new Set());
  const [selectedUrls, setSelectedUrls] = useState<Set<string>>(new Set());
  const [batchAdding, setBatchAdding] = useState(false);

  useEffect(() => {
    if (isOpen) {
      const h = localStorage.getItem('parse_history');
      if (h) setHistory(JSON.parse(h));
      api.getSubscriptions().then(subs => setExistingUrls(new Set(subs.map(s => s.url)))).catch(() => {});
    }
  }, [isOpen]);

  const handleParse = async () => {
    if (!url) return;
    setLoading(true);
    try {
      const results = await api.parseLinks(url);
      setList(results);
      setEditingNames({});
      setSelectedUrls(new Set());
      const nextHistory = [url, ...history.filter(h => h !== url)].slice(0, 10);
      setHistory(nextHistory);
      localStorage.setItem('parse_history', JSON.stringify(nextHistory));
    } catch (e) {
      alert('解析失败: ' + String(e));
    } finally {
      setLoading(false);
    }
  };

  const handleAdd = async (item: { name: string; url: string; type: 'source' | 'rule' }) => {
    if (existingUrls.has(item.url)) return;
    setAdding(item.url);
    try {
      await api.addSubscription({ name: item.name, url: item.url, type: item.type });
      setExistingUrls(prev => new Set([...prev, item.url]));
    } catch (e) {
      alert('添加失败: ' + String(e));
    } finally {
      setAdding(null);
    }
  };

  const handleBatchAdd = async () => {
    if (selectedUrls.size === 0) return;
    setBatchAdding(true);
    let success = 0;
    for (const subUrl of selectedUrls) {
      const item = list.find(i => i.url === subUrl);
      if (item && !existingUrls.has(subUrl)) {
        try {
          const name = editingNames[list.indexOf(item)] ?? item.name;
          await api.addSubscription({ name, url: subUrl, type: item.type });
          success++;
        } catch (e) {
          console.error(`Failed to add ${subUrl}`, e);
        }
      }
    }
    setBatchAdding(false);
    alert(`成功批量添加 ${success} 个订阅`);
    onAdded();
  };

  const toggleSelect = (url: string) => {
    const next = new Set(selectedUrls);
    if (next.has(url)) next.delete(url);
    else next.add(url);
    setSelectedUrls(next);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-on-background/40 backdrop-blur-sm">
      <motion.div 
        initial={{ opacity: 0, scale: 0.95, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-2xl w-full max-w-2xl overflow-hidden flex flex-col max-h-[80vh]"
      >
        <div className="px-6 py-4 border-b border-outline-variant flex items-center justify-between bg-surface-bright shrink-0">
          <div className="flex items-center gap-3">
            <h3 className="font-bold text-lg flex items-center gap-2 text-on-surface">
              <Sparkles size={20} className="text-tertiary" />
              外部网页解析
            </h3>
            {list.length > 0 && selectedUrls.size > 0 && (
              <button 
                onClick={handleBatchAdd}
                disabled={batchAdding}
                className="bg-primary text-on-primary px-3 py-1 rounded-full text-xs font-bold hover:opacity-90 transition-all flex items-center gap-1.5 shadow-md"
              >
                {batchAdding ? <RefreshCw className="animate-spin" size={14} /> : <Plus size={14} />}
                添加选中 ({selectedUrls.size})
              </button>
            )}
          </div>
          <button onClick={onClose} className="p-1 text-secondary hover:text-on-surface transition-colors">
            <X size={20} />
          </button>
        </div>

        <div className="p-6 border-b border-outline-variant bg-surface shrink-0 space-y-4">
          <div className="flex gap-2">
            <input 
              type="url" 
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="输入网页 URL (如: https://yuedu.miaogongzi.net/gx.html)"
              className="flex-1 bg-surface-container-lowest border border-outline-variant rounded-lg px-4 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/20 transition-all"
            />
            <button 
              onClick={handleParse}
              disabled={loading}
              className="bg-primary text-on-primary px-4 py-2 rounded-lg text-sm font-bold hover:opacity-90 transition-all disabled:opacity-50 flex items-center gap-2"
            >
              {loading ? <RefreshCw className="animate-spin" size={16} /> : <Search size={16} />}
              解析
            </button>
          </div>
          {history.length > 0 && (
            <div className="flex flex-wrap gap-2 items-center">
              <span className="text-[10px] text-secondary">历史记录:</span>
              {history.map((h, i) => (
                <button 
                  key={i} 
                  onClick={() => { setUrl(h); setTimeout(handleParse, 0); }}
                  className="text-[10px] bg-surface-container text-secondary px-2 py-0.5 rounded hover:bg-primary/10 hover:text-primary transition-all max-w-[150px] truncate"
                >
                  {new URL(h).hostname}...{h.split('/').pop()}
                </button>
              ))}
            </div>
          )}
          <p className="text-[10px] text-secondary">将自动提取页面中 yuedu:// 或 legado:// 协议的导入链接</p>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-2 custom-scrollbar">
          {loading ? (
            <div className="py-12 text-center">
              <RefreshCw className="animate-spin mx-auto text-primary mb-4" size={32} />
              <p className="text-secondary">正在获取并解析页面内容...</p>
            </div>
          ) : list.length === 0 ? (
            <div className="py-12 text-center">
              <Info className="mx-auto text-secondary mb-4" size={32} />
              <p className="text-secondary">未找到任何有效的导入链接，请尝试输入其他 URL</p>
            </div>
          ) : (
            list.map((item, idx) => {
              const baseName = item.name === '未知来源' 
                ? (item.url.split('/').pop()?.replace('.json', '') || '未知来源')
                : item.name;
              const currentName = editingNames[idx] ?? baseName;
              const isAdded = existingUrls.has(item.url);
              const isSelected = selectedUrls.has(item.url);

              return (
                <div key={idx} className={`flex flex-col p-4 rounded-xl border transition-all ${
                  isAdded ? 'bg-surface-container-low/50 border-outline-variant opacity-75' : 
                  isSelected ? 'border-primary bg-primary/5' : 'border-outline-variant hover:bg-surface-container-low'
                }`}>
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex items-center gap-3 flex-1 min-w-0">
                      {!isAdded && (
                        <input 
                          type="checkbox" 
                          checked={isSelected}
                          onChange={() => toggleSelect(item.url)}
                          className="h-4 w-4 rounded border-outline-variant text-primary focus:ring-primary/20 cursor-pointer"
                        />
                      )}
                      <div className="min-w-0 flex-1 flex flex-col">
                        <div className="flex items-center gap-2">
                          <input 
                            type="text"
                            value={currentName}
                            onChange={(e) => setEditingNames({...editingNames, [idx]: e.target.value})}
                            disabled={isAdded}
                            className={`font-bold text-sm bg-transparent border-b border-transparent hover:border-outline focus:border-primary px-1 py-0.5 outline-none transition-all w-full ${isAdded ? 'text-secondary' : ''}`}
                          />
                          {item.type === 'source' ? (
                            <span className="shrink-0 px-1.5 py-0.5 bg-emerald-500/10 text-emerald-600 text-[10px] rounded font-bold">书源</span>
                          ) : (
                            <span className="shrink-0 px-1.5 py-0.5 bg-purple-500/10 text-purple-600 text-[10px] rounded font-bold">净化规则</span>
                          )}
                          {isAdded && (
                            <span className="shrink-0 px-1.5 py-0.5 bg-surface-container-highest text-secondary text-[10px] rounded font-bold">已添加</span>
                          )}
                        </div>
                        <p className="text-[10px] text-secondary truncate mt-1 font-mono px-1">{item.url}</p>
                      </div>
                    </div>
                    <button 
                      onClick={() => handleAdd({ ...item, name: currentName })}
                      disabled={!!adding || isAdded}
                      className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all shadow-sm flex items-center gap-1.5 shrink-0 ${
                        isAdded ? 'bg-surface-container text-outline cursor-default shadow-none' : 'bg-primary text-on-primary hover:opacity-90'
                      }`}
                    >
                      {adding === item.url ? <RefreshCw className="animate-spin" size={14} /> : <Plus size={14} />}
                      {isAdded ? '已在库' : '添加'}
                    </button>
                  </div>
                  {!isAdded && (
                    <div className="mt-2 flex flex-wrap gap-1 ml-7">
                      {currentName.split(/[\s·\-_]+/).filter(s => s.length > 1).map((word, wi) => (
                        <button 
                          key={wi}
                          onClick={() => setEditingNames({...editingNames, [idx]: word})}
                          className="text-[10px] bg-secondary-container/20 text-secondary px-1.5 py-0.5 rounded hover:bg-primary hover:text-on-primary transition-all"
                        >
                          {word}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </motion.div>
    </div>
  );
}
