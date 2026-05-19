import React, { useState, useEffect } from 'react';
import { motion } from 'motion/react';
import { 
  Zap, AlignLeft, ImageIcon, Type as FontIcon, Palette, 
  Layout, Type, Settings2, RefreshCw, Share2, ChevronRight,
  FileText, X
} from 'lucide-react';
import * as api from '../api';
import { Slider } from './Slider';
import { AssetPicker } from './AssetPicker';
import { argbToCss, cssToArgb, getHex6 } from '../utils/color';
import { PREVIEW_TITLE, PREVIEW_PARAS, getTipText } from '../utils/constants';
import { LegadoRenderer } from '../utils/LegadoRenderer';

const isLocalDevicePath = (p: string) => {
  if (!p) return false;
  return p.startsWith('content://') || p.startsWith('file://') || /^\/(storage|sdcard|data)\//i.test(p);
};

// --- Canvas 预览组件 ---
const CanvasPreview = ({ config, device, fontFamily, bgImage, loading }: any) => {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const isRunning = React.useRef(false);
  const needsRedraw = React.useRef(false);

  // 使用 Ref 存储最新状态，确保 runDraw 总是能拿到最新的配置
  const latestRef = React.useRef({ config, device, fontFamily, bgImage });
  React.useEffect(() => {
    latestRef.current = { config, device, fontFamily, bgImage };
  }, [config, device, fontFamily, bgImage]);

  React.useEffect(() => {
    let cancelled = false;
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    // 实例化渲染器
    const renderer = new LegadoRenderer(canvas);

    const runDraw = async () => {
      if (isRunning.current) {
        needsRedraw.current = true;
        return;
      }

      const { config: c, device: d_dev, fontFamily: f, bgImage: b } = latestRef.current;

      if (c.textFont && !isLocalDevicePath(c.textFont) && !f) {
        return;
      }

      isRunning.current = true;
      try {
        const PHONE_DPR = 3;
        canvas.width  = d_dev.width  * PHONE_DPR;
        canvas.height = d_dev.height * PHONE_DPR;
        
        if (!cancelled) {
          renderer.scale = PHONE_DPR; // 同步缩放比例
          await renderer.renderTheme(c, {
            bgImage: b,
            getTipText,
            PREVIEW_TITLE,
            PREVIEW_PARAS
          });
        }
      } finally {
        isRunning.current = false;
        if (needsRedraw.current && !cancelled) {
          needsRedraw.current = false;
          runDraw();
        }
      }
    };

    runDraw();
    return () => { cancelled = true; };
  }, [config, device, fontFamily, bgImage]);

  return (
    <div className="w-full h-full relative bg-black">
      <canvas 
        ref={canvasRef} 
        style={{ width: '100%', height: '100%', display: 'block' }} 
      />
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/10 backdrop-blur-[2px] z-50">
          <RefreshCw className="animate-spin text-primary" />
        </div>
      )}
    </div>
  );
};

// 外部库引用
declare const fflate: any;
declare const Tesseract: any;

const TIP_OPTIONS = [
  { value: 0, label: '无' },
  { value: 7, label: '书名' },
  { value: 1, label: '标题' },
  { value: 2, label: '时间' },
  { value: 3, label: '电量' },
  { value: 10, label: '电量%' },
  { value: 4, label: '页数' },
  { value: 5, label: '进度(%)' },
  { value: 11, label: '进度(xx/yyy)' },
  { value: 6, label: '页数及进度' },
  { value: 8, label: '时间及电量' },
  { value: 9, label: '时间及电量%' },
];

function TipView({ value }: { value: number }) {
  if (value === 0) return <span></span>;
  const labelMap: Record<number, string> = {
    7: '影视世界当神探',
    1: '第1353章 1369章会面...',
    2: '11:00',
    3: '■',
    10: '69%',
    4: '1',
    5: '60.5%',
    11: '1/13',
    6: '1/13 60.5%',
    8: '11:00 ■',
    9: '11:00 69%'
  };
  return <span>{labelMap[value] || ''}</span>;
}

