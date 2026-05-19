import React, { useState } from 'react';
import { X, RefreshCw } from 'lucide-react';
import * as api from '../../api';

interface AddTxtTocRuleModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAdded: () => void;
  editData?: { id: number; name: string; rule: string; example?: string; serial_number?: number } | null;
}

export function AddTxtTocRuleModal({ isOpen, onClose, onAdded, editData }: AddTxtTocRuleModalProps) {
  const [name, setName] = useState('');
  const [rule, setRule] = useState('');
  const [example, setExample] = useState('');
  const [serialNumber, setSerialNumber] = useState<number>(-1);
  const [loading, setLoading] = useState(false);

  React.useEffect(() => {
    if (editData) {
      setName(editData.name);
      setRule(editData.rule);
      setExample(editData.example || '');
      setSerialNumber(editData.serial_number ?? -1);
    } else {
      setName('');
      setRule('');
      setExample('');
      setSerialNumber(-1);
    }
  }, [editData, isOpen]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name || !rule) return;
    setLoading(true);
    try {
      if (editData) {
        await api.updateTxtTocRule(editData.id, { name, rule, example, serialNumber });
      } else {
        await api.addTxtTocRule({ name, rule, example, serialNumber });
      }
      setName('');
      setRule('');
      setExample('');
      setSerialNumber(-1);
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
          <h3 className="text-lg font-bold text-on-surface">{editData ? '修改目录规则' : '手动添加目录规则'}</h3>
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
              placeholder="例如：第X章、卷X"
              className="w-full bg-surface-container-lowest border border-outline-variant rounded-xl px-4 py-2.5 text-sm outline-none focus:border-primary focus:ring-4 focus:ring-primary/10 transition-all"
              required
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-bold text-secondary ml-1">匹配正则表达式</label>
            <textarea 
              value={rule} 
              onChange={e => setRule(e.target.value)} 
              placeholder="正则表达式，例如：^\s*第[一二三四五六七八九十百千万零\d]+章.*$"
              className="w-full bg-surface-container-lowest border border-outline-variant rounded-xl px-4 py-2.5 text-sm outline-none focus:border-primary focus:ring-4 focus:ring-primary/10 transition-all min-h-[100px] font-mono"
              required
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-bold text-secondary ml-1">预览例文 (选填)</label>
            <input 
              type="text" 
              value={example} 
              onChange={e => setExample(e.target.value)} 
              placeholder="匹配的预览例子，例如：第一章 重生"
              className="w-full bg-surface-container-lowest border border-outline-variant rounded-xl px-4 py-2.5 text-sm outline-none focus:border-primary focus:ring-4 focus:ring-primary/10 transition-all"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-bold text-secondary ml-1">匹配序号 (选填，留空或-1为未指定)</label>
            <input 
              type="number" 
              value={serialNumber === -1 ? '' : serialNumber} 
              onChange={e => setSerialNumber(e.target.value === '' ? -1 : Number(e.target.value))} 
              placeholder="-1"
              className="w-full bg-surface-container-lowest border border-outline-variant rounded-xl px-4 py-2.5 text-sm outline-none focus:border-primary focus:ring-4 focus:ring-primary/10 transition-all"
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
