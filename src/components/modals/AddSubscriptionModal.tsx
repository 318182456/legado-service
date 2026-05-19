import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, Plus, RefreshCw, Link, Tag, ListRestart, Sparkles } from 'lucide-react';
import * as api from '../../api';

interface AddSubscriptionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAdded: () => void;
}

export function AddSubscriptionModal({ isOpen, onClose, onAdded }: AddSubscriptionModalProps) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [type, setType] = useState<'source' | 'rule'>('source');
  const [loading, setLoading] = useState(false);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url) return;
    
    setLoading(true);
    try {
      // 如果名称为空，尝试从 URL 获取文件名
      const finalName = name || url.split('/').pop()?.replace('.json', '') || '未命名订阅';
      await api.addSubscription({ name: finalName, url, type });
      
      // 重置并关闭
      setName('');
      setUrl('');
      setType('source');
      onAdded();
    } catch (e) {
      alert('添加失败: ' + String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-on-background/40 backdrop-blur-sm">
      <motion.div 
        initial={{ opacity: 0, scale: 0.95, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden flex flex-col"
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-outline-variant flex items-center justify-between bg-surface-bright">
          <h3 className="font-bold text-lg flex items-center gap-2 text-on-surface">
            <Plus size={20} className="text-primary" />
            直接添加订阅
          </h3>
          <button onClick={onClose} className="p-1 text-secondary hover:text-on-surface transition-colors">
            <X size={20} />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-6 space-y-5">
          <div className="space-y-2">
            <label className="text-xs font-bold text-secondary flex items-center gap-2 ml-1">
              <Link size={14} /> 订阅 URL
            </label>
            <input 
              autoFocus
              type="url" 
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="请输入 JSON 订阅链接 (如: https://.../sources.json)"
              className="w-full bg-surface border border-outline-variant rounded-xl px-4 py-3 text-sm outline-none focus:ring-4 focus:ring-primary/10 focus:border-primary transition-all font-mono"
              required
            />
          </div>

          <div className="space-y-2">
            <label className="text-xs font-bold text-secondary flex items-center gap-2 ml-1">
              <Tag size={14} /> 订阅名称 (可选)
            </label>
            <input 
              type="text" 
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="留空则自动根据 URL 生成"
              className="w-full bg-surface border border-outline-variant rounded-xl px-4 py-3 text-sm outline-none focus:ring-4 focus:ring-primary/10 focus:border-primary transition-all"
            />
          </div>

          <div className="space-y-2">
            <label className="text-xs font-bold text-secondary flex items-center gap-2 ml-1">
              订阅类型
            </label>
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => setType('source')}
                className={`flex items-center justify-center gap-2 py-3 rounded-xl border-2 transition-all font-bold text-sm ${
                  type === 'source' 
                  ? 'border-primary bg-primary/5 text-primary' 
                  : 'border-outline-variant bg-surface text-secondary hover:bg-surface-container'
                }`}
              >
                <ListRestart size={18} />
                书源订阅
              </button>
              <button
                type="button"
                onClick={() => setType('rule')}
                className={`flex items-center justify-center gap-2 py-3 rounded-xl border-2 transition-all font-bold text-sm ${
                  type === 'rule' 
                  ? 'border-tertiary bg-tertiary/5 text-tertiary' 
                  : 'border-outline-variant bg-surface text-secondary hover:bg-surface-container'
                }`}
              >
                <Sparkles size={18} />
                规则订阅
              </button>
            </div>
          </div>

          <div className="pt-4 flex gap-3">
            <button 
              type="button"
              onClick={onClose}
              className="flex-1 py-3 rounded-xl border border-outline-variant font-bold text-sm text-secondary hover:bg-surface-container transition-all"
            >
              取消
            </button>
            <button 
              type="submit"
              disabled={loading || !url}
              className="flex-1 py-3 rounded-xl bg-primary text-on-primary font-bold text-sm hover:opacity-90 disabled:opacity-50 transition-all shadow-lg shadow-primary/20 flex items-center justify-center gap-2"
            >
              {loading ? <RefreshCw className="animate-spin" size={18} /> : <Plus size={18} />}
              立即添加
            </button>
          </div>
        </form>

        <div className="px-6 py-4 bg-surface-container-low border-t border-outline-variant">
          <p className="text-[10px] text-secondary leading-relaxed">
            * 订阅添加后将自动触发同步。如果是书源订阅，程序会解析并存入书源库；如果是规则订阅，则存入净化规则库。
          </p>
        </div>
      </motion.div>
    </div>
  );
}
