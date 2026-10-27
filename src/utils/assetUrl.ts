/** 资源索引存的是原始路径，逐段编码以保留文件名中的 #、&、空格等字符。 */
export function assetUrl(path: string, origin: string): string {
  if (/^(https?:|blob:|data:)/i.test(path)) return path;
  if (path.startsWith('/repo/')) return origin + path;
  return `${origin}/repo/${path.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/')}`;
}

export function loadBackgroundImage(path: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    const timer = setTimeout(() => { img.src = ''; reject(new Error('背景图片加载超时，请重新选择图片或稍后重试')); }, 15000);
    img.onload = () => { clearTimeout(timer); resolve(img); };
    img.onerror = () => { clearTimeout(timer); reject(new Error('背景图片加载失败，请重新选择图片或检查资源是否存在')); };
    img.src = assetUrl(path, window.location.origin);
  });
}
