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
      className="w-10 h-10 rounded-full flex items-center justify-center text-secondary hover:bg-surface-container-low hover:text-primary transition-colors"
    >
      {icon}
    </button>
  );
}
