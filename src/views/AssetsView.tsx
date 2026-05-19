import React, { useState, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Search, RefreshCw, Package, Book, Sparkles, Copy, X, Folder, 
  ChevronRight, Home, Trash2, Image as ImageIcon, Type, 
  FileText, Download, Maximize2, Palette, LayoutGrid, List,
  ArrowUpDown, Filter, Plus
} from 'lucide-react';
import * as api from '../api';

import { PreviewModal } from '../components/PreviewModal';
import { FontPreview } from '../components/FontPreview';
import { StyleSandbox } from '../components/StyleSandbox';
import { ThemeThumbnail } from '../components/ThemeThumbnail';
import { argbToCss } from '../utils/color';

const formatDate = (dateStr: string) => {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  return `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')}`;
};

export default function AssetsView() {
  const [data, setData] = useState<any>(null);
  const [customThemes, setCustomThemes] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [currentPath, setCurrentPath] = useState<string[]>([]);
  const [previewItem, setPreviewItem] = useState<any>(null);
  const [sandboxConfig, setSandboxConfig] = useState<any>(null);
  const [viewMode, setViewMode] = useState<'explorer' | 'featured'>('explorer');

  // 新增功能状态
  const [layoutType, setLayoutType] = useState<'grid' | 'list'>('grid');
  const [categoryFilter, setCategoryFilter] = useState<'all' | 'image' | 'font' | 'theme' | 'zip'>('all');
  const [sortOrder, setSortOrder] = useState<'name' | 'type'>('type');
  const [searchInNameOnly, setSearchInNameOnly] = useState(false);

  const isImage = (path: string) => {
    const ext = path?.toLowerCase().split('.').pop();
    return ['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext || '');
  };

  const handlePaletteClick = (item: any) => {
    if (isImage(item.path)) {
      setSandboxConfig({ 
        base: item, 
        type: 'bg' 
      });
    } else {
      setSandboxConfig({ 
        base: item, 
        type: item.extension === 'zip' ? 'zip' : (item.category === 'fonts' ? 'font' : 'theme') 
      });
    }
  };

  const createBlankTheme = () => {
    setSandboxConfig({ base: null, type: 'blank' });
  };

  const fetchAll = async (refresh = false) => {
    setLoading(true);
    try {
      const [res, themes] = await Promise.all([
        refresh ? api.refreshResources() : api.getResources(),
        api.getCustomThemes()
      ]);
      setData(res);
      setCustomThemes(themes);
    } catch (e) {
      console.error('获取资源列表失败', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAll();
  }, []);

  // 构建文件夹树
  const fileTree = useMemo(() => {
    if (!data) return null;
    const root: any = { name: 'root', children: {}, type: 'folder', path: '' };
    
    Object.entries(data).forEach(([category, items]: [string, any]) => {
      items.forEach((item: any) => {
        const parts = item.path.split('/');
        let current = root;
        parts.forEach((part: string, index: number) => {
          if (index === parts.length - 1) {
            current.children[part] = { 
              ...item, 
              type: 'file', 
              category,
              extension: part.split('.').pop()?.toLowerCase()
            };
          } else {
            if (!current.children[part]) {
              current.children[part] = { 
                name: part, 
                type: 'folder', 
                path: parts.slice(0, index + 1).join('/'),
                children: {} 
              };
            }
            current = current.children[part];
          }
        });
      });
    });
    return root;
  }, [data]);

  // 获取当前路径下的内容并进行过滤/排序
  const currentContent = useMemo(() => {
    if (!fileTree) return [];
    
    let baseContent: any[] = [];
    if (query) {
      // 搜索模式：平铺展示，支持多关键字（空格分隔）
      const keywords = query.toLowerCase().split(/\s+/).filter(Boolean);
      const results: any[] = [];
      const traverse = (node: any) => {
        if (node.type === 'file') {
          const target = searchInNameOnly ? node.name.toLowerCase() : node.path.toLowerCase();
          if (keywords.every(kw => target.includes(kw))) {
            results.push(node);
          }
        } else if (node.children) {
          Object.values(node.children).forEach(traverse);
        }
      };
      Object.values(fileTree.children).forEach(traverse);
      baseContent = results;
    } else {
      let current = fileTree;
      for (const part of currentPath) {
        if (current.children && current.children[part]) {
          current = current.children[part];
        } else {
          return [];
        }
      }
      baseContent = Object.values(current.children || {});
    }

    // 类型过滤
    let filtered = baseContent;
    if (categoryFilter !== 'all') {
      filtered = baseContent.filter(item => {
        if (item.type === 'folder') return true; // 文件夹始终显示
        if (categoryFilter === 'image') return ['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(item.extension);
        if (categoryFilter === 'font') return ['ttf', 'otf', 'woff', 'woff2'].includes(item.extension);
        if (categoryFilter === 'theme') return ['json', 'zip', 'txt'].includes(item.extension) || item.category === 'themes';
        if (categoryFilter === 'zip') return item.extension === 'zip';
        return true;
      });
    }

    // 排序
    return filtered.sort((a: any, b: any) => {
      if (sortOrder === 'type') {
        if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
        return a.extension?.localeCompare(b.extension || '') || a.name.localeCompare(b.name);
      }
      return a.name.localeCompare(b.name);
    });
  }, [fileTree, currentPath, query, categoryFilter, sortOrder, searchInNameOnly]);

  const navigateTo = (path: string[]) => {
    setCurrentPath(path);
    setQuery('');
  };

  const getIcon = (item: any, size = 20) => {
    if (item.type === 'folder') return <Folder className="text-primary" size={size} />;
    const ext = item.extension;
    if (['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext)) return <ImageIcon className="text-tertiary" size={size} />;
    if (['ttf', 'otf', 'woff', 'woff2'].includes(ext)) return <Type className="text-secondary" size={size} />;
    if (['txt', 'json', 'js', 'css'].includes(ext)) return <FileText className="text-outline" size={size} />;
    return <Book className="text-outline" size={size} />;
  };

  const deleteTheme = async (id: number) => {
    if (!confirm('确定删除该精选主题吗？')) return;
    try {
      await api.deleteCustomTheme(id);
      fetchAll();
    } catch (e) {
      alert('删除失败');
    }
  };

  const categories = [
    { id: 'all', label: '全部', icon: <Filter size={14} /> },
    { id: 'image', label: '图片', icon: <ImageIcon size={14} /> },
    { id: 'font', label: '字体', icon: <Type size={14} /> },
    { id: 'theme', label: '主题', icon: <Palette size={14} /> },
    { id: 'zip', label: '压缩包', icon: <Package size={14} /> },
  ];

  const quickTags = [
    '护眼', '黑色', '精选', '封面', '简约', '高仿'
  ];

  const handleTagClick = (tag: string) => {
    setQuery(prev => prev.includes(tag) ? prev : (prev + ' ' + tag).trim());
  };

  const editTheme = (item: any) => {
    setSandboxConfig({ 
      base: item, 
      type: 'saved' 
    });
  };

  return (
    <div className="space-y-6 pb-20 relative h-full flex flex-col">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-outline-variant/30 pb-6 shrink-0">
        <div>
          <h2 className="text-3xl font-bold tracking-tight text-on-surface flex items-center gap-3">
            <span className="text-4xl">📚</span> Legado 资源中心
          </h2>
          <p className="text-sm text-secondary mt-1">
            {viewMode === 'explorer' ? '浏览与管理云端 R2 存储的排版布局、字体及背景图片资源。' : '查看已保存到云端的精选定制主题。'}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="bg-surface-container p-1 rounded-xl flex gap-1 shadow-inner">
            <button 
              onClick={() => setViewMode('explorer')}
              className={`px-6 py-2 rounded-lg text-sm font-bold transition-all ${viewMode === 'explorer' ? 'bg-surface-bright shadow-md text-primary scale-105' : 'text-secondary hover:bg-surface-bright/50'}`}
            >
              资源浏览器
            </button>
            <button 
              onClick={() => setViewMode('featured')}
              className={`px-6 py-2 rounded-lg text-sm font-bold transition-all ${viewMode === 'featured' ? 'bg-surface-bright shadow-md text-primary scale-105' : 'text-secondary hover:bg-surface-bright/50'}`}
            >
              精选主题 ({customThemes.length})
            </button>
          </div>
          <div className="relative w-72 flex items-center bg-surface-container-lowest border border-outline-variant rounded-xl shadow-sm focus-within:ring-2 focus-within:ring-primary/20 transition-all overflow-hidden">
            <Search className="ml-3 text-secondary shrink-0" size={16} />
            <input 
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={searchInNameOnly ? "按文件名搜索..." : "按路径/名称搜索..."}
              className="w-full bg-transparent pl-2 pr-4 py-2 text-sm outline-none"
            />
            <button 
              onClick={() => setSearchInNameOnly(!searchInNameOnly)}
              className={`px-2 py-1 mx-1 text-[10px] font-bold rounded-md transition-colors shrink-0 ${searchInNameOnly ? 'bg-primary/10 text-primary' : 'bg-surface-container text-secondary'}`}
              title={searchInNameOnly ? "切换为全路径搜索" : "切换为仅文件名搜索"}
            >
              {searchInNameOnly ? '文件名' : '全路径'}
            </button>
          </div>
          <button 
            onClick={() => fetchAll(true)}
            className="p-2.5 bg-surface-container-lowest border border-outline-variant text-primary rounded-xl hover:bg-surface-container-low transition-colors shadow-sm"
            title="刷新数据"
          >
            <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {viewMode === 'explorer' ? (
        <div className="flex-1 min-h-0 flex flex-col gap-4">
          {/* 工具栏: 面包屑 + 布局切换 + 排序 */}
          <div className="flex flex-wrap items-center justify-between gap-4">
            {!query && (
              <div className="flex items-center gap-1 text-sm text-secondary overflow-x-auto whitespace-nowrap py-1 scrollbar-none">
                <button onClick={() => navigateTo([])} className="p-1.5 hover:bg-surface-container rounded-lg transition-colors flex items-center gap-1.5 hover:text-primary"><Home size={16} /><span className="font-bold">根目录</span></button>
                {currentPath.map((part, i) => (
                  <React.Fragment key={i}>
                    <ChevronRight size={14} className="opacity-30" /><button onClick={() => navigateTo(currentPath.slice(0, i + 1))} className="px-2 py-1.5 hover:bg-surface-container rounded-lg transition-colors font-medium hover:text-primary">{part}</button>
                  </React.Fragment>
                ))}
              </div>
            )}
            
            <div className="flex items-center gap-3 ml-auto">
              {/* 常用关键字标签 */}
              <div className="hidden lg:flex items-center gap-2 mr-4">
                 <span className="text-[10px] text-outline font-bold uppercase">常用标签:</span>
                 {quickTags.map(tag => (
                   <button 
                     key={tag} 
                     onClick={() => handleTagClick(tag)}
                     className="px-2 py-0.5 bg-surface-container hover:bg-primary/10 hover:text-primary text-[10px] rounded transition-colors text-secondary font-medium"
                   >
                     {tag}
                   </button>
                 ))}
              </div>

              {/* 类型过滤标签 */}
              <div className="flex bg-surface-container p-1 rounded-xl">
                {categories.map(cat => (
                  <button 
                    key={cat.id} 
                    onClick={() => setCategoryFilter(cat.id as any)}
                    className={`flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-bold transition-all ${categoryFilter === cat.id ? 'bg-surface-bright shadow-sm text-primary' : 'text-secondary hover:text-on-surface'}`}
                  >
                    {cat.icon} {cat.label}
                  </button>
                ))}
              </div>

              {/* 排序与布局切换 */}
              <div className="w-px h-8 bg-outline-variant/30 mx-1"></div>
              
              <button 
                onClick={() => setSortOrder(sortOrder === 'name' ? 'type' : 'name')}
                className="p-2 text-secondary hover:bg-surface-container rounded-lg transition-colors flex items-center gap-2 text-xs font-bold"
                title={sortOrder === 'name' ? '按类型排序' : '按名称排序'}
              >
                <ArrowUpDown size={16} /> {sortOrder === 'name' ? '名称' : '类型'}
              </button>

              <div className="bg-surface-container p-1 rounded-xl flex gap-1">
                <button onClick={() => setLayoutType('grid')} className={`p-1.5 rounded-lg transition-all ${layoutType === 'grid' ? 'bg-surface-bright text-primary shadow-sm' : 'text-secondary'}`}><LayoutGrid size={16} /></button>
                <button onClick={() => setLayoutType('list')} className={`p-1.5 rounded-lg transition-all ${layoutType === 'list' ? 'bg-surface-bright text-primary shadow-sm' : 'text-secondary'}`}><List size={16} /></button>
              </div>
            </div>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar pr-2">
            {loading ? (
              <div className="py-20 text-center text-secondary"><RefreshCw size={32} className="animate-spin mx-auto mb-4 opacity-20" /><p>正在同步资源结构...</p></div>
            ) : currentContent.length === 0 ? (
              <div className="py-20 text-center text-secondary border border-dashed border-outline-variant rounded-2xl"><Package size={48} className="mx-auto mb-4 opacity-10" /><p>{query ? '未找到相关资源' : '该文件夹为空'}</p></div>
            ) : layoutType === 'grid' ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5 gap-4">
                {currentContent.map((item: any, idx: number) => {
                  const isFolder = item.type === 'folder';
                  const url = `${window.location.origin}/repo/${item.path}`;
                  const isImg = isImage(item.path);
                  
                  return (
                    <div 
                      key={idx} 
                      onClick={() => {
                        if (isFolder) navigateTo([...currentPath, item.name]);
                        else if (['txt', 'zip', 'json'].includes(item.extension)) setPreviewItem({ ...item, url });
                      }} 
                      className="group flex flex-col bg-surface-container-lowest border border-outline-variant rounded-xl p-3 transition-all hover:shadow-lg hover:border-primary/30 cursor-pointer"
                    >
                      <div className="relative aspect-video rounded-lg bg-surface-container overflow-hidden flex items-center justify-center mb-3">
                        {isFolder ? (
                          <Folder size={48} className="text-primary/40 group-hover:scale-110 transition-transform" />
                        ) : isImg ? (
                          <img src={url} alt={item.name} className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-500" />
                        ) : (['json', 'zip', 'txt'].includes(item.extension) || item.category === 'themes') ? (
                          <div className="w-full h-full p-2 flex items-center justify-center bg-surface-container-low">
                            <div className={`${item.extension === 'txt' ? 'w-full' : 'w-[80px]'} transition-transform group-hover:scale-105`}>
                              <ThemeThumbnail path={item.path} name={item.name} />
                            </div>
                          </div>
                        ) : ['ttf', 'otf', 'woff', 'woff2'].includes(item.extension) ? (
                          <FontPreview path={item.path} name={item.name} />
                        ) : (
                          <div className="text-primary/30 font-bold text-lg uppercase">{item.extension || 'FILE'}</div>
                        )}
                        {!isFolder && (
                          <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2">
                             <button onClick={(e) => { e.stopPropagation(); setPreviewItem({ ...item, url }); }} className="p-2 bg-white text-on-surface rounded-full hover:bg-primary hover:text-white transition-all shadow-lg"><Maximize2 size={18} /></button>
                             <button onClick={(e) => { e.stopPropagation(); handlePaletteClick(item); }} className="p-2 bg-white text-on-surface rounded-full hover:bg-primary hover:text-white transition-all shadow-lg"><Palette size={18} /></button>
                          </div>
                        )}
                      </div>
                      <div className="flex flex-col min-w-0">
                        <span className="text-sm font-bold truncate group-hover:text-primary transition-colors" title={item.name}>{item.name}</span>
                        <span className="text-[10px] text-secondary truncate font-mono">{isFolder ? `${Object.keys(item.children || {}).length} 个项目` : item.path}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              /* 列表模式 */
              <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl overflow-hidden">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="bg-surface-container/50 text-[10px] font-bold text-secondary uppercase tracking-wider border-b border-outline-variant/30">
                      <th className="px-6 py-3">名称</th>
                      <th className="px-6 py-3">路径</th>
                      <th className="px-6 py-3">类型</th>
                      <th className="px-6 py-3 text-right">操作</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-outline-variant/20">
                    {currentContent.map((item: any, idx: number) => {
                      const isFolder = item.type === 'folder';
                      const url = `${window.location.origin}/repo/${item.path}`;
                      return (
                        <tr key={idx} onClick={() => isFolder && navigateTo([...currentPath, item.name])} className="hover:bg-primary/5 transition-colors cursor-pointer group text-sm">
                          <td className="px-6 py-4 flex items-center gap-3">
                            {getIcon(item, 18)}
                            <span className="font-bold truncate max-w-[200px]">{item.name}</span>
                          </td>
                          <td className="px-6 py-4 text-xs text-secondary font-mono truncate max-w-[300px]">{item.path}</td>
                          <td className="px-6 py-4">
                            <span className="px-2 py-0.5 bg-surface-container text-[10px] font-bold rounded-full text-secondary uppercase">
                              {isFolder ? 'Folder' : (item.extension || 'File')}
                            </span>
                          </td>
                          <td className="px-6 py-4 text-right">
                            {!isFolder && (
                              <div className="flex items-center justify-end gap-2">
                                <button onClick={(e) => { e.stopPropagation(); setPreviewItem({ ...item, url }); }} className="p-1.5 hover:bg-primary/10 text-primary rounded-lg transition-colors"><Maximize2 size={16} /></button>
                                <button onClick={(e) => { e.stopPropagation(); handlePaletteClick(item); }} className="p-1.5 hover:bg-primary/10 text-primary rounded-lg transition-colors"><Palette size={16} /></button>
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      ) : (
        /* 精选主题视图 */
        <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar pr-2">
          {customThemes.length === 0 ? (
            <div className="py-20 text-center text-secondary border border-dashed border-outline-variant rounded-2xl flex flex-col items-center justify-center p-8 gap-4">
              <Sparkles size={48} className="opacity-10" />
              <p>暂无精选主题。</p>
              <button 
                onClick={createBlankTheme}
                className="flex items-center gap-2 px-5 py-2.5 bg-primary text-on-primary rounded-xl text-xs font-bold hover:opacity-90 transition-all shadow-md"
              >
                <Plus size={16} /> 创建第一个空白主题
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-8">
              {/* 新建空白主题卡片 */}
              <motion.div 
                layout
                onClick={createBlankTheme}
                className="bg-surface-container-lowest border-2 border-dashed border-outline-variant/60 rounded-2xl overflow-hidden shadow-sm hover:border-primary/50 hover:bg-primary/5 transition-all cursor-pointer group flex flex-col justify-center items-center p-6 h-[300px]"
              >
                <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mb-4 group-hover:scale-110 group-hover:bg-primary/20 transition-all duration-300">
                  <Plus className="text-primary" size={32} />
                </div>
                <h4 className="font-bold text-lg text-on-surface group-hover:text-primary transition-colors">新建空白主题</h4>
                <p className="text-xs text-secondary text-center mt-2 px-2">从零开始配置专属排版样式</p>
              </motion.div>

              {customThemes.map((item) => {
                const config = JSON.parse(item.config);
                return (
                  <motion.div 
                    layout
                    key={item.id} 
                    className="bg-surface-container-lowest border border-outline-variant rounded-2xl overflow-hidden shadow-sm hover:shadow-2xl transition-all group relative flex flex-col"
                  >
                    <div className="p-4 bg-surface-container-low/30 flex justify-center cursor-pointer" onClick={() => editTheme(item)}>
                      <div className="w-full max-w-[140px] transition-transform group-hover:scale-[1.05] duration-500">
                        <ThemeThumbnail name={item.name} config={config} previewUrl={item.preview_url} />
                      </div>
                    </div>

                    <div className="p-5 flex-1 flex flex-col">
                      <div className="flex items-center justify-between min-w-0 mb-4">
                        <div className="min-w-0 flex-1">
                          <h4 className="font-bold text-lg truncate text-on-surface group-hover:text-primary transition-colors">{item.name}</h4>
                          <p className="text-[10px] text-secondary mt-1">创建于 {formatDate(item.created_at)}</p>
                        </div>
                        <button onClick={(e) => { e.stopPropagation(); deleteTheme(item.id); }} className="p-2 text-secondary hover:text-error hover:bg-error-container/20 rounded-full transition-all opacity-0 group-hover:opacity-100"><Trash2 size={16} /></button>
                      </div>
                      
                      <div className="grid grid-cols-1 gap-2 mt-auto">
                        <button onClick={() => editTheme(item)} className="flex items-center justify-center gap-2 py-2.5 bg-surface-container text-primary rounded-xl text-xs font-bold hover:bg-primary/10 transition-all border border-primary/20"><Copy size={14} /> 复制并编辑</button>
                        <button onClick={() => { 
                          const exportUrl = `${window.location.origin}/api/custom-themes/${item.id}/export`;
                          window.location.href = `legado://import/readConfig?src=${encodeURIComponent(exportUrl)}`;
                        }} className="flex items-center justify-center gap-2 py-2.5 bg-primary text-on-primary rounded-xl text-xs font-bold hover:opacity-90 transition-all shadow-md shadow-primary/20"><Download size={14} /> 一键导入</button>
                      </div>
                    </div>
                  </motion.div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* 定制沙盒 */}
      <AnimatePresence>
        {sandboxConfig && (
          <div 
            onClick={(e) => e.target === e.currentTarget && setSandboxConfig(null)}
            className="fixed inset-0 z-70 flex items-center justify-center p-6 bg-on-background/60 backdrop-blur-md"
          >
            <StyleSandbox initialBase={sandboxConfig.base} initialType={sandboxConfig.type} fileTree={fileTree} onClose={() => setSandboxConfig(null)} onSaved={() => { setSandboxConfig(null); fetchAll(); }} />
          </div>
        )}
      </AnimatePresence>

      {/* 预览弹窗 */}
      <AnimatePresence>{previewItem && <PreviewModal item={previewItem} onClose={() => setPreviewItem(null)} />}</AnimatePresence>
    </div>
  );
}
