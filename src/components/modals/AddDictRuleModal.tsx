import React, { useState } from 'react';
import { X, RefreshCw } from 'lucide-react';
import * as api from '../../api';

interface AddDictRuleModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAdded: () => void;
  editData?: { id: number; name: string; url_rule: string; show_rule?: string; sort_number?: number } | null;
}

export function AddDictRuleModal({ isOpen, onClose, onAdded, editData }: AddDictRuleModalProps) {
  const [name, setName] = useState('');
  const [urlRule, setUrlRule] = useState('');
  const [showRule, setShowRule] = useState('');
  const [sortNumber, setSortNumber] = useState<number>(0);
  const [loading, setLoading] = useState(false);

  React.useEffect(() => {
    if (editData) {
      setName(editData.name);
      setUrlRule(editData.url_rule);
      setShowRule(editData.show_rule || '');
      setSortNumber(editData.sort_number ?? 0);
    } else {
      setName('');
      setUrlRule('');
      setShowRule('');
      setSortNumber(0);
    }
  }, [editData, isOpen]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name || !urlRule) return;
    setLoading(true);
    try {
      if (editData) {
        await api.updateDictRule(editData.id, { name, urlRule, showRule, sortNumber });
      } else {
        await api.addDictRule({ name, urlRule, showRule, sortNumber });
      }
      setName('');
      setUrlRule('');
      setShowRule('');
      setSortNumber(0);
      onAdded();
    } catch (e) {
      alert((editData ? '更新' : '添加') + '失败: ' + String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
      <div className="bg-surface-container-lowest w-full max-w-lg rounded-2xl shadow-2xl overflow-hidden border border-outline-variant animate-in fade-in zoom-in duration-200">
        <div className="px-6 py-4 border-b border-outline-variant bg-surface-bright flex justify-between items-center">
          <h3 className="text-lg font-bold text-on-surface">{editData ? '修改字典规则' : '手动添加字典规则'}</h3>
          <button onClick={onClose} className="p-1 hover:bg-surface-container rounded-full transition-colors text-secondary hover:text-on-surface"><X size={20} /></button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs font-bold text-secondary ml-1">字典名称</label>
            <input 
              autoFocus
              type="text" 
              value={name} 
              onChange={e => setName(e.target.value)} 
              placeholder="例如：百度汉语、Wiktionary"
              className="w-full bg-surface-container-lowest border border-outline-variant rounded-xl px-4 py-2.5 text-sm outline-none focus:border-primary focus:ring-4 focus:ring-primary/10 transition-all"
              required
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-bold text-secondary ml-1">划词查询 URL 规则</label>
            <input 
              type="text" 
              value={urlRule} 
              onChange={e => setUrlRule(e.target.value)} 
              placeholder="例如：https://dict.baidu.com/s?wd={{key}}"
              className="w-full bg-surface-container-lowest border border-outline-variant rounded-xl px-4 py-2.5 text-sm outline-none focus:border-primary focus:ring-4 focus:ring-primary/10 transition-all font-mono"
              required
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-bold text-secondary ml-1">内容解析展示规则 (选填)</label>
            <textarea 
              value={showRule} 
              onChange={e => setShowRule(e.target.value)} 
              placeholder="例如：.content@text 或 css解析规则"
              className="w-full bg-surface-container-lowest border border-outline-variant rounded-xl px-4 py-2.5 text-sm outline-none focus:border-primary focus:ring-4 focus:ring-primary/10 transition-all min-h-[80px] font-mono"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-bold text-secondary ml-1">排序号 (数字越小越靠前)</label>
            <input 
              type="number" 
              value={sortNumber} 
              onChange={e => setSortNumber(Number(e.target.value))} 
              placeholder="0"
              className="w-full bg-surface-container-lowest border border-outline-variant rounded-xl px-4 py-2.5 text-sm outline-none focus:border-primary focus:ring-4 focus:ring-primary/10 transition-all"
              required
            />
          </div>
          <div className="pt-4 flex gap-3">
            <button 
              type="button"
              onClick={onClose}
              className="flex-1 py-2.5 rounded-xl border border-outline-variant font-bold text-sm hover:bg-surface-container-low transition-all"
            >
              取消
            </button>
            <button 
              type="submit"
              disabled={loading}
              className="flex-1 py-2.5 rounded-xl bg-primary text-on-primary font-bold text-sm hover:opacity-90 transition-all shadow-lg shadow-primary/20 flex items-center justify-center gap-2"
            >
              {loading && <RefreshCw size={16} className="animate-spin" />}
              {editData ? '更新规则' : '保存规则'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
