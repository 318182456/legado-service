import React, { useState, useEffect, useMemo } from 'react';
import { 
  X, ChevronRight, Folder, Package, Type, Search, Image as ImageIcon
} from 'lucide-react';
import { FontPreview } from './FontPreview';

export function AssetPicker({ type, fileTree, onSelect, onClose }: { type: string; fileTree: any; onSelect: (r: any) => void; onClose: () => void }) {
  const [currentPath, setCurrentPath] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [searchInNameOnly, setSearchInNameOnly] = useState(true);
  
  const extensions = useMemo(() => {
    if (type === 'font') return ['.ttf', '.otf', '.woff2'];
    const imgExts = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'];
    if (type === 'bg') return [...imgExts, '.zip', '.json'];
    if (type === 'layout') return ['.json', '.zip', '.txt'];
    return [];
  }, [type]);

  const isImage = (path: string) => {
    const ext = path.toLowerCase().slice(path.lastIndexOf('.'));
    return ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'].includes(ext);
  };

  useEffect(() => {
    // 默认进入对应文件夹
    if (type === 'font') setCurrentPath(['fonts']);
    if (type === 'layout') setCurrentPath(['layouts']);
    if (type === 'bg') setCurrentPath([]); // 背景图可能分布在 themes 和 layouts，从根目录开始更方便
  }, [type]);

  const currentContent = useMemo(() => {
    if (!fileTree) return [];
    
    const isMatch = (node: any) => {
      if (node.type !== 'file') return true; // 始终显示文件夹
      const ext = node.path.toLowerCase().slice(node.path.lastIndexOf('.'));
      return extensions.includes(ext);
    };

    // 如果有搜索词，执行全量平铺搜索
    if (query) {
      const keywords = query.toLowerCase().split(/\s+/).filter(Boolean);
      const results: any[] = [];
      
      const traverse = (node: any) => {
        if (node.type === 'file') {
          if (!isMatch(node)) return;
          const target = searchInNameOnly ? node.name.toLowerCase() : node.path.toLowerCase();
          if (keywords.every(kw => target.includes(kw))) {
            results.push(node);
          }
        } else if (node.children) {
          Object.values(node.children).forEach(traverse);
        }
      };
      traverse(fileTree); // 搜索整个树
      return results;
    }

    // 无搜索词，按路径浏览
    let current = fileTree;
    for (const part of currentPath) {
      if (current.children && current.children[part]) {
        current = current.children[part];
      } else {
        return [];
      }
    }

    return Object.values(current.children || {})
      .filter((item: any) => {
        if (item.type === 'folder') return true;
        return isMatch(item);
      })
      .sort((a: any, b: any) => {
        if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
  }, [fileTree, currentPath, query, searchInNameOnly, type, extensions]);

  const handleSelect = (item: any) => {
    onSelect(item);
  };

  const title = type === 'font' ? '选择字体' : type === 'bg' ? '选择背景图' : '选择排版方案';

  return (
    <div className="flex flex-col h-full bg-surface relative">
      <div className="px-6 py-4 border-b border-outline-variant flex items-center justify-between bg-surface-bright">
        <h4 className="font-bold flex items-center gap-2">{title}</h4>
        <button onClick={onClose} className="p-2 hover:bg-surface-container rounded-full transition-colors"><X size={20} /></button>
      </div>

      {/* 搜索栏 */}
      <div className="px-4 py-3 bg-surface-container/20 border-b border-outline-variant/30 flex flex-col gap-2">
        <div className="relative flex items-center bg-surface-container-lowest border border-outline-variant rounded-xl overflow-hidden focus-within:ring-2 focus-within:ring-primary/20 transition-all">
          <Search className="ml-3 text-secondary shrink-0" size={14} />
          <input 
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={searchInNameOnly ? "输入关键字过滤文件名..." : "输入关键字过滤路径..."}
            className="w-full bg-transparent pl-2 pr-2 py-2 text-xs outline-none"
          />
          <button 
            onClick={() => setSearchInNameOnly(!searchInNameOnly)}
            className={`px-2 py-1 mx-1 text-[8px] font-bold rounded transition-colors shrink-0 ${searchInNameOnly ? 'bg-primary/10 text-primary' : 'bg-surface-container text-secondary'}`}
          >
            {searchInNameOnly ? '文件名' : '路径'}
          </button>
          {query && (
            <button onClick={() => setQuery('')} className="p-2 text-outline hover:text-primary transition-colors">
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      {/* 路径导航 (仅在非搜索模式显示) */}
      {!query && (
        <div className="px-4 py-2 bg-surface-container/10 flex items-center gap-1 text-[10px] text-secondary overflow-x-auto whitespace-nowrap scrollbar-none border-b border-outline-variant/10">
          <button onClick={() => setCurrentPath([])} className="hover:text-primary p-1">根目录</button>
          {currentPath.map((p, i) => (
            <React.Fragment key={i}>
              <ChevronRight size={10} className="opacity-30" />
              <button onClick={() => setCurrentPath(currentPath.slice(0, i + 1))} className="hover:text-primary p-1">{p}</button>
            </React.Fragment>
          ))}
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
        {currentContent.length === 0 ? (
          <div className="py-20 text-center text-outline">
            <Search size={32} className="mx-auto mb-2 opacity-20" />
            <p className="text-[10px]">未找到匹配项</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {currentContent.map((item: any, idx: number) => {
              const isFolder = item.type === 'folder';
              return (
                <div 
                  key={idx}
                  onClick={() => isFolder ? setCurrentPath([...currentPath, item.name]) : handleSelect(item)}
                  className="group flex flex-col bg-surface-container-lowest border border-outline-variant rounded-xl p-2 cursor-pointer hover:border-primary/50 transition-all shadow-sm hover:shadow-md"
                >
                  <div className="aspect-video rounded-lg bg-surface-container mb-2 overflow-hidden flex items-center justify-center">
                    {isFolder ? (
                      <Folder size={24} className="text-primary/40 group-hover:scale-110 transition-transform" />
                    ) : isImage(item.path) ? (
                      <img src={`${window.location.origin}/repo/${item.path}`} className="w-full h-full object-cover group-hover:scale-105 transition-transform" />
                    ) : type === 'layout' ? (
                      <Package size={24} className="text-primary/30" />
                    ) : type === 'font' ? (
                      <FontPreview path={item.path} name={item.name} />
                    ) : <Type size={24} className="text-primary/30" />}
                  </div>
                  <div className="flex flex-col min-w-0">
                    <span className="text-[10px] font-bold truncate group-hover:text-primary transition-colors">{item.name}</span>
                    {query && !searchInNameOnly && <span className="text-[8px] text-outline truncate opacity-60 italic">{item.path}</span>}
                    {isFolder && <span className="text-[8px] text-outline">文件夹</span>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

    </div>
  );
}
