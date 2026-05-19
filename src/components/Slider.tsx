import React from 'react';

export function Slider({ 
  label, value, min, max, unit = '', onChange, step, displayValue 
}: { 
  label: string; value: number; min: number; max: number; unit?: string; onChange: (v: number) => void; step?: number;
  displayValue?: (v: number) => string;
}) {
  const currentStep = step || (min < 5 && max < 10 ? 0.1 : 1);
  const formatted = displayValue ? displayValue(value) : value;
  
  return (
    <div className="space-y-2">
      <div className="flex justify-between text-[10px] text-outline font-bold uppercase tracking-wider">
        <span>{label}</span>
        <span>{formatted}{unit}</span>
      </div>
      <input 
        type="range" min={min} max={max} step={currentStep}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-primary h-1 bg-surface-container-highest rounded-lg appearance-none cursor-pointer"
      />
    </div>
  );
}
