import React, { useState, useEffect } from 'react';
import { motion } from 'motion/react';
import { 
  X, Copy, RefreshCw, Package, FileText 
} from 'lucide-react';
import { FontPreview } from './FontPreview';

// 外部库引用 (假设父组件已加载或此处动态加载)
declare const fflate: any;

export function PreviewModal({ item, onClose }: { item: any; onClose: () => void }) {
  const [content, setContent] = useState<string>('');
  const [zipFiles, setZipFiles] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const textExts = ['txt', 'json', 'js', 'css', 'md', 'html'];
    if (textExts.includes(item.extension)) {
      setLoading(true);
      fetch(item.url)
        .then(res => res.text())
        .then(text => {
          try {
            setContent(JSON.stringify(JSON.parse(text), null, 2));
          } catch {
            setContent(text);
          }
        })
        .finally(() => setLoading(false));
    } else if (item.extension === 'zip') {
      setLoading(true);
      fetch(item.url)
        .then(res => res.arrayBuffer())
        .then(async buf => {
          // 这里尝试使用全局 fflate，如果未加载则动态导入
          let f = (window as any).fflate;
          if (!f) {
             // @ts-ignore
             const mod = await import('https://cdn.skypack.dev/fflate');
             f = mod;
             (window as any).fflate = f;
          }
          if (f) {
            const unzipped = f.unzipSync(new Uint8Array(buf));
            setZipFiles(Object.keys(unzipped));
          }
        })
        .finally(() => setLoading(false));
    }
  }, [item]);

  return (
    <div 
      onClick={(e) => e.target === e.currentTarget && onClose()}
      className="fixed inset-0 z-80 flex items-center justify-center p-6 bg-on-background/40 backdrop-blur-sm"
    >
      <motion.div 
        initial={{ opacity: 0, scale: 0.9, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.9, y: 20 }}
        className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-2xl w-full max-w-4xl max-h-[85vh] overflow-hidden flex flex-col"
      >
        <div className="px-6 py-4 border-b border-outline-variant flex items-center justify-between bg-surface-bright">
          <div className="flex flex-col">
            <h3 className="font-bold text-lg">{item.name}</h3>
            <span className="text-[10px] text-secondary font-mono">{item.path}</span>
          </div>
          <div className="flex items-center gap-2">
            <button 
              onClick={() => {
                navigator.clipboard.writeText(item.url);
                alert('链接已复制');
              }}
              className="p-2 text-secondary hover:bg-surface-container rounded-lg transition-colors flex items-center gap-2 text-xs font-bold"
            >
              <Copy size={16} /> 复制 URL
            </button>
            <button onClick={onClose} className="p-2 text-secondary hover:bg-surface-container rounded-full transition-colors">
              <X size={20} />
            </button>
          </div>
        </div>

        <div className={`flex-1 p-6 bg-surface ${['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(item.extension) ? 'overflow-hidden' : 'overflow-y-auto custom-scrollbar'}`}>
          {loading ? (
            <div className="flex flex-col items-center justify-center py-20 gap-4">
              <RefreshCw className="animate-spin text-primary" size={32} />
              <p className="text-sm text-secondary">正在分析资源...</p>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-full">
              {['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(item.extension) ? (
                <img src={item.url} alt={item.name} className="max-w-full max-h-full object-contain rounded-lg shadow-md" />
              ) : item.extension === 'zip' ? (
                <div className="w-full">
                  <div className="flex items-center gap-2 mb-4 text-primary">
                    <Package size={20} />
                    <span className="font-bold">压缩包内容列表</span>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    {zipFiles.map(f => (
                      <div key={f} className="flex items-center gap-2 p-2 bg-surface-container rounded-lg text-xs font-mono">
                        <FileText size={14} className="text-secondary" />
                        {f}
                      </div>
                    ))}
                  </div>
                </div>
              ) : content ? (
                <div className={`w-full p-8 border border-outline-variant rounded-xl overflow-x-auto ${item.extension === 'txt' ? 'bg-[#fdf6e3] text-[#657b83] font-sans leading-relaxed' : 'bg-surface-container-lowest font-mono text-xs'}`}>
                  {item.extension === 'txt' ? (
                    <div className="whitespace-pre-wrap text-sm">
                      {content}
                    </div>
                  ) : (
                    <pre className="whitespace-pre-wrap text-[10px]">
                      {content}
                    </pre>
                  )}
                </div>
              ) : (
                <div className="py-20 text-center text-secondary">
                   <Package size={64} className="mx-auto mb-4 opacity-10" />
                   <p>该格式暂无可视化预览，您可以复制链接或下载查看。</p>
                </div>
              )}
            </div>
          )}
        </div>
      </motion.div>
    </div>
  );
}
