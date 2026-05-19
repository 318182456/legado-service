import React, { useState, useEffect, useRef } from 'react';
import { Type, AlertCircle, Loader2 } from 'lucide-react';

// 全局字体加载状态缓存，防止同一个字体在多个卡片中重复加载
const fontCache = new Map<string, { id: string; status: 'loading' | 'loaded' | 'error' }>();

export function FontPreview({ path, name }: { path: string; name: string }) {
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [inView, setInView] = useState(false);
  
  const containerRef = useRef<HTMLDivElement>(null);
  const fontId = useRef(`font_${Math.random().toString(36).substring(7)}`);

  // 使用 IntersectionObserver 实现懒加载
  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInView(true);
          observer.disconnect();
        }
      },
      { threshold: 0.1, rootMargin: '100px' }
    );

    if (containerRef.current) {
      observer.observe(containerRef.current);
    }

    return () => observer.disconnect();
  }, [path]);

  // 当进入视野后才开始加载字体
  useEffect(() => {
    if (!inView || loaded || loading) return;

    const cached = fontCache.get(path);
    if (cached) {
      if (cached.status === 'loaded') {
        fontId.current = cached.id;
        setLoaded(true);
        return;
      } else if (cached.status === 'error') {
        setError(true);
        return;
      }
      // 如果正在加载中，设置一个定时器稍后检查，或者简单地等待下次渲染
    }

    setLoading(true);
    fontCache.set(path, { id: fontId.current, status: 'loading' });
    
    const fontUrl = `${window.location.origin}/repo/${path}`;
    const fontFace = new (window as any).FontFace(fontId.current, `url('${fontUrl}')`, {
      display: 'swap'
    });

    fontFace.load().then((f: any) => {
      (document.fonts as any).add(f);
      fontCache.set(path, { id: fontId.current, status: 'loaded' });
      setLoaded(true);
      setLoading(false);
    }).catch((e: any) => {
      console.warn(`Font preview failed for ${name}:`, e);
      fontCache.set(path, { id: fontId.current, status: 'error' });
      setError(true);
      setLoading(false);
    });
  }, [inView, path, name]);

  return (
    <div 
      ref={containerRef}
      className="w-full h-full flex flex-col items-center justify-center p-2 text-center relative group"
      style={{ fontFamily: loaded ? fontId.current : 'inherit' }}
    >
      {!inView ? (
        <div className="animate-pulse bg-surface-container-high w-16 h-8 rounded-md mb-1"></div>
      ) : loading ? (
        <div className="flex flex-col items-center animate-in fade-in duration-500">
           <Loader2 className="animate-spin text-primary/30 mb-1" size={24} />
           <span className="text-[10px] text-secondary opacity-50">加载中...</span>
        </div>
      ) : error ? (
        <div className="flex flex-col items-center text-error/40">
           <AlertCircle size={24} className="mb-1" />
           <span className="text-[10px]">无法加载预览</span>
        </div>
      ) : (
        <div className="animate-in zoom-in-95 duration-300">
          <span className="text-2xl mb-1 block">阅读</span>
          <span className="text-[10px] opacity-40 truncate w-full block px-2">{name}</span>
        </div>
      )}
      
      {/* 鼠标悬停时的全名气泡 */}
      <div className="absolute bottom-0 left-1/2 -translate-x-1/2 translate-y-full opacity-0 group-hover:opacity-100 transition-opacity bg-on-surface text-surface px-2 py-1 rounded text-[10px] z-10 whitespace-nowrap pointer-events-none shadow-xl border border-white/10">
        {name}
      </div>
    </div>
  );
}
