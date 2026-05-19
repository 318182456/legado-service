import React from 'react';

interface StatCardProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  color: string;
  isSmallValue?: boolean;
}

export function StatCard({ icon, label, value, color, isSmallValue }: StatCardProps) {
  return (
    <div className="bg-surface-container-lowest border border-outline-variant rounded-xl p-6 flex items-center gap-4 shadow-sm">
      <div className={`w-12 h-12 rounded-full flex items-center justify-center ${color}`}>
        {icon}
      </div>
      <div>
        <p className="text-xs text-secondary mb-1">{label}</p>
        <p className={`${isSmallValue ? 'text-lg' : 'text-2xl'} font-bold tracking-tight`}>{value}</p>
      </div>
    </div>
  );
}
