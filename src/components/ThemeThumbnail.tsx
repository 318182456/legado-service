import React, { useState, useEffect, useRef } from 'react';
import { Loader2, AlertCircle, ImageIcon, FileText, Archive } from 'lucide-react';
import { LegadoRendererComponent } from '../utils/LegadoRenderer';

const isLocalDevicePath = (p: string) => {
  if (!p) return false;
  return p.startsWith('content://') || p.startsWith('file://') || /^\/(storage|sdcard|data)\//i.test(p);
};

export function ThemeThumbnail({ path, name, config: initialConfig, previewUrl: initialPreviewUrl }: { path?: string; name: string; config?: any; previewUrl?: string }) {
  const [config, setConfig] = useState<any>(initialConfig);
  const [loading, setLoading] = useState(!initialConfig);
  const [error, setError] = useState(false);
  const [inView, setInView] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const [resources, setResources] = useState<any>(null);
  const [fontFamily, setFontFamily] = useState('sans-serif');
  const [textContent, setTextContent] = useState<string>('');

  useEffect(() => {
    import('../api').then(api => {
      api.getResources().then(setResources);
    });
  }, []);

  useEffect(() => {
    if (initialConfig) {
      setConfig(initialConfig);
      setLoading(false);
    }
  }, [initialConfig]);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInView(true);
          observer.disconnect();
        }
      },
      { threshold: 0.1, rootMargin: '50px' }
    );
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [path]);

  useEffect(() => {
    if (!inView || config || !path) return;
    
    const ext = path.split('.').pop()?.toLowerCase();

    // 如果是文本文件，尝试读取内容片段
    if (ext === 'txt') {
      fetch(`${window.location.origin}/repo/${path}`)
        .then(res => res.text())
        .then(text => {
          setTextContent(text.slice(0, 300)); // 取前 300 字
          setLoading(false);
        })
        .catch(() => {
          setError(true);
          setLoading(false);
        });
      return;
    }

    setLoading(true);
    fetch(`${window.location.origin}/repo/${path}`)
      .then(res => res.arrayBuffer())
      .then(async buf => {
        const uint8 = new Uint8Array(buf);
        
        // 如果是 ZIP，尝试读取内部配置
        if (ext === 'zip') {
          let f = (window as any).fflate;
          if (!f) {
            // @ts-ignore
            const mod = await import('https://cdn.skypack.dev/fflate');
            f = mod; (window as any).fflate = f;
          }
          const unzipped = f.unzipSync(uint8);
          const configFile = Object.keys(unzipped).find(k => k.endsWith('readConfig.json'));
          if (configFile) {
            const str = new TextDecoder().decode(unzipped[configFile]);
            setConfig(JSON.parse(str));
          } else {
            throw new Error('Not a theme zip');
          }
        } else {
          // 普通 JSON 主题
          const str = new TextDecoder().decode(uint8);
          setConfig(JSON.parse(str));
        }
        setLoading(false);
      })
      .catch(e => {
        console.warn(`[ThemeThumbnail] Non-theme or invalid file: ${path}`);
        setError(true);
        setLoading(false);
      });
  }, [inView, path]);

  useEffect(() => {
    if (!config?.textFont) return;
    
    const decodedFont = decodeURIComponent(config.textFont).split('/').pop() || '';
    
    // 尝试在资源中找这个字体
    const tryLoad = (path: string, name: string) => {
      const fontUrl = path.startsWith('blob:') ? path : `${window.location.origin}/repo/${path}`;
      const fontFace = new (window as any).FontFace(name, `url(${fontUrl})`);
      fontFace.load().then((loadedFace: any) => {
        (document.fonts as any).add(loadedFace);
        setFontFamily(name);
      }).catch((e: any) => console.error('Theme font load failed', e));
    };

    const isLocal = isLocalDevicePath(config.textFont);
    if (config.textFont.startsWith('blob:')) {
      tryLoad(config.textFont, 'BlobFont_' + Math.random().toString(36).substring(7));
    } else if (!isLocal) {
      const fontName = decodedFont.split('.')[0] || 'ThemeFont';
      tryLoad(config.textFont, fontName);
    } else if (resources) {
      const foundFont = resources.fonts?.find((f: any) => {
        const fDecoded = decodeURIComponent(f.path).split('/').pop();
        return fDecoded === decodedFont || f.path === config.textFont;
      });
      if (foundFont) tryLoad(foundFont.path, foundFont.name);
    }
  }, [config?.textFont, resources]);

  if (!inView) return <div ref={containerRef} className="w-full aspect-9/19 bg-surface-container animate-pulse rounded-lg" />;

  if (loading) return (
    <div ref={containerRef} className="w-full aspect-9/19 bg-surface-container rounded-lg flex flex-col items-center justify-center gap-2">
      <Loader2 className="animate-spin text-primary/30" size={24} />
      <span className="text-[10px] text-secondary opacity-50">加载主题...</span>
    </div>
  );

  if (textContent) {
    return (
      <div 
        ref={containerRef} 
        className="w-full aspect-video rounded-lg shadow-sm bg-[#fdf6e3] p-3 overflow-hidden border border-black/5 relative group cursor-pointer"
      >
        <div className="absolute top-0 right-0 p-2 opacity-20 text-[#657b83]"><FileText size={14} /></div>
        <div className="text-[9px] text-[#657b83] leading-relaxed whitespace-pre-wrap break-all">
          {textContent}
          {textContent.length >= 300 && '...'}
        </div>
        <div className="absolute inset-x-0 bottom-0 h-8 bg-linear-to-t from-[#fdf6e3] to-transparent" />
      </div>
    );
  }

  if (error || (!config && !loading)) {
    const ext = path?.split('.').pop()?.toLowerCase();
    let Icon = AlertCircle;
    let label = '加载失败';
    let color = 'text-error/40';

    if (ext === 'txt') {
      Icon = FileText;
      label = '说明文档';
      color = 'text-primary/30';
    } else if (ext === 'zip') {
      Icon = Archive;
      label = '压缩包';
      color = 'text-secondary/30';
    }

    return (
      <div ref={containerRef} className={`w-full aspect-9/19 bg-surface-container rounded-lg flex flex-col items-center justify-center ${color}`}>
        <Icon size={24} />
        <span className="text-[10px] mt-1 font-medium">{label}</span>
      </div>
    );
  }



  if (textContent) {
    return (
      <div 
        ref={containerRef} 
        className="w-full aspect-9/19.5 rounded-[16px] shadow-lg bg-[#fdf6e3] p-4 overflow-hidden border border-black/5 relative group cursor-pointer"
      >
        <div className="absolute top-0 right-0 p-2 opacity-20 text-[#657b83]"><FileText size={16} /></div>
        <div className="text-[10px] text-[#657b83] leading-relaxed whitespace-pre-wrap break-all">
          {textContent}
          {textContent.length >= 300 && '...'}
        </div>
        <div className="absolute inset-x-0 bottom-0 h-12 bg-linear-to-t from-[#fdf6e3] to-transparent" />
      </div>
    );
  }

  return (
    <div 
      ref={containerRef} 
      className="w-full aspect-9/19.5 rounded-[16px] shadow-[0_12px_30px_-6px_rgba(0,0,0,0.3)] group-hover:ring-2 ring-primary/30 transition-all relative bg-[#0a0a0a] p-[3px] border border-white/10"
    >
      {/* 屏幕内容 */}
      <div className={`w-full h-full rounded-[13px] overflow-hidden relative bg-black ${(initialPreviewUrl || config.preview_url) ? 'bg-surface-container-low' : ''}`}>
        {(initialPreviewUrl || config?.preview_url) ? (
          <img 
            key={initialPreviewUrl || config?.preview_url}
            src={initialPreviewUrl || config?.preview_url} 
            alt={name} 
            className="w-full h-full object-cover animate-in fade-in duration-500"
            loading="lazy"
          />
        ) : config ? (
          /* 实时渲染：当没有预览图时，根据配置画一个 */
          <div className="w-full h-full scale-[0.2] origin-top-left" style={{ width: '500%', height: '500%' }}>
            <LegadoRendererComponent 
              config={config} 
              fontFamily={fontFamily}
              bgBase64={config.bgStr?.startsWith('data:') ? config.bgStr : undefined}
            />
          </div>
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center text-outline/30 bg-surface-container-lowest">
            <ImageIcon size={32} strokeWidth={1} />
            <span className="text-[10px] mt-2">暂无预览</span>
          </div>
        )}
      </div>
    </div>
  );
}
