import React from 'react';

interface NavItemProps {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  collapsed?: boolean;
}

export function NavItem({ active, onClick, icon, label, collapsed = false }: NavItemProps) {
  return (
    <button
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      aria-label={label}
      title={collapsed ? label : undefined}
      className={`nav-item ${active ? 'is-active' : ''} ${collapsed ? 'is-collapsed' : ''}`}
    >
      {icon}
      <span className="nav-label">{label}</span>
    </button>
  );
}
