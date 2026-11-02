import React from 'react';
import { ArrowRight, Search, X } from 'lucide-react';

export function WorkspaceHeader({ eyebrow, title, description, actions }: {
  eyebrow: string; title: string; description: string; actions?: React.ReactNode;
}) {
  return <header className="studio-heading">
    <div><p className="studio-eyebrow">{eyebrow}</p><h2>{title}</h2><p>{description}</p></div>
    {actions && <div className="studio-actions">{actions}</div>}
  </header>;
}

export function WorkspaceTabs({ label, items, value, onChange }: {
  label: string; items: { id: string; label: string; count?: number }[];
  value: string; onChange: (value: string) => void;
}) {
  return <nav className="studio-tabs" aria-label={label}>
    {items.map(item => <button key={item.id} type="button" aria-pressed={value === item.id}
      onClick={() => onChange(item.id)} className={value === item.id ? 'is-selected' : ''}>
      {item.label}{item.count !== undefined && <span>{item.count.toLocaleString()}</span>}
    </button>)}
  </nav>;
}

export function WorkspaceSearch({ value, onChange, placeholder = '搜索名称或地址', label = '搜索' }: {
  value: string; onChange: (value: string) => void; placeholder?: string; label?: string;
}) {
  return <div className="studio-search"><Search size={17} />
    <input aria-label={label} value={value} onChange={event => onChange(event.target.value)} placeholder={placeholder} />
    {value && <button type="button" aria-label={`清除${label}`} onClick={() => onChange('')}><X size={15} /></button>}
  </div>;
}

export function WorkspaceEmpty({ icon, title, description, action, onAction }: {
  icon: React.ReactNode; title: string; description: string; action?: string; onAction?: () => void;
}) {
  return <div className="studio-empty"><div className="studio-empty-icon">{icon}</div>
    <h3>{title}</h3><p>{description}</p>
    {action && onAction && <button className="button-primary" onClick={onAction}>{action}<ArrowRight size={15} /></button>}
  </div>;
}
