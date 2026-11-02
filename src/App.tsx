import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  LayoutDashboard,
  ListRestart,
  Settings,
  ChevronRight,
  X,
  ArrowUpRight,
  Search,
  Plus,
  Menu,
  LogOut,
  Sparkles,
  ShieldCheck,
  Package,
  BookOpen,
  List,
  Compass,
  MessageSquare
} from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import * as api from './api';

// Components
import { NavItem } from './components/NavItem';

// Modals
import { AddSubscriptionModal } from './components/modals/AddSubscriptionModal';
import { AddRuleModal } from './components/modals/AddRuleModal';
import { AddTxtTocRuleModal } from './components/modals/AddTxtTocRuleModal';
import { AddDictRuleModal } from './components/modals/AddDictRuleModal';
import JsonImportModal from './components/JsonImportModal';
import { WebDiscoveryModal } from './components/modals/WebDiscoveryModal';

// Views
import LoginView from './views/LoginView';
import DashboardView from './views/DashboardView';
import SubscriptionView from './views/SubscriptionView';
import SourceListView from './views/SourceListView';
import RulesView from './views/RulesView';
import TxtTocRulesView from './views/TxtTocRulesView';
import DictRulesView from './views/DictRulesView';
import ReviewsView from './views/ReviewsView';
import SettingsView from './views/SettingsView';

import AssetsView from './views/AssetsView';

const navigation = [
  { id: 'dashboard', label: '控制台', icon: LayoutDashboard, group: '工作空间' },
  { id: 'subscriptions', label: '订阅管理', icon: ListRestart, group: '工作空间' },
  { id: 'sources', label: '书源管理', icon: ShieldCheck, group: '工作空间' },
  { id: 'rules', label: '替换净化', icon: Sparkles, group: '阅读工具' },
  { id: 'txt-toc-rules', label: '目录规则', icon: List, group: '阅读工具' },
  { id: 'dict-rules', label: '字典规则', icon: Compass, group: '阅读工具' },
  { id: 'reviews', label: '段评', icon: MessageSquare, group: '阅读工具' },
  { id: 'assets', label: '资源管理', icon: Package, group: '管理' },
  { id: 'settings', label: '系统设置', icon: Settings, group: '管理' },
];

