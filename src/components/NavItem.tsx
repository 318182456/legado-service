import React from 'react';

interface NavItemProps {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}

export function NavItem({ active, onClick, icon, label }: NavItemProps) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-all text-sm font-medium ${
        active 
          ? 'bg-surface-container text-primary border-l-2 border-primary rounded-l-none' 
          : 'text-secondary hover:bg-surface-container-low hover:text-primary'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}
