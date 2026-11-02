import React, { useState } from 'react';
import { BookOpen, ListTree, Sparkles, Plus, RefreshCw, Pencil, Trash2, ChevronLeft, ChevronRight, ArrowUpRight } from 'lucide-react';
import { WorkspaceHeader, WorkspaceSearch, WorkspaceEmpty } from './Workspace';

interface RuleLibraryProps {
  kind: 'replace' | 'toc' | 'dictionary';
  rules: any[]; total: number; page: number; totalPages: number; query: string;
  loading: boolean; error: string;
  onSearch: (value: string) => void; onRefresh: () => void; onAdd: () => void;
  onEdit: (rule: any) => void; onToggle: (id: number, enabled: boolean) => void;
  onDelete: (id: number) => void; onPage: (page: number) => void;
}

const libraries = {
  replace: { title: '替换与净化', icon: Sparkles, description: '去除干扰，修正文字，让正文回归清晰。', hint: '匹配正文后，将命中的内容替换为指定文本。替换内容留空表示移除。', fields: [['匹配表达式', 'pattern'], ['替换为', 'replacement']] },
  toc: { title: '目录规则', icon: ListTree, description: '从一整本文本中，找到每个章节的起点。', hint: 'TXT 导入时使用这些表达式识别章节。选中规则可查看例文和章节序号。', fields: [['分章表达式', 'rule'], ['预览例文', 'example'], ['序号', 'serial_number']] },
  dictionary: { title: '字典规则', icon: BookOpen, description: '划词之间，连接更多知识。', hint: '为阅读器中的划词查询提供地址和内容解析规则。', fields: [['查询地址规则', 'url_rule'], ['内容解析规则', 'show_rule'], ['排序', 'sort_number']] },
};

export function RuleLibrary(props: RuleLibraryProps) {
  const {kind, rules, total, page, totalPages, query, loading, error, onSearch, onRefresh, onAdd, onEdit, onToggle, onDelete, onPage} = props;
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const selected = rules.find(rule => rule.id === selectedId) || rules[0];
  const library = libraries[kind];
  return <div className="studio-view rule-studio">
    <WorkspaceHeader eyebrow="READING / RULE LIBRARY" title={library.title} description={library.description}
      actions={<button className="button-primary" onClick={onAdd}><Plus size={16} />新建规则</button>} />
    <div className="rule-library-layout">
      <section className="studio-collection rule-list-panel">
        <div className="collection-toolbar"><WorkspaceSearch value={query} onChange={onSearch} label="搜索规则" placeholder="按名称搜索规则" /><button className="tile-icon-button" aria-label="刷新规则" onClick={onRefresh} disabled={loading}><RefreshCw size={17} className={loading ? 'animate-spin' : ''} /></button></div>
        <div className="rule-list-caption"><strong>{loading ? '正在加载…' : `${total.toLocaleString()} 条规则`}</strong><span>本页启用 {rules.filter(rule => rule.enabled).length} 条</span></div>
        {error && <div className="notice-error" role="alert">加载失败：{error}<button onClick={onRefresh}>重试</button></div>}
        {!loading && rules.length === 0 ? <WorkspaceEmpty icon={<library.icon size={30} />} title={query ? '没有匹配的规则' : '创建第一条规则'} description={query ? '换一个名称试试。' : library.hint} action={query ? '清除搜索' : '新建规则'} onAction={query ? () => onSearch('') : onAdd} /> :
          <div className="rule-records" aria-busy={loading}>{rules.map(rule => <article key={rule.id} className={selected?.id === rule.id ? 'is-selected' : ''}>
            <button className="rule-record-select" aria-pressed={selected?.id === rule.id} onClick={() => setSelectedId(rule.id)}><span className="rule-record-icon"><library.icon size={18} /></span><span><strong>{rule.name || '未命名规则'}</strong><code>{String(rule[library.fields[0][1]] || '未填写表达式')}</code></span><ArrowUpRight size={15} /></button>
            <button className={`rule-status ${rule.enabled ? 'is-enabled' : ''}`} onClick={() => onToggle(rule.id, !!rule.enabled)} aria-label={`切换规则状态：${rule.name}`}><span />{rule.enabled ? '启用' : '停用'}</button>
          </article>)}</div>}
        <div className="studio-pagination"><span>第 {page} / {Math.max(1,totalPages)} 页</span><div><button aria-label="上一页" onClick={() => onPage(page-1)} disabled={page <= 1 || loading}><ChevronLeft size={16} /></button><button aria-label="下一页" onClick={() => onPage(page+1)} disabled={page >= totalPages || loading}><ChevronRight size={16} /></button></div></div>
      </section>
      <aside className="rule-inspector">
        <div className="inspector-intro"><span>RULE INSPECTOR</span><h3>规则详情</h3><p>从左侧选择一条规则，查看完整内容。</p></div>
        {selected ? <><div className="inspector-rule-title"><library.icon size={24} /><strong>{selected.name}</strong><span className={`status-badge ${selected.enabled ? 'is-enabled' : ''}`}>{selected.enabled ? '已启用' : '已停用'}</span></div>
          <dl>{library.fields.map(([label, field]) => <div key={field}><dt>{label}</dt><dd><pre>{String(selected[field] ?? '未设置') || '（空内容）'}</pre></dd></div>)}</dl>
          <div className="inspector-actions"><button className="button-primary" onClick={() => onEdit(selected)}><Pencil size={15} />编辑规则</button><button className="button-secondary danger" onClick={() => onDelete(selected.id)}><Trash2 size={15} />删除</button></div></> : <div className="inspector-placeholder"><library.icon size={36} /><p>这里会显示规则的完整表达式与配置。</p></div>}
        <div className="inspector-help"><strong>使用提示</strong><p>{library.hint}</p></div>
      </aside>
    </div>
  </div>;
}