export default function App() {
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [activeTab, setActiveTab] = useState('dashboard');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [navigationQuery, setNavigationQuery] = useState('');
  const sidebarRef = React.useRef<HTMLElement>(null);
  const reduceMotion = useReducedMotion();
  const currentPage = navigation.find(item => item.id === activeTab) ?? navigation[0];
  const navigate = (tab: string) => {
    setActiveTab(tab);
    setNavigationQuery('');
    setMobileNavOpen(false);
  };

  useEffect(() => {
    if (!mobileNavOpen) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    sidebarRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMobileNavOpen(false);
      if (event.key !== 'Tab') return;
      const buttons = (Array.from(sidebarRef.current?.querySelectorAll('button:not([disabled])') || []) as HTMLButtonElement[])
        .filter(button => button.getClientRects().length > 0);
      const first = buttons[0], last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first?.focus();
      }
    };
    const media = window.matchMedia('(min-width: 768px)');
    const closeOnDesktop = () => { if (media.matches) setMobileNavOpen(false); };
    media.addEventListener('change', closeOnDesktop);
    document.addEventListener('keydown', handleKey);
    return () => {
      media.removeEventListener('change', closeOnDesktop);
      document.removeEventListener('keydown', handleKey);
      previousFocus?.focus();
    };
  }, [mobileNavOpen]);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [checkingAuth, setCheckingAuth] = useState(true);

  // Modals state
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [isAddRuleModalOpen, setIsAddRuleModalOpen] = useState(false);
  const [editRuleData, setEditRuleData] = useState<any>(null);
  const [isAddTxtTocModalOpen, setIsAddTxtTocModalOpen] = useState(false);
  const [editTxtTocData, setEditTxtTocData] = useState<any>(null);
  const [isAddDictModalOpen, setIsAddDictModalOpen] = useState(false);
  const [editDictData, setEditDictData] = useState<any>(null);
  const [isJsonImportModalOpen, setIsJsonImportModalOpen] = useState(false);
  const [isDiscoveryModalOpen, setIsDiscoveryModalOpen] = useState(false);
  const [versionInfo, setVersionInfo] = useState<any>(null);
  const [isUpdating, setIsUpdating] = useState(false);

  // Global Testing State (Shared for consistency)
  const [testingIds, setTestingIds] = useState<Set<number>>(new Set());
  const [testProgress, setTestProgress] = useState({ current: 0, total: 0 });
  const [isTestingAll, setIsTestingAll] = useState(false);
  const pollingTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollingSessionRef = React.useRef(0);

  useEffect(() => {
    const token = api.getToken();
    if (token) setIsLoggedIn(true);
    setCheckingAuth(false);

    // 监听 401 认证失效事件
    const handleUnauthorized = () => {
      setIsLoggedIn(false);
      setMobileNavOpen(false);
      setActiveTab('dashboard'); // 重置到默认页
    };

    window.addEventListener('unauthorized', handleUnauthorized);

    // 获取版本信息
    api.getSystemVersion().then(setVersionInfo).catch(console.error);

    return () => window.removeEventListener('unauthorized', handleUnauthorized);
  }, []);

  const handleUpdate = async () => {
    if (!versionInfo?.hasUpdate) return;
    if (!confirm(`确定要更新到 v${versionInfo.latest} 吗？系统将在更新后自动重启。`)) return;

    setIsUpdating(true);
    try {
      await api.performUpdate();

      // 开始高可用健康轮询检测重启状态
      let attempts = 0;
      const interval = setInterval(async () => {
        attempts++;
        try {
          const info = await api.getSystemVersion();
          if (info && info.current) {
            clearInterval(interval);
            window.location.reload();
          }
        } catch (e) {
          console.log('正在监测系统重启状态...', attempts);
        }

        if (attempts > 30) { // 最多等待 30 秒
          clearInterval(interval);
          alert('系统重启可能需要较长时间，请稍后手动刷新页面。');
          setIsUpdating(false);
        }
      }, 1000);
    } catch (e) {
      alert('更新失败: ' + String(e));
      setIsUpdating(false);
    }
  };

  const handleLogout = () => {
    api.clearToken();
    setMobileNavOpen(false);
    setIsLoggedIn(false);
  };

  const startPollingProgress = useCallback((onFinished?: () => void) => {
    if (pollingTimerRef.current) clearTimeout(pollingTimerRef.current);
    const session = ++pollingSessionRef.current;
    const poll = async () => {
      try {
        const progress = await api.getTestProgress();
        if (session !== pollingSessionRef.current) return;
        if (progress.running) {
          setIsTestingAll(true);
          setTestProgress({ current: progress.current, total: progress.total });
        } else {
          pollingTimerRef.current = null;
          setIsTestingAll(false);
          setTestProgress({ current: 0, total: 0 });
          if (!progress.status || progress.status === 'completed') await onFinished?.();
          else {
            window.dispatchEvent(new CustomEvent('refresh-data'));
            if (progress.status === 'failed') alert('全库测试失败，已保留现有书源，请重试。');
          }
          return;
        }
      } catch (e) {
        console.error('轮询测试进度失败:', e);
      }
      if (session === pollingSessionRef.current) pollingTimerRef.current = setTimeout(poll, 2000);
    };
    void poll();
  }, []);

  useEffect(() => {
    let active = true;
    if (isLoggedIn) {
      api.getTestProgress().then(progress => {
        if (active && progress.running) {
          setIsTestingAll(true);
          setTestProgress({ current: progress.current, total: progress.total });
          startPollingProgress();
        }
      }).catch(console.error);
    } else {
      if (pollingTimerRef.current) {
        clearTimeout(pollingTimerRef.current);
        pollingTimerRef.current = null;
      }
    }
    return () => {
      active = false;
      ++pollingSessionRef.current;
      if (pollingTimerRef.current) {
        clearTimeout(pollingTimerRef.current);
        pollingTimerRef.current = null;
      }
    };
  }, [isLoggedIn, startPollingProgress]);

  // Test Logic (Shared)
  const handleTest = useCallback(async (ids: number[], onFinished?: () => void, depth: api.SourceCheckDepth = 'search') => {
    setTestingIds(prev => new Set([...prev, ...ids]));

    try {
      await api.testSources(ids, depth);
      await onFinished?.();
    } catch (e) {
      alert('测试失败: ' + String(e));
    } finally {
      setTestingIds(prev => {
        const next = new Set(prev);
        ids.forEach(id => next.delete(id));
        return next;
      });
    }
  }, []);

  const handleTestAll = useCallback(async (onFinished?: () => void, depth: api.SourceCheckDepth = 'search') => {
    if (isTestingAll) {
      if (confirm('确定要停止测试吗？')) {
        try {
          ++pollingSessionRef.current;
          if (pollingTimerRef.current) {
            clearTimeout(pollingTimerRef.current);
            pollingTimerRef.current = null;
          }
          await api.stopTestSources();
          setIsTestingAll(false);
          setTestProgress({ current: 0, total: 0 });
          window.dispatchEvent(new CustomEvent('refresh-data'));
        } catch (e) {
          startPollingProgress();
          alert('中止测试失败: ' + String(e));
        }
      }
      return;
    }

    setIsTestingAll(true);
    setTestProgress({ current: 0, total: 0 });

    try {
      const result = await api.testAllSources(depth);
      if (result.started === false) {
        setIsTestingAll(false);
        setTestProgress({ current: 0, total: 0 });
        return;
      }
      startPollingProgress(onFinished);
    } catch (e) {
      alert('启动后台测试失败: ' + String(e));
      setIsTestingAll(false);
    }
  }, [isTestingAll, startPollingProgress]);

  const renderActiveView = useMemo(() => {
    switch (activeTab) {
      case 'dashboard': return <DashboardView onImport={() => setIsJsonImportModalOpen(true)} onNavigate={navigate} />;
      case 'subscriptions': return (
        <SubscriptionView
          onImport={() => setIsAddModalOpen(true)}
          onExplore={() => setIsDiscoveryModalOpen(true)}
          onJsonImport={() => setIsJsonImportModalOpen(true)}
        />
      );
      case 'sources': return (
        <SourceListView
          onImport={() => setIsJsonImportModalOpen(true)}
          testingIds={testingIds}
          testProgress={testProgress}
          isTestingAll={isTestingAll}
          onTest={handleTest}
          onTestAll={handleTestAll}
        />
      );
      case 'rules': return (
        <RulesView
          onAdd={() => {
            setEditRuleData(null);
            setIsAddRuleModalOpen(true);
          }}
          onEdit={(rule) => {
            setEditRuleData(rule);
            setIsAddRuleModalOpen(true);
          }}
        />
      );
      case 'txt-toc-rules': return (
        <TxtTocRulesView
          onAdd={() => {
            setEditTxtTocData(null);
            setIsAddTxtTocModalOpen(true);
          }}
          onEdit={(rule) => {
            setEditTxtTocData(rule);
            setIsAddTxtTocModalOpen(true);
          }}
        />
      );
      case 'dict-rules': return (
        <DictRulesView
          onAdd={() => {
            setEditDictData(null);
            setIsAddDictModalOpen(true);
          }}
          onEdit={(rule) => {
            setEditDictData(rule);
            setIsAddDictModalOpen(true);
          }}
        />
      );

      case 'reviews': return <ReviewsView />;
      case 'assets': return <AssetsView />;
      case 'settings': return <SettingsView />;
      default: return <DashboardView onImport={() => setIsJsonImportModalOpen(true)} onNavigate={navigate} />;
    }
  }, [activeTab, testingIds, testProgress, isTestingAll, handleTest, handleTestAll]);

  if (checkingAuth) return null;

  if (!isLoggedIn) {
    return <LoginView onLogin={() => setIsLoggedIn(true)} />;
  }

  return (
    <div className="app-shell">
      {mobileNavOpen && <button className="sidebar-backdrop" onClick={() => setMobileNavOpen(false)} aria-label="关闭导航" tabIndex={-1} />}
      <aside
        ref={sidebarRef}
        id="workspace-navigation"
        aria-label="主导航"
        role={mobileNavOpen ? 'dialog' : undefined}
        aria-modal={mobileNavOpen || undefined}
        className={`app-sidebar ${!isSidebarOpen ? 'is-collapsed' : ''} ${mobileNavOpen ? 'is-mobile-open' : ''}`}
      >
        <div className="sidebar-brand">
          <div className="brand-mark"><BookOpen size={22} strokeWidth={1.7} /></div>
          <div className="sidebar-brand-copy"><strong>Legado <span>Hub</span></strong><small>你的阅读工作空间</small></div>
          <button className="mobile-nav-close" onClick={() => setMobileNavOpen(false)} aria-label="关闭导航"><X size={20} /></button>
        </div>
        <div className="sidebar-finder"><Search size={15} /><input aria-label="查找功能" placeholder="查找功能…" value={navigationQuery} onChange={event => setNavigationQuery(event.target.value)} /></div>
        <nav className="sidebar-nav" aria-label="工作空间页面">
          {['工作空间', '阅读工具', '管理'].filter(group => navigation.some(item => item.group === group && item.label.includes(navigationQuery))).map(group => (
            <div className="nav-group" key={group}>
              <p className="nav-group-title">{group}</p>
              {navigation.filter(item => item.group === group && item.label.includes(navigationQuery)).map(item => (
                <React.Fragment key={item.id}><NavItem active={activeTab === item.id} onClick={() => navigate(item.id)} icon={<item.icon size={18} strokeWidth={1.7} />} label={item.label} collapsed={!isSidebarOpen} /></React.Fragment>
              ))}
            </div>
          ))}
          {!navigation.some(item => item.label.includes(navigationQuery)) && <p className="sidebar-no-results">没有匹配的功能</p>}
        </nav>
        <div className="sidebar-bottom">
          <a href="/reader3/" target="_blank" rel="noopener noreferrer" className="sidebar-reader" title="打开在线阅读器">
            <BookOpen size={18} /><span className="nav-label">打开阅读器</span><ArrowUpRight size={15} className="nav-label ml-auto" />
          </a>
          <div className="sidebar-account">
            <span className="account-avatar">L</span>
            <div className="sidebar-account-copy"><strong>管理员</strong><span>Legado 工作空间</span></div>
            <button onClick={handleLogout} className="sidebar-logout" title="退出登录" aria-label="退出登录"><LogOut size={17} /></button>
          </div>
        </div>
      </aside>

      <main className="app-main" inert={mobileNavOpen || undefined}>
        <header className="app-header">
          <div className="flex items-center gap-3 min-w-0">
            <button className="navigation-toggle" aria-label="切换导航" aria-controls="workspace-navigation"
              aria-expanded={window.matchMedia('(max-width: 767px)').matches ? mobileNavOpen : isSidebarOpen}
              onClick={() => window.matchMedia('(max-width: 767px)').matches ? setMobileNavOpen(open => !open) : setIsSidebarOpen(open => !open)}>
              <Menu size={18} />
            </button>
            <span className="header-workspace">工作空间</span><ChevronRight size={13} className="header-workspace text-outline" />
            <h1>{currentPage.label}</h1>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {versionInfo?.hasUpdate && (
              <button onClick={handleUpdate} disabled={isUpdating} className="update-button">
                <Sparkles size={14} className={isUpdating ? 'animate-spin' : ''} />
                {isUpdating ? '正在更新…' : `更新至 v${versionInfo.latest}`}
              </button>
            )}
            <button className="header-quick-import" onClick={() => setIsJsonImportModalOpen(true)}><Plus size={14} />快速导入</button>
            <span className="version-badge">{versionInfo?.current ? `v${versionInfo.current}` : 'Legado Hub'}</span>
          </div>
        </header>
        <div className="workspace-scroll" id="workspace-content">
          <motion.div key={activeTab} initial={reduceMotion ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: reduceMotion ? 0 : 0.15 }} className={`workspace-content view-${activeTab}`}>
            {renderActiveView}
          </motion.div>
          <footer className="workspace-footer"><span>Legado Hub</span><span>让阅读井然有序</span></footer>
        </div>
      </main>

      {/* Modals */}
      <AddSubscriptionModal
        isOpen={isAddModalOpen}
        onClose={() => setIsAddModalOpen(false)}
        onAdded={() => {
          setIsAddModalOpen(false);
          window.dispatchEvent(new CustomEvent('refresh-data'));
        }}
      />

      <AddRuleModal
        isOpen={isAddRuleModalOpen}
        editData={editRuleData}
        onClose={() => {
          setIsAddRuleModalOpen(false);
          setEditRuleData(null);
        }}
        onAdded={() => {
          setIsAddRuleModalOpen(false);
          setEditRuleData(null);
          window.dispatchEvent(new CustomEvent('refresh-data'));
        }}
      />

      <AddTxtTocRuleModal
        isOpen={isAddTxtTocModalOpen}
        editData={editTxtTocData}
        onClose={() => {
          setIsAddTxtTocModalOpen(false);
          setEditTxtTocData(null);
        }}
        onAdded={() => {
          setIsAddTxtTocModalOpen(false);
          setEditTxtTocData(null);
          window.dispatchEvent(new CustomEvent('refresh-data'));
        }}
      />

      <AddDictRuleModal
        isOpen={isAddDictModalOpen}
        editData={editDictData}
        onClose={() => {
          setIsAddDictModalOpen(false);
          setEditDictData(null);
        }}
        onAdded={() => {
          setIsAddDictModalOpen(false);
          setEditDictData(null);
          window.dispatchEvent(new CustomEvent('refresh-data'));
        }}
      />

      {isJsonImportModalOpen && (
        <JsonImportModal
          onClose={() => setIsJsonImportModalOpen(false)}
          onSuccess={() => setIsJsonImportModalOpen(false)}
        />
      )}

      <WebDiscoveryModal
        isOpen={isDiscoveryModalOpen}
        onClose={() => setIsDiscoveryModalOpen(false)}
        onAdded={() => {
          setIsDiscoveryModalOpen(false);
          window.dispatchEvent(new CustomEvent('refresh-data'));
        }}
      />
    </div>
  );
}
