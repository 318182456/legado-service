import React, { useState, useEffect } from 'react';
import { RefreshCw, Plus, Trash2, List, MoreVertical, Pencil } from 'lucide-react';
import * as api from '../api';

interface TxtTocRulesViewProps {
  onAdd: () => void;
  onEdit: (rule: any) => void;
}

export default function TxtTocRulesView({ onAdd, onEdit }: TxtTocRulesViewProps) {
  const [rules, setRules] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeMenu, setActiveMenu] = useState<number | null>(null);

  const fetchRules = async () => {
    setLoading(true);
    try {
      const data = await api.getTxtTocRules();
      setRules(data);
    } catch (e) {
      console.error('获取目录规则失败', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRules();
    window.addEventListener('refresh-data', fetchRules);
    return () => window.removeEventListener('refresh-data', fetchRules);
  }, []);

  const handleToggle = async (id: number, enabled: boolean) => {
    try {
      await api.toggleTxtTocRule(id, !enabled);
      setRules(prev => prev.map(r => r.id === id ? { ...r, enabled: !enabled ? 1 : 0 } : r));
    } catch (e) {
      alert('操作失败: ' + String(e));
    }
  };

  const handleEdit = (rule: any) => {
    onEdit(rule);
    setActiveMenu(null);
  };

  const handleDelete = async (id: number) => {
    if (!confirm('确定要删除此目录规则吗？')) return;
    try {
      await api.deleteTxtTocRule(id);
      setRules(prev => prev.filter(r => r.id !== id));
      setActiveMenu(null);
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
          <h2 className="text-2xl font-bold tracking-tight">目录规则 (TOC)</h2>
          <p className="text-sm text-secondary mt-1">管理 TXT 文本在导入和解析时的目录分章规则。</p>
        </div>
        <div className="flex items-center gap-3">
          <button 
            onClick={fetchRules}
            className="p-2 border border-outline-variant rounded-lg bg-surface-container-lowest hover:bg-surface-container-low transition-colors"
          >
            <RefreshCw size={20} className={loading ? 'animate-spin' : ''} />
          </button>
          <button 
            onClick={onAdd}
            className="bg-primary text-on-primary px-4 py-2 rounded-lg text-sm font-bold hover:opacity-90 transition-all flex items-center gap-2 shadow-sm"
          >
            <Plus size={18} />
            手动添加目录规则
          </button>
        </div>
      </div>

      <div className="bg-surface-container-lowest border border-outline-variant rounded-xl overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="bg-surface text-secondary text-xs font-bold uppercase tracking-wider border-b border-outline-variant">
                <th className="py-3 px-6">规则名称</th>
                <th className="py-3 px-6">正则表达式 / 序号 / 预览例文</th>
                <th className="py-3 px-6 text-center">状态</th>
                <th className="py-3 px-6 text-right">操作</th>
              </tr>
            </thead>
            <tbody className="text-sm">
              {rules.length === 0 ? (
                <tr>
                  <td colSpan={4} className="py-12 text-center text-secondary">暂无数据</td>
                </tr>
              ) : (
                rules.map((rule, idx) => (
                  <tr key={rule.id} className="border-b border-outline-variant/30 hover:bg-surface-container-low transition-colors group">
                    <td className="py-4 px-6">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full bg-secondary/10 text-secondary flex items-center justify-center">
                          <List size={18} />
                        </div>
                        <span className="font-bold">{rule.name}</span>
                      </div>
                    </td>
                    <td className="py-4 px-6 max-w-md">
                      <div className="flex flex-col gap-1.5">
                        <code className="text-[10px] bg-surface-container px-2 py-1 rounded text-secondary font-mono break-all leading-relaxed" title={rule.rule}>{rule.rule}</code>
                        <div className="flex flex-wrap gap-2">
                          {rule.serial_number !== undefined && rule.serial_number !== -1 && (
                            <span className="text-[9px] bg-tertiary/10 text-tertiary font-bold px-2 py-0.5 rounded">
                              序号: {rule.serial_number}
                            </span>
                          )}
                          {rule.example && (
                            <span className="text-[9px] bg-primary/10 text-primary font-bold px-2 py-0.5 rounded break-all max-w-[250px]" title={rule.example}>
                              例: {rule.example}
                            </span>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="py-4 px-6 text-center">
                      <button 
                        onClick={() => handleToggle(rule.id, !!rule.enabled)}
                        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold transition-all ${
                          rule.enabled ? 'bg-primary/10 text-primary' : 'bg-secondary/10 text-secondary'
                        }`}
                      >
                        <span className={`w-1.5 h-1.5 rounded-full ${rule.enabled ? 'bg-primary' : 'bg-secondary'}`} />
                        {rule.enabled ? '已启用' : '已禁用'}
                      </button>
                    </td>
                    <td className="py-4 px-6 text-right relative">
                      <button 
                        onClick={() => setActiveMenu(activeMenu === idx ? null : idx)}
                        className="p-1 text-secondary hover:text-primary transition-colors"
                      >
                        <MoreVertical size={18} />
                      </button>

                      {activeMenu === idx && (
                        <>
                          <div className="fixed inset-0 z-10" onClick={() => setActiveMenu(null)} />
                          <div className="absolute right-6 top-10 w-24 bg-surface-container-lowest border border-outline-variant rounded-lg shadow-xl z-20 py-1 overflow-hidden">
                            <button 
                              onClick={() => handleEdit(rule)}
                              className="w-full text-left px-4 py-2 text-xs hover:bg-surface-container transition-colors flex items-center gap-2"
                            >
                              <Pencil size={14} /> 修正
                            </button>
                            <button 
                              onClick={() => handleDelete(rule.id)}
                              className="w-full text-left px-4 py-2 text-xs hover:bg-error-container/20 text-error transition-colors flex items-center gap-2"
                            >
                              <Trash2 size={14} /> 删除
                            </button>
                          </div>
                        </>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
