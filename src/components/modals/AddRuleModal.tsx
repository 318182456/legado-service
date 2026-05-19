import React, { useState } from 'react';
import { X, RefreshCw } from 'lucide-react';
import * as api from '../../api';

interface AddRuleModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAdded: () => void;
  editData?: { id: number; name: string; pattern: string; replacement: string } | null;
}

export function AddRuleModal({ isOpen, onClose, onAdded, editData }: AddRuleModalProps) {
  const [name, setName] = useState('');
  const [pattern, setPattern] = useState('');
  const [replacement, setReplacement] = useState('');
  const [loading, setLoading] = useState(false);

  React.useEffect(() => {
    if (editData) {
      setName(editData.name);
      setPattern(editData.pattern);
      setReplacement(editData.replacement || '');
    } else {
      setName('');
      setPattern('');
      setReplacement('');
    }
  }, [editData, isOpen]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name || !pattern) return;
    setLoading(true);
    try {
      if (editData) {
        await api.updateRule(editData.id, { name, pattern, replacement });
      } else {
        await api.addRule({ name, pattern, replacement });
      }
      setName('');
      setPattern('');
      setReplacement('');
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
          <h3 className="text-lg font-bold text-on-surface">{editData ? '修改净化规则' : '手动添加净化规则'}</h3>
          <button onClick={onClose} className="p-1 hover:bg-surface-container rounded-full transition-colors text-secondary hover:text-on-surface"><X size={20} /></button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs font-bold text-secondary ml-1">规则名称</label>
            <input 
              autoFocus
              type="text" 
              value={name} 
              onChange={e => setName(e.target.value)} 
              placeholder="例如：去除广告弹窗"
              className="w-full bg-surface-container-lowest border border-outline-variant rounded-xl px-4 py-2.5 text-sm outline-none focus:border-primary focus:ring-4 focus:ring-primary/10 transition-all"
              required
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-bold text-secondary ml-1">匹配模式 (Regex)</label>
            <textarea 
              value={pattern} 
              onChange={e => setPattern(e.target.value)} 
              placeholder="正则表达式，例如：<div id='ad'>.*?</div>"
              className="w-full bg-surface-container-lowest border border-outline-variant rounded-xl px-4 py-2.5 text-sm outline-none focus:border-primary focus:ring-4 focus:ring-primary/10 transition-all min-h-[100px] font-mono"
              required
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-bold text-secondary ml-1">替换内容</label>
            <input 
              type="text" 
              value={replacement} 
              onChange={e => setReplacement(e.target.value)} 
              placeholder="留空则表示删除匹配内容"
              className="w-full bg-surface-container-lowest border border-outline-variant rounded-xl px-4 py-2.5 text-sm outline-none focus:border-primary focus:ring-4 focus:ring-primary/10 transition-all font-mono"
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
