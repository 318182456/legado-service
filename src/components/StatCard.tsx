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
    <div className="stat-card">
      <div className="stat-card-heading">
        <p>{label}</p>
        <div className={`stat-card-icon ${color}`}>{icon}</div>
      </div>
      <p className={`stat-card-value ${isSmallValue ? 'is-small' : ''}`}>{value}</p>
    </div>
  );
}
