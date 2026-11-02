import React, { useState, useEffect } from 'react';
import * as api from '../api';
import { RuleLibrary } from '../components/RuleLibrary';
import { useLatestRequest } from '../hooks/useLatestRequest';

interface TxtTocRulesViewProps {
  onAdd: () => void;
  onEdit: (rule: any) => void;
}

export default function TxtTocRulesView({ onAdd, onEdit }: TxtTocRulesViewProps) {
  const [rules, setRules] = useState<any[]>([]);
  const { loading, error, run, invalidate } = useLatestRequest();
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [query, setQuery] = useState('');

  const fetchRules = (q = '', p = 1) =>
    run(signal => api.getTxtTocRules(q, p, signal), data => {
      setRules(data.rules);
      setTotal(data.total);
      setTotalPages(data.totalPages);
      setPage(data.page);
    });

  useEffect(() => {
    const timer = setTimeout(() => {
      fetchRules(query, 1);
    }, 500);
    return () => { clearTimeout(timer); invalidate(); };
  }, [query]);

  useEffect(() => {
    const handler = () => fetchRules(query, page);
    window.addEventListener('refresh-data', handler);
    return () => window.removeEventListener('refresh-data', handler);
  }, [query, page]);

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
  };

  const handleDelete = async (id: number) => {
    if (!confirm('确定要删除此目录规则吗？')) return;
    try {
      await api.deleteTxtTocRule(id);
      await fetchRules(query, page);
    } catch (e) {
      alert('删除失败: ' + String(e));
    }
  };


  return <RuleLibrary kind="toc" rules={rules} total={total} page={page} totalPages={totalPages}
    query={query} loading={loading} error={error} onSearch={setQuery} onRefresh={() => fetchRules(query,page)}
    onAdd={onAdd} onEdit={handleEdit} onToggle={handleToggle} onDelete={handleDelete} onPage={next => fetchRules(query,next)} />;
}