function TipSelector({ label, value, onChange }: { label: string, value: number, onChange: (v: number) => void }) {
  return (
    <div className="flex-1 flex flex-col gap-1">
      <span className="text-[9px] text-outline text-center">{label}</span>
      <select 
        value={value} 
        onChange={e => onChange(parseInt(e.target.value))}
        className="w-full bg-surface-container-lowest border border-outline-variant rounded-lg px-1 py-1.5 text-[10px] outline-none"
      >
        {TIP_OPTIONS.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
      </select>
    </div>
  );
}

const DEFAULT_CONFIG = {
  bgStr: '#EEEEEE',
  bgType: 0,
  textColor: '#3E3D3B',
  textSize: 22,
  lineSpacingExtra: 12,
  paragraphSpacing: 5,
  paragraphIndent: '　　',
  paddingLeft: 16,
  paddingRight: 16,
  paddingTop: 15,
  paddingBottom: 15,
  titleMode: 0,
  titleSize: 0,
  titleTopSpacing: 8,
  titleBottomSpacing: 10,
  headerMode: 1,
  headerPaddingTop: 0,
  headerPaddingBottom: 0,
  headerPaddingLeft: 24,
  headerPaddingRight: 24,
  footerMode: 0,
  footerPaddingTop: 6,
  footerPaddingBottom: 6,
  footerPaddingLeft: 24,
  footerPaddingRight: 24,
  showHeaderLine: false,
  showFooterLine: true,
  tipHeaderLeft: 2, 
  tipHeaderMiddle: 0,
  tipHeaderRight: 3, 
  tipFooterLeft: 1,
  tipFooterMiddle: 0,
  tipFooterRight: 6,
  tipColor: '#803E3D3B',
  textFont: '',
  bgAlpha: 100,
  letterSpacing: 0.05,
  textBold: 0,
  darkStatusIcon: true,
  pageAnim: 2
};

export function StyleSandbox({ initialBase, initialType, onClose, onSaved, fileTree }: { initialBase: any; initialType: 'theme' | 'font' | 'zip' | 'saved' | 'image' | 'bg' | 'blank'; onClose: () => void; onSaved: () => void; fileTree: any }) {
  const [config, setConfig] = useState<any>(() => {
    const isSaved = initialType === 'saved';
    const isBlank = initialType === 'blank';
    const baseName = initialBase?.name || (isBlank ? '自定义主题' : '未知');
    const cfg = {
      ...DEFAULT_CONFIG,
      name: isSaved ? baseName : (isBlank ? baseName : baseName + ' 定制'),
    };
    if (initialType === 'bg') {
      cfg.bgStr = initialBase.path;
      cfg.bgType = 2;
    }
    if (isSaved && initialBase.config) {
       const savedCfg = typeof initialBase.config === 'string' ? JSON.parse(initialBase.config) : initialBase.config;
       return { ...cfg, ...savedCfg, id: initialBase.id };
    }
    return cfg;
  });

  const DEVICES = [
    { id: 'ace6t', name: '一加 Ace 6T', width: 360, height: 800, ratio: '20:9', radius: 32, innerRadius: 26, bezel: 1.5, notch: 'hole' },
    { id: 'iphone15', name: 'iPhone 15 Pro', width: 393, height: 852, ratio: '19.5:9', radius: 42, innerRadius: 34, bezel: 2.5, notch: 'island' },
    { id: 'pixel8', name: 'Pixel 8', width: 360, height: 800, ratio: '20:9', radius: 32, innerRadius: 24, bezel: 2.0, notch: 'hole' },
    { id: 'classic', name: 'Classic Android', width: 360, height: 640, ratio: '16:9', radius: 8, innerRadius: 4, bezel: 4.0, notch: 'none' }
  ];
  const [device, setDevice] = useState(DEVICES[0]);

  const [saving, setSaving] = useState(false);
  const [syncStatus, setSyncStatus] = useState('');
  const [loading, setLoading] = useState(false);

  const [selectedFontName, setSelectedFontName] = useState('');
  const [selectedLayoutName, setSelectedLayoutName] = useState(() => {
    if (initialType === 'theme' || initialType === 'zip' || initialType === 'saved') {
      return initialBase?.name || '';
    }
    return '';
  });
  const [showPicker, setShowPicker] = useState<'font' | 'bg' | 'layout' | null>(null);
  const [resources, setResources] = useState<any>(null);
  const [bgImageObj, setBgImageObj] = useState<HTMLImageElement | null>(null);
  const [fontBase64, setFontBase64] = useState('');
  const [jsonText, setJsonText] = useState('');
  const [showJsonImportModal, setShowJsonImportModal] = useState(false);



  // 预加载背景图为 Image 对象
  useEffect(() => {
    if (config.bgType === 2 && config.bgStr && !isLocalDevicePath(config.bgStr)) {
      const url = config.bgStr.startsWith('blob:') ? config.bgStr : `${window.location.origin}/repo/${config.bgStr.split('/').map(s => encodeURIComponent(s)).join('/')}`;
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => setBgImageObj(img);
      img.src = url;
    } else {
      setBgImageObj(null);
    }
  }, [config.bgStr, config.bgType]);
  const [manualAssets, setManualAssets] = useState(() => ({
    bg: initialType === 'bg',
    font: initialType === 'font'
  }));
  const manualAssetsRef = React.useRef(manualAssets);
  React.useEffect(() => { manualAssetsRef.current = manualAssets; }, [manualAssets]);
  const [activeTab, setActiveTab] = useState<'visual' | 'text' | 'layout' | 'extra'>('visual');

  // 初始化：并行加载资源清单和基础配置
  useEffect(() => {
    let active = true;
    Promise.all([
      api.getResources(),
      loadBaseConfig(initialType, initialBase),
      api.getSystemConfig().catch(() => null)
    ]).then(([res, _base, sysConfig]) => {
      if (!active) return;
      setResources(res);
      
      if (sysConfig && sysConfig.default_page_anim !== undefined) {
        const defaultPageAnim = parseInt(sysConfig.default_page_anim);
        setConfig((prev: any) => {
          if (initialType === 'blank' || prev.pageAnim === undefined) {
            return { ...prev, pageAnim: defaultPageAnim };
          }
          return prev;
        });
      }

      if (initialType === 'theme' || initialType === 'zip') {
        const cat = initialType === 'theme' ? 'themes' : 'zips';
        const found = res[cat]?.find((t: any) => t.path === initialBase.path);
        if (found) setSelectedLayoutName(found.name);
      }
    });
    return () => { active = false; };
  }, [initialBase, initialType]);

  const getAssetName = (path: string, category: string, preferredName?: string) => {
    if (!path) return '默认';
    
    const safeDecode = (str: string) => {
      let current = str;
      try {
        // 最多尝试解码 3 次，防止死循环
        for (let i = 0; i < 3; i++) {
          if (!current.includes('%')) break;
          const next = decodeURIComponent(current);
          if (next === current) break;
          current = next;
        }
      } catch (e) {}
      return current;
    };

    if (path.startsWith('blob:')) {
      const name = preferredName ? safeDecode(preferredName) : '本地资源';
      return (name.split('/').pop() || name) + ' (待上传)';
    }

    const decoded = safeDecode(path);
    const fileName = decoded.split('/').pop() || decoded;
    
    let result = fileName;
    if (resources && resources[category]) {
      const found = resources[category].find((r: any) => r.path === path);
      if (found) result = found.name;
    }
    
    return safeDecode(result);
  };

  const handleImportJson = () => {
    if (!jsonText.trim()) {
      alert('请输入有效的 JSON 配置文本');
      return;
    }

    try {
      let cleanText = jsonText.trim();
      // Remove possible markdown code block wrappers
      if (cleanText.startsWith('```')) {
        cleanText = cleanText.replace(/^```(json)?\n/, '').replace(/\n```$/, '');
      }

      const parsed = JSON.parse(cleanText);
      if (!parsed || typeof parsed !== 'object') {
        throw new Error('解析结果不是有效的 JSON 对象');
      }

      // Merge config
      setConfig(prev => {
        const next = { ...prev, ...parsed };
        if (parsed.bgStr) {
          next.bgStr = parsed.bgStr;
          next.bgType = parsed.bgType !== undefined ? parsed.bgType : 2;
        }
        return next;
      });

      alert(`导入成功！已成功载入您粘贴的排版参数。`);
      setShowJsonImportModal(false);
      setJsonText('');
    } catch (e) {
      alert(`解析失败: ${e instanceof Error ? e.message : '请检查 JSON 格式是否正确'}`);
    }
  };

  const loadBaseConfig = async (type: string, base: any) => {
    if (type === 'blank') {
      return;
    }
    if (type === 'saved') {
      const data = typeof base.config === 'string' ? JSON.parse(base.config) : base.config;
      setConfig(prev => ({ ...DEFAULT_CONFIG, ...data, id: base.id }));
      if (data.textFont) {
        let decoded = data.textFont;
        try { decoded = decodeURIComponent(data.textFont); } catch(e){}
        const decodedFont = decoded.split('/').pop() || '';
        
        if (isLocalDevicePath(data.textFont)) {
          // 👑 优先在云端查找匹配的同名或同路径字体资源并加载
          api.getResources().then(res => {
            const foundFont = res.fonts?.find((f: any) => {
              const fDecoded = decodeURIComponent(f.path).split('/').pop();
              return fDecoded === decodedFont || f.path === data.textFont;
            });
            if (foundFont) {
              loadFont(foundFont.path, foundFont.name);
            }
          });
        } else {
          loadFont(data.textFont, decodedFont || 'CustomFont');
        }
      }
      return;
    }
    if (type === 'bg') {
      setConfig(prev => ({ ...prev, bgStr: base.path, bgType: 2 }));
      setManualAssets(p => ({ ...p, bg: true }));
      return;
    }
    if (type === 'theme') {
      setLoading(true);
      fetch(`${window.location.origin}/repo/${base.path}`)
        .then(async res => {
          if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
          const text = await res.text();
          try {
            return JSON.parse(text);
          } catch (e) {
            console.error('Failed to parse JSON', text.slice(0, 100));
            throw new Error('所选资源不是有效的 JSON 格式');
          }
        })
        .then(data => {
          setConfig(prev => {
            const next = { ...prev, ...data };
            if (manualAssetsRef.current.bg) {
              next.bgStr = prev.bgStr;
              next.bgType = prev.bgType;
            }
            if (manualAssetsRef.current.font) {
              next.textFont = prev.textFont;
            }
            return next;
          });

          // 自动加载排版指定的字体
          if (data.textFont && !manualAssetsRef.current.font) {
            // 尝试在资源中找这个字体 (处理编码过的路径)
            const decodedFont = decodeURIComponent(data.textFont).split('/').pop() || '';
            api.getResources().then(res => {
              const foundFont = res.fonts?.find((f: any) => {
                return f.name === decodedFont || decodeURIComponent(f.path).split('/').pop() === decodedFont || f.path === data.textFont;
              });
              if (foundFont) {
                loadFont(foundFont.path, foundFont.name);
              }
            });
          }
        })
        .catch(err => {
          console.error('Theme load failed', err);
          alert('加载失败: ' + err.message);
        })
        .finally(() => setLoading(false));
    } else if (type === 'font') {
      loadFont(base.path, base.name);
      setManualAssets(p => ({ ...p, font: true }));
    } else if (type === 'zip') {
      setLoading(true);
      fetch(`${window.location.origin}/repo/${base.path}`)
        .then(res => res.arrayBuffer())
        .then(async buf => {
          let f = (window as any).fflate;
          if (!f) {
            // @ts-ignore
            const mod = await import('https://cdn.skypack.dev/fflate');
            f = mod;
             (window as any).fflate = f;
          }
          if (f) {
            const unzipped = f.unzipSync(new Uint8Array(buf));
            const configFile = Object.keys(unzipped).find(k => k.endsWith('readConfig.json'));
            if (configFile) {
              const str = new TextDecoder().decode(unzipped[configFile]);
                try {
                  const data = JSON.parse(str);
                  if (data && typeof data === 'object') {
                    setConfig(prev => {
                      const next = { ...prev, ...data };
                      if (manualAssetsRef.current.bg) {
                        next.bgStr = prev.bgStr;
                        next.bgType = prev.bgType;
                      }
                      if (manualAssetsRef.current.font) {
                        next.textFont = prev.textFont;
                      }
                      return next;
                    });
                    
                    const decodedTextFont = data.textFont ? decodeURIComponent(data.textFont).split('/').pop() : '';
                    const decodedBgStr = data.bgStr ? decodeURIComponent(data.bgStr).split('/').pop() : '';

                    // 处理 ZIP 内的字体
                    if (data.textFont && !manualAssetsRef.current.font) {
                      const fontFile = Object.keys(unzipped).find(k => {
                        const kDecoded = decodeURIComponent(k).split('/').pop();
                        return kDecoded === decodedTextFont || k.includes(decodedTextFont);
                      });
                      
                      if (fontFile) {
                        const fileName = decodeURIComponent(fontFile.split('/').pop() || '');
                        api.getResources().then(res => {
                          const cloudMatch = res.fonts?.find((f: any) => {
                            return f.name === fileName || decodeURIComponent(f.path).split('/').pop() === fileName;
                          });

                          if (cloudMatch) {
                            loadFont(cloudMatch.path, cloudMatch.name);
                          } else {
                            const fontBlob = new Blob([unzipped[fontFile]]);
                            const fontUrl = URL.createObjectURL(fontBlob);
                            const fontName = 'ZipFont_' + Math.random().toString(36).substring(7);
                            const fontFace = new FontFace(fontName, `url(${fontUrl})`);
                            fontFace.load().then(f => {
                              (document.fonts as any).add(f);
                              setSelectedFontName(fontName);
                              setConfig((prev: any) => ({ 
                                ...prev, 
                                textFont: fontUrl,
                                _textFontName: fileName,
                                _textFontSourceZip: base.path,
                                _textFontSourceFile: fontFile
                              }));
                            });
                          }
                        });
                      }
                    }

                    // 处理 ZIP 内的背景图
                    if (data.bgStr && (data.bgType === 1 || data.bgType === 2) && !manualAssetsRef.current.bg) {
                      const bgFile = Object.keys(unzipped).find(k => {
                        const kDecoded = decodeURIComponent(k).split('/').pop();
                        return kDecoded === decodedBgStr || k.includes(decodedBgStr);
                      });
                      if (bgFile) {
                        const fileName = decodeURIComponent(bgFile.split('/').pop() || '');
                        api.getResources().then(res => {
                          const cloudMatch = res.backgrounds?.find((b: any) => {
                            return b.name === fileName || decodeURIComponent(b.path).split('/').pop() === fileName;
                          });

                          if (cloudMatch) {
                            setConfig(prev => ({ ...prev, bgStr: cloudMatch.path, bgType: 2 }));
                          } else {
                            const bgBlob = new Blob([unzipped[bgFile]]);
                            const bgUrl = URL.createObjectURL(bgBlob);
                            setConfig(prev => ({ 
                              ...prev, 
                              bgStr: bgUrl, 
                              bgType: 2, 
                              _bgStrName: fileName,
                              _bgStrSourceZip: base.path,
                              _bgStrSourceFile: bgFile
                            }));
                          }
                        });
                      }
                    }
                  }
                } catch (e) {
                  console.warn('Skipping invalid config file in ZIP:', configFile);
                }
            }
          }
        })
        .finally(() => setLoading(false));
    }
  };

  const loadFont = async (path: string, name: string) => {
    if (!path || isLocalDevicePath(path)) return;
    const isBlob = path.startsWith('blob:');
    const fontUrl = isBlob ? path : `${window.location.origin}/repo/${path}`;

    // 用文件名（去掉扩展名）作为稳定字体名
    const rawName = (name || path.split('/').pop() || 'CustomFont').replace(/\.[^.]+$/, '');
    const fontName = rawName;

    // 去重：若同名字体已注册且已加载，直接使用，不重复加载
    const existing = [...(document.fonts as any)].find((f: any) => f.family === fontName && f.status === 'loaded');
    if (existing) {
      console.log(`[loadFont] 字体已存在，直接复用: "${fontName}"`);
      setSelectedFontName(fontName);
      
      // 👑 修正：即使字体已加载，也必须同步更新配置中的 textFont，确保渲染器能感知并应用该字体
      setConfig(prev => {
        const next = { ...prev, textFont: path };
        if (isBlob) next._textFontName = name;
        return next;
      });

      // 预加载字体为 Base64 以供截图使用
      fetch(fontUrl).then(r => r.blob()).then(blob => {
        const reader = new FileReader();
        reader.onloadend = () => setFontBase64(reader.result as string);
        reader.readAsDataURL(blob);
      }).catch(err => {
        console.warn('Failed to fetch existing font blob for base64:', err);
      });

      return;
    }

    try {
      const fontFace = new FontFace(fontName, `url(${fontUrl})`);
      const loaded = await fontFace.load();
      (document.fonts as any).add(loaded);

      // 注入 @font-face CSS，确保 document.fonts.load() 的字体名能被正确识别
      const styleId = `ff-${fontName.replace(/\s/g, '-')}`;
      if (!document.getElementById(styleId)) {
        const style = document.createElement('style');
        style.id = styleId;
        style.textContent = `@font-face { font-family: '${fontName}'; src: url('${fontUrl}') format('truetype'); }`;
        document.head.appendChild(style);
      }

      setSelectedFontName(fontName);
      
      // 预加载字体为 Base64 以供截图使用
      fetch(fontUrl).then(r => r.blob()).then(blob => {
        const reader = new FileReader();
        reader.onloadend = () => setFontBase64(reader.result as string);
        reader.readAsDataURL(blob);
      });

      setConfig(prev => {
        const next = { ...prev, textFont: path };
        if (isBlob) next._textFontName = name;
        return next;
      });
    } catch (e) {
      console.error('Font load failed', e);
    }
  };

  const generateThumbnail = async (
    cfg: any,
  ): Promise<string> => {
    const canvas = document.createElement('canvas');
    const pixelRatio = 3; 
    canvas.width = device.width * pixelRatio;
    canvas.height = device.height * pixelRatio;
    
    const renderer = new LegadoRenderer(canvas);
    renderer.scale = pixelRatio;

    await renderer.renderTheme(cfg, {
      bgImage: bgImageObj,
      getTipText,
      PREVIEW_TITLE,
      PREVIEW_PARAS
    });

    return renderer.getThumbnail();
  };

  const handleSave = async () => {
    if (!config.name) return alert('请输入名称');
    setSaving(true);
    setSyncStatus('准备同步...');
    try {
      const finalConfig = { ...config };
      
      // 检查并同步临时资源 (来自 ZIP 的 blob: 或后端提取)
      const syncAsset = async (path: string, category: 'fonts' | 'bg', preferredName?: string, sourceZip?: string, sourceFile?: string) => {
        if (!path) return path;

        // 优先尝试服务器端转存 (不经历浏览器上传)
        if (sourceZip && sourceFile) {
          try {
            setSyncStatus(`正在从 ZIP 转存${category === 'fonts' ? '字体' : '背景'}: ${preferredName || sourceFile}...`);
            const res = await api.extractAssetFromZip(sourceZip, sourceFile, category);
            return res.path;
          } catch (e) {
            console.error(`ZIP extraction failed, falling back to upload:`, e);
          }
        }

        if (!path.startsWith('blob:')) return path;
        try {
          const decodedName = preferredName ? decodeURIComponent(decodeURIComponent(preferredName)).split('/').pop() : 'asset';
          setSyncStatus(`正在上传${category === 'fonts' ? '字体' : '背景'}: ${decodedName}...`);
          
          const res = await fetch(path);
          const blob = await res.blob();
          const name = preferredName || `${category}_${Date.now()}.${category === 'fonts' ? 'ttf' : 'jpg'}`;
          return await api.ensureAsset(blob, category, name);
        } catch (e) {
          console.error(`Failed to sync ${category} asset:`, e);
          return path;
        }
      };

      if (finalConfig.textFont) {
        finalConfig.textFont = await syncAsset(
          finalConfig.textFont, 'fonts', finalConfig._textFontName, 
          finalConfig._textFontSourceZip, finalConfig._textFontSourceFile
        );
      }
      if (finalConfig.bgType === 2 && finalConfig.bgStr) {
        finalConfig.bgStr = await syncAsset(
          finalConfig.bgStr, 'bg', finalConfig._bgStrName,
          finalConfig._bgStrSourceZip, finalConfig._bgStrSourceFile
        );
      }

      setSyncStatus('正在生成高保真预览图...');
      let previewUrl = '';
      try {
        previewUrl = await generateThumbnail(finalConfig);
        console.log('Thumbnail generated via Canvas Engine, length:', previewUrl?.length);
      } catch (err) {
        console.error('Thumbnail generation failed, skipping', err);
        setSyncStatus('缩略图生成失败，已跳过');
      }

      setSyncStatus('正在保存主题配置...');
      // 👑 修正：清理配置中的冗余预览字段，避免 JSON 嵌套过深
      const configToSave = { ...finalConfig };
      delete (configToSave as any).preview_url;
      
      const payload: any = { 
        name: finalConfig.name, 
        config: JSON.stringify({ ...configToSave, themeName: finalConfig.name, preview_url: previewUrl }),
        preview_url: previewUrl 
      };
      
      if (initialType === 'saved') payload.id = initialBase.id;
      
      console.log(`[Save] Payload Size: ${(JSON.stringify(payload).length / 1024).toFixed(2)} KB`);
      await api.saveCustomTheme(payload);
      setSyncStatus('同步完成！');
      alert(initialType === 'saved' ? '已更新主题' : '已保存到云端精选');
      onSaved();
      onClose();
    } catch (e) {
      alert('保存失败: ' + String(e));
    } finally {
      setSaving(false);
      setSyncStatus('');
    }
  };

  return (
    <motion.div 
      initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
      className="bg-surface-container-highest border border-outline-variant w-full max-w-6xl rounded-2xl shadow-2xl overflow-hidden flex flex-col md:flex-row h-[85vh] relative"
    >
      {/* 左侧预览 */}
      <div className="flex-1 bg-surface-container-lowest p-6 flex flex-col items-center justify-center min-h-0 relative">
        <div className="absolute top-6 left-6 flex items-center gap-3"><Zap className="text-primary" size={20} /><h3 className="font-bold text-lg text-primary">样式实验室</h3></div>
        

        <div className="absolute bottom-6 right-6 bg-surface-container px-3 py-1 rounded-full text-[10px] font-bold text-secondary uppercase tracking-widest flex items-center gap-2 z-10 border border-outline-variant/30">
          <div className="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse"></div>
          {device.name} ({device.ratio})
        </div>
        
        <div 
          className="relative bg-[#0c0c0c] shadow-[0_0_0_1px_rgba(255,255,255,0.1),0_30px_60px_rgba(0,0,0,0.5)] border-[6px] border-[#222222] overflow-hidden flex flex-col transition-all duration-500 ease-in-out origin-center"
          style={{ 
            width: `${device.width}px`, 
            height: `${device.height}px`, 
            borderRadius: `${device.radius}px`,
            padding: `${device.bezel * 4}px`,
            transform: `scale(${device.width > 400 ? 0.8 : 0.88})` 
          }}
        >
          <div className="w-full h-full relative overflow-hidden flex flex-col bg-black">
            {/* 模拟刘海/挖孔 */}
            {device.notch === 'hole' && <div className="absolute top-3 left-1/2 -translate-x-1/2 w-3.5 h-3.5 bg-black rounded-full z-20 shadow-inner border border-white/5"></div>}
            {device.notch === 'island' && <div className="absolute top-3 left-1/2 -translate-x-1/2 w-24 h-6 bg-black rounded-full z-20 shadow-inner border border-white/5"></div>}
          
            <div className="flex-1 relative flex flex-col overflow-hidden" style={{ borderRadius: `${device.innerRadius}px` }}>
              <CanvasPreview 
                config={config} 
                device={device} 
                fontFamily={selectedFontName} 
                bgImage={bgImageObj} 
                loading={loading}
              />
            </div>
          </div>
        </div>
      </div>

      {/* 右侧控制面板 */}
      <div className="w-full md:w-[400px] bg-surface-container-high border-l border-outline-variant flex flex-col shrink-0 relative overflow-hidden">
        {/* 顶部标签栏 */}
        <div className="absolute top-0 left-0 right-0 h-16 bg-surface-container-high border-b border-outline-variant flex items-center px-4 gap-1 z-20">
          {[
            { id: 'visual', icon: <Palette size={16} />, label: '视觉' },
            { id: 'text', icon: <Type size={16} />, label: '文字' },
            { id: 'layout', icon: <Layout size={16} />, label: '布局' },
            { id: 'extra', icon: <Settings2 size={16} />, label: '组件' },
          ].map(tab => (
            <button 
              key={tab.id} 
              onClick={() => setActiveTab(tab.id as any)}
              className={`flex-1 flex flex-col items-center justify-center gap-1 py-2 rounded-xl transition-all ${activeTab === tab.id ? 'bg-primary text-white shadow-md' : 'text-secondary hover:bg-surface-container'}`}
            >
              {tab.icon}
              <span className="text-[10px] font-bold">{tab.label}</span>
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto custom-scrollbar p-6 pt-20 pb-24 space-y-8">
          {activeTab === 'visual' && (
            <div className="space-y-6 animate-in fade-in slide-in-from-right-4 duration-300">
              <div className="space-y-3">
                <label className="text-[10px] font-bold text-outline uppercase tracking-wider">主题信息与导入</label>
                <div className="bg-surface-container-lowest p-4 rounded-2xl border border-outline-variant space-y-4">
                  <div className="space-y-1.5">
                    <span className="text-[10px] text-secondary">名称</span>
                    <input type="text" value={config.name} onChange={(e) => setConfig({...config, name: e.target.value})} className="w-full bg-surface-container border border-outline-variant rounded-xl px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/20" />
                  </div>
                  <button onClick={() => setShowJsonImportModal(true)} className="w-full py-2.5 bg-primary/10 text-primary border border-primary/20 hover:bg-primary/20 rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-2">
                    <FileText size={14} />
                    <span>粘贴 Legado JSON 配置</span>
                  </button>
                </div>
              </div>

              <div className="space-y-3">
                <label className="text-[10px] font-bold text-outline uppercase tracking-wider">色彩与资源</label>
                <div className="bg-surface-container-lowest p-4 rounded-2xl border border-outline-variant space-y-4">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5"><span className="text-[10px] text-secondary">背景色</span><input type="color" value={getHex6(config.bgStr)} onChange={(e) => { setConfig({...config, bgStr: cssToArgb(e.target.value), bgType: 0}); setManualAssets(p => ({ ...p, bg: true })); }} className="w-full h-10 rounded-xl cursor-pointer p-1 bg-surface-container" /></div>
                    <div className="space-y-1.5"><span className="text-[10px] text-secondary">文字色</span><input type="color" value={getHex6(config.textColor)} onChange={(e) => setConfig({...config, textColor: cssToArgb(e.target.value)})} className="w-full h-10 rounded-xl cursor-pointer p-1 bg-surface-container" /></div>
                  </div>
                  <div className="flex flex-col gap-3 pt-2">
                    <button onClick={() => setShowPicker('layout')} className="flex items-center gap-4 p-4 bg-surface-container rounded-2xl text-sm font-bold text-primary hover:bg-primary/10 border border-primary/20 transition-all group">
                      <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center group-hover:scale-110 transition-transform">
                        <AlignLeft size={20} />
                      </div>
                      <div className="flex-1 text-left">
                        <div className="text-[10px] text-secondary opacity-60 uppercase tracking-tighter mb-0.5">排版布局</div>
                        <div className="truncate">{selectedLayoutName || '默认'}</div>
                      </div>
                      <ChevronRight size={16} className="text-outline opacity-40" />
                    </button>

                    <button onClick={() => setShowPicker('bg')} className="flex items-center gap-4 p-4 bg-surface-container rounded-2xl text-sm font-bold text-primary hover:bg-primary/10 border border-primary/20 transition-all group">
                      <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center group-hover:scale-110 transition-transform">
                        <ImageIcon size={20} />
                      </div>
                      <div className="flex-1 text-left">
                        <div className="text-[10px] text-secondary opacity-60 uppercase tracking-tighter mb-0.5">背景资源</div>
                        <div className="truncate">
                          {config.bgType === 0 ? '纯色' : getAssetName(config.bgStr, 'backgrounds', config._bgStrName)}
                        </div>
                      </div>
                      <ChevronRight size={16} className="text-outline opacity-40" />
                    </button>

                    <button onClick={() => setShowPicker('font')} className="flex items-center gap-4 p-4 bg-surface-container rounded-2xl text-sm font-bold text-primary hover:bg-primary/10 border border-primary/20 transition-all group">
                      <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center group-hover:scale-110 transition-transform">
                        <FontIcon size={20} />
                      </div>
                      <div className="flex-1 text-left">
                        <div className="text-[10px] text-secondary opacity-60 uppercase tracking-tighter mb-0.5">字体资源</div>
                        <div className="truncate">{getAssetName(config.textFont, 'fonts', config._textFontName)}</div>
                      </div>
                      <ChevronRight size={16} className="text-outline opacity-40" />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'text' && (
            <div className="space-y-6 animate-in fade-in slide-in-from-right-4 duration-300">
              <div className="space-y-3">
                <label className="text-[10px] font-bold text-outline uppercase tracking-wider">核心参数</label>
                <div className="bg-surface-container-lowest p-4 rounded-2xl border border-outline-variant space-y-6">
                  <Slider label="字号" value={config.textSize} min={12} max={40} unit="sp" onChange={v => setConfig({...config, textSize: v})} />
                  <Slider label="行间距" value={config.lineSpacingExtra} min={10} max={50} step={1} displayValue={v => ((v - 10) / 10).toFixed(1)} onChange={v => setConfig({...config, lineSpacingExtra: v})} />
                  <Slider label="字距" value={config.letterSpacing} min={0} max={1} step={0.01} onChange={v => setConfig({...config, letterSpacing: v})} />
                  <Slider label="段距" value={config.paragraphSpacing} min={0} max={50} step={1} displayValue={v => (v / 10).toFixed(1)} onChange={v => setConfig({...config, paragraphSpacing: v})} />
                </div>
              </div>
              <div className="space-y-3">
                <label className="text-[10px] font-bold text-outline uppercase tracking-wider">排版习惯</label>
                <div className="bg-surface-container-lowest p-4 rounded-2xl border border-outline-variant space-y-4">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-secondary">文字加粗</span>
                    <button onClick={() => setConfig({...config, textBold: config.textBold ? 0 : 1})} className={`w-10 h-5 rounded-full transition-all relative ${config.textBold ? 'bg-primary' : 'bg-outline-variant'}`}><div className={`absolute top-1 w-3 h-3 bg-white rounded-full transition-all ${config.textBold ? 'left-6' : 'left-1'}`}></div></button>
                  </div>
                  <div className="space-y-2">
                    <span className="text-[10px] text-outline font-bold uppercase">首行缩进</span>
                    <select value={config.paragraphIndent} onChange={e => setConfig({...config, paragraphIndent: e.target.value})} className="w-full bg-surface-container border border-outline-variant rounded-xl px-3 py-2 text-xs outline-none">
                      <option value="">无缩进</option><option value="　">1字符</option><option value="　　">2字符</option><option value="　　　　">4字符</option>
                    </select>
                  </div>
                  <div className="space-y-2">
                    <span className="text-[10px] text-outline font-bold uppercase">翻页方式</span>
                    <select value={config.pageAnim !== undefined ? config.pageAnim : 2} onChange={e => setConfig({...config, pageAnim: parseInt(e.target.value)})} className="w-full bg-surface-container border border-outline-variant rounded-xl px-3 py-2 text-xs outline-none">
                      <option value={0}>覆盖</option>
                      <option value={1}>滑动</option>
                      <option value={2}>仿真</option>
                      <option value={3}>滚动</option>
                      <option value={4}>无动画</option>
                    </select>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'layout' && (
            <div className="space-y-6 animate-in fade-in slide-in-from-right-4 duration-300">
              <div className="space-y-3">
                <label className="text-[10px] font-bold text-outline uppercase tracking-wider">物理环境</label>
                <div className="bg-surface-container-lowest p-4 rounded-2xl border border-outline-variant">
                  <div className="grid grid-cols-2 gap-2">
                    {DEVICES.map(d => (
                      <button key={d.id} onClick={() => setDevice(d)} className={`py-3 px-1 rounded-xl text-[10px] font-bold transition-all border ${device.id === d.id ? 'bg-primary text-white border-primary shadow-sm' : 'bg-surface-container text-secondary border-outline-variant hover:bg-surface-container'}`}>
                        {d.name}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <div className="space-y-3">
                <label className="text-[10px] font-bold text-outline uppercase tracking-wider">全局边距</label>
                <div className="bg-surface-container-lowest p-4 rounded-2xl border border-outline-variant space-y-6">
                  <div className="grid grid-cols-2 gap-x-6 gap-y-4">
                    <Slider label="左" value={config.paddingLeft} min={0} max={100} unit="dp" onChange={v => setConfig({...config, paddingLeft: v})} />
                    <Slider label="右" value={config.paddingRight} min={0} max={100} unit="dp" onChange={v => setConfig({...config, paddingRight: v})} />
                    <Slider label="上" value={config.paddingTop} min={0} max={100} unit="dp" onChange={v => setConfig({...config, paddingTop: v})} />
                    <Slider label="下" value={config.paddingBottom} min={0} max={100} unit="dp" onChange={v => setConfig({...config, paddingBottom: v})} />
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'extra' && (
            <div className="space-y-6 animate-in fade-in slide-in-from-right-4 duration-300">
              <div className="space-y-3">
                <label className="text-[10px] font-bold text-outline uppercase tracking-wider">标题风格</label>
                <div className="bg-surface-container-lowest p-4 rounded-2xl border border-outline-variant space-y-6">
                  <div className="flex bg-surface-container p-1 rounded-xl gap-1">
                    {['居左', '居中', '隐藏'].map((l, i) => <button key={i} onClick={() => setConfig({...config, titleMode: i})} className={`flex-1 py-2 rounded-lg text-[10px] font-bold transition-all ${config.titleMode === i ? 'bg-primary text-white shadow-sm' : 'text-secondary'}`}>{l}</button>)}
                  </div>
                  {config.titleMode !== 2 && (
                    <>
                      <Slider label="缩放系数" value={config.titleSize} min={0} max={10} onChange={v => setConfig({...config, titleSize: v})} />
                      <div className="grid grid-cols-2 gap-4">
                        <Slider label="上间距" value={config.titleTopSpacing} min={0} max={100} unit="dp" onChange={v => setConfig({...config, titleTopSpacing: v})} />
                        <Slider label="下间距" value={config.titleBottomSpacing} min={0} max={100} unit="dp" onChange={v => setConfig({...config, titleBottomSpacing: v})} />
                      </div>
                    </>
                  )}
                </div>
              </div>

              <div className="space-y-3">
                <label className="text-[10px] font-bold text-outline uppercase tracking-wider">状态信息栏 (页眉页脚)</label>
                <div className="bg-surface-container-lowest p-4 rounded-2xl border border-outline-variant space-y-6">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <span className="text-[10px] text-secondary font-bold uppercase">页眉显示</span>
                      <div className="flex bg-surface-container p-1 rounded-lg gap-1">{['开', '关'].map((l, i) => <button key={i} onClick={() => setConfig({...config, headerMode: i === 0 ? 1 : 2})} className={`flex-1 py-1 rounded-md text-[9px] font-bold transition-all ${config.headerMode === (i === 0 ? 1 : 2) ? 'bg-primary text-white shadow-sm' : 'text-secondary'}`}>{l}</button>)}</div>
                    </div>
                    <div className="space-y-2">
                      <span className="text-[10px] text-secondary font-bold uppercase">页脚显示</span>
                      <div className="flex bg-surface-container p-1 rounded-lg gap-1">{['开', '关'].map((l, i) => <button key={i} onClick={() => setConfig({...config, footerMode: i === 0 ? 0 : 1})} className={`flex-1 py-1 rounded-md text-[9px] font-bold transition-all ${config.footerMode === (i === 0 ? 0 : 1) ? 'bg-primary text-white shadow-sm' : 'text-secondary'}`}>{l}</button>)}</div>
                    </div>
                  </div>
                  
                  <div className="grid grid-cols-2 gap-x-4 gap-y-6">
                    <Slider label="页眉上" value={config.headerPaddingTop} min={0} max={100} unit="dp" onChange={v => setConfig({...config, headerPaddingTop: v})} />
                    <Slider label="页眉下" value={config.headerPaddingBottom} min={0} max={100} unit="dp" onChange={v => setConfig({...config, headerPaddingBottom: v})} />
                    <Slider label="页脚上" value={config.footerPaddingTop} min={0} max={100} unit="dp" onChange={v => setConfig({...config, footerPaddingTop: v})} />
                    <Slider label="页脚下" value={config.footerPaddingBottom} min={0} max={100} unit="dp" onChange={v => setConfig({...config, footerPaddingBottom: v})} />
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="flex items-center justify-between p-2.5 bg-surface-container rounded-xl">
                      <span className="text-[10px] font-bold uppercase">页眉线</span>
                      <button onClick={() => setConfig({...config, showHeaderLine: !config.showHeaderLine})} className={`w-8 h-4 rounded-full transition-all relative ${config.showHeaderLine ? 'bg-primary' : 'bg-outline-variant'}`}><div className={`absolute top-0.5 w-3 h-3 bg-white rounded-full transition-all ${config.showHeaderLine ? 'left-4.5' : 'left-0.5'}`}></div></button>
                    </div>
                    <div className="flex items-center justify-between p-2.5 bg-surface-container rounded-xl">
                      <span className="text-[10px] font-bold uppercase">页脚线</span>
                      <button onClick={() => setConfig({...config, showFooterLine: !config.showFooterLine})} className={`w-8 h-4 rounded-full transition-all relative ${config.showFooterLine ? 'bg-primary' : 'bg-outline-variant'}`}><div className={`absolute top-0.5 w-3 h-3 bg-white rounded-full transition-all ${config.showFooterLine ? 'left-4.5' : 'left-0.5'}`}></div></button>
                    </div>
                  </div>

                  <div className="space-y-5 pt-2 border-t border-outline-variant/30">
                    <div className="flex items-center justify-between">
                       <span className="text-[10px] font-bold uppercase text-secondary">提示色</span>
                       <input type="color" value={getHex6(config.tipColor || '#80000000')} onChange={(e) => setConfig({...config, tipColor: cssToArgb(e.target.value)})} className="w-10 h-6 rounded cursor-pointer" />
                    </div>
                    <div className="space-y-4">
                      <span className="text-[10px] text-secondary font-bold uppercase tracking-widest block text-center">页眉内容</span>
                      <div className="grid grid-cols-3 gap-2">
                        <TipSelector label="左" value={config.tipHeaderLeft} onChange={v => setConfig({...config, tipHeaderLeft: v})} />
                        <TipSelector label="中" value={config.tipHeaderMiddle} onChange={v => setConfig({...config, tipHeaderMiddle: v})} />
                        <TipSelector label="右" value={config.tipHeaderRight} onChange={v => setConfig({...config, tipHeaderRight: v})} />
                      </div>
                    </div>
                    <div className="space-y-4">
                      <span className="text-[10px] text-secondary font-bold uppercase tracking-widest block text-center">页脚内容</span>
                      <div className="grid grid-cols-3 gap-2">
                        <TipSelector label="左" value={config.tipFooterLeft} onChange={v => setConfig({...config, tipFooterLeft: v})} />
                        <TipSelector label="中" value={config.tipFooterMiddle} onChange={v => setConfig({...config, tipFooterMiddle: v})} />
                        <TipSelector label="右" value={config.tipFooterRight} onChange={v => setConfig({...config, tipFooterRight: v})} />
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="space-y-3">
                <label className="text-[10px] font-bold text-outline uppercase tracking-wider">系统 UI (状态栏/导航栏)</label>
                <div className="bg-surface-container-lowest p-4 rounded-2xl border border-outline-variant space-y-6">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="flex items-center justify-between p-2.5 bg-surface-container rounded-xl">
                      <span className="text-[10px] font-bold uppercase">隐藏状态栏</span>
                      <button onClick={() => setConfig({...config, hideStatusBar: !config.hideStatusBar})} className={`w-8 h-4 rounded-full transition-all relative ${config.hideStatusBar ? 'bg-primary' : 'bg-outline-variant'}`}><div className={`absolute top-0.5 w-3 h-3 bg-white rounded-full transition-all ${config.hideStatusBar ? 'left-4.5' : 'left-0.5'}`}></div></button>
                    </div>
                    <div className="flex items-center justify-between p-2.5 bg-surface-container rounded-xl">
                      <span className="text-[10px] font-bold uppercase">隐藏导航栏</span>
                      <button onClick={() => setConfig({...config, hideNavigationBar: !config.hideNavigationBar})} className={`w-8 h-4 rounded-full transition-all relative ${config.hideNavigationBar ? 'bg-primary' : 'bg-outline-variant'}`}><div className={`absolute top-0.5 w-3 h-3 bg-white rounded-full transition-all ${config.hideNavigationBar ? 'left-4.5' : 'left-0.5'}`}></div></button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
        <div className="absolute bottom-0 left-0 right-0 p-4 bg-surface-container-high border-t border-outline-variant flex items-center gap-3 z-20 backdrop-blur-md">
          <button onClick={onClose} className="flex-1 px-4 py-2.5 bg-surface-container/50 rounded-xl text-secondary text-sm font-bold shadow-sm hover:bg-surface-container transition-all border border-outline-variant/30">取消</button>
          <button onClick={handleSave} disabled={saving} className="flex-2 px-6 py-2.5 bg-primary text-on-primary rounded-xl text-sm font-bold shadow-lg hover:shadow-primary/30 transition-all flex items-center justify-center gap-2 relative overflow-hidden group">
            {saving ? (
              <>
                <RefreshCw size={16} className="animate-spin" />
                <span className="animate-pulse">{syncStatus || '正在处理...'}</span>
              </>
            ) : (
              <>
                <Share2 size={16} className="group-hover:scale-110 transition-transform" />
                <span>保存并同步</span>
              </>
            )}
          </button>
        </div>
      </div>

      {showPicker && (
        <div 
          onClick={(e) => e.target === e.currentTarget && setShowPicker(null)}
          className="absolute inset-0 z-100 bg-on-background/20 backdrop-blur-sm flex items-center justify-end"
        >
          <motion.div initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }} className="w-full md:w-[500px] h-full bg-surface shadow-2xl border-l border-outline-variant flex flex-col">
            <AssetPicker type={showPicker} fileTree={fileTree} onSelect={(r: any) => {
                if (showPicker === 'font') { 
                  loadFont(r.path, r.name); 
                  setManualAssets(p => ({ ...p, font: true })); 
                }
                else if (showPicker === 'bg') { 
                  if (r.path.endsWith('.zip') || r.path.endsWith('.json')) {
                    loadBaseConfig(r.path.endsWith('.zip') ? 'zip' : 'theme', r);
                  } else {
                    const isBlob = r.path.startsWith('blob:');
                    setConfig(prev => {
                      const next = { ...prev, bgStr: r.path, bgType: 2 };
                      if (isBlob) next._bgStrName = r.name;
                      return next;
                    });
                    setManualAssets(p => ({ ...p, bg: true })); 
                  }
                }
                else if (showPicker === 'layout') { 
                  loadBaseConfig(r.path.endsWith('.zip') ? 'zip' : 'theme', r); 
                  setSelectedLayoutName(r.name);
                }
                setShowPicker(null);
            }} onClose={() => setShowPicker(null)} />
          </motion.div>
        </div>
      )}

      {showJsonImportModal && (
        <div className="absolute inset-0 z-150 bg-black/60 backdrop-blur-md flex items-center justify-center p-6">
          <div className="bg-surface border border-outline-variant rounded-3xl p-6 w-full max-w-lg shadow-2xl animate-in zoom-in-95 duration-200 flex flex-col gap-4 text-on-surface">
            <div className="flex items-center justify-between">
              <h5 className="text-sm font-bold flex items-center gap-2 text-primary">
                <FileText size={18} />
                导入 Legado 主题配置 JSON
              </h5>
              <button 
                onClick={() => { setShowJsonImportModal(false); setJsonText(''); }}
                className="p-1 hover:bg-surface-container rounded-full text-secondary"
              >
                <X size={18} />
              </button>
            </div>
            
            <p className="text-[10px] text-secondary">
              请将从阅读 (Legado) APP 中导出的主题配置 JSON（例如备份或分享文本）直接粘贴在下方。系统将智能解析并应用全部排版和颜色参数。
            </p>

            <textarea
              value={jsonText}
              onChange={(e) => setJsonText(e.target.value)}
              placeholder='例如：{"textSize":22,"letterSpacing":0.05,"lineSpacingExtra":12,"paragraphSpacing":5,"pageAnim":2,...}'
              className="w-full h-48 bg-surface-container border border-outline-variant rounded-xl p-3 text-xs font-mono outline-none focus:ring-2 focus:ring-primary/20 text-on-surface resize-none"
            />

            <div className="flex gap-3 justify-end pt-2">
              <button 
                onClick={() => { setShowJsonImportModal(false); setJsonText(''); }}
                className="px-4 py-2 bg-surface-container-high hover:bg-surface-container rounded-xl text-xs font-bold text-secondary"
              >
                取消
              </button>
              <button 
                onClick={handleImportJson}
                className="px-6 py-2 bg-primary text-on-primary rounded-xl text-xs font-bold shadow-lg hover:shadow-primary/30 transition-all"
              >
                开始解析导入
              </button>
            </div>
          </div>
        </div>
      )}
    </motion.div>
  );
}
