import React from 'react';

interface IconButtonProps {
  icon: React.ReactNode;
  onClick?: () => void;
  title?: string;
}

export function IconButton({ icon, onClick, title }: IconButtonProps) {
  return (
    <button 
      onClick={onClick}
      title={title}
      aria-label={title}
      className="w-9 h-9 rounded-lg flex items-center justify-center text-secondary hover:bg-surface-container hover:text-primary transition-colors shrink-0"
    >
      {icon}
    </button>
  );
}
