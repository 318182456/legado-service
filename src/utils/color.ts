/**
 * 颜色转换工具函数
 */

// 转换 Legado 的 ARGB (#AARRGGBB) 或整数颜色为 CSS 的 RGBA (#RRGGBBAA)
export function argbToCss(color: any) {
  if (typeof color === 'number') {
    // 处理整数颜色 (int32)
    const hex = (color >>> 0).toString(16).padStart(8, '0');
    const a = hex.substring(0, 2);
    const r = hex.substring(2, 4);
    const g = hex.substring(4, 6);
    const b = hex.substring(6, 8);
    return `#${r}${g}${b}${a}`;
  }
  if (typeof color !== 'string') return color;
  if (!color.startsWith('#')) return color;
  if (color.length === 9) {
    const a = color.substring(1, 3);
    const r = color.substring(3, 5);
    const g = color.substring(5, 7);
    const b = color.substring(7, 9);
    return `#${r}${g}${b}${a}`;
  }
  return color;
}

// 转换 CSS 颜色回 Legado ARGB (主要用于保存)
export function cssToArgb(color: any) {
  if (typeof color !== 'string' || !color.startsWith('#')) return color;
  if (color.length === 7) return `#ff${color.substring(1)}`; // #RRGGBB -> #ffRRGGBB
  if (color.length === 9) {
    const r = color.substring(1, 3);
    const g = color.substring(3, 5);
    const b = color.substring(5, 7);
    const a = color.substring(7, 9);
    return `#${a}${r}${g}${b}`;
  }
  return color;
}

// 获取不带 Alpha 的 6 位 Hex (用于 input[type=color])
export function getHex6(color: any) {
  if (typeof color === 'number') {
    const hex = (color >>> 0).toString(16).padStart(8, '0');
    return `#${hex.substring(2, 8)}`; // ARGB 的整数，取 RRGGBB
  }
  if (typeof color !== 'string' || !color.startsWith('#')) return '#000000';
  if (color.length === 9) return `#${color.substring(3, 9)}`; // #AARRGGBB -> #RRGGBB
  return color;
}
