import React, { useState, useEffect } from 'react';
import { motion } from 'motion/react';
import { Fingerprint, Key, ShieldCheck } from 'lucide-react';
import * as api from '../api';

interface LoginViewProps {
  onLogin: () => void;
}

export default function LoginView({ onLogin }: LoginViewProps) {
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [hasPasskey, setHasPasskey] = useState(false);

  useEffect(() => {
    api.getPasskeyStatus().then(count => setHasPasskey(count > 0)).catch(() => {});
  }, []);

  const handlePasswordLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      await api.login(password);
      onLogin();
    } catch (e) {
      alert('登录失败: ' + String(e));
    } finally {
      setLoading(false);
    }
  };

  const handlePasskeyLogin = async () => {
    setLoading(true);
    try {
      await api.loginWithPasskey();
      onLogin();
    } catch (e) {
      alert('Passkey 验证失败: ' + String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-6">
      <motion.div 
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="w-full max-w-md bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-xl overflow-hidden"
      >
        <div className="p-8 space-y-6">
          <div className="text-center space-y-2">
            <h2 className="text-2xl font-bold tracking-tight">Legado 订阅中心</h2>
            <p className="text-sm text-secondary">请登录以管理您的书源和规则</p>
          </div>

          {hasPasskey && (
            <button 
              onClick={handlePasskeyLogin}
              disabled={loading}
              className="w-full flex items-center justify-center gap-3 bg-surface-container-high hover:bg-surface-container-highest py-3 rounded-xl font-semibold transition-all border border-outline-variant shadow-sm disabled:opacity-50"
            >
              <Fingerprint size={20} className="text-primary" />
              使用 Passkey 登录
            </button>
          )}

          <div className="relative">
            <div className="absolute inset-0 flex items-center"><span className="w-full border-t border-outline-variant"></span></div>
            <div className="relative flex justify-center text-xs uppercase"><span className="bg-surface-container-lowest px-2 text-secondary font-medium">{hasPasskey ? '或使用密码' : '管理员登录'}</span></div>
          </div>

          <form onSubmit={handlePasswordLogin} className="space-y-4">
            <div className="space-y-2">
              <label className="text-xs font-bold text-secondary uppercase tracking-wider ml-1">管理员密码</label>
              <div className="relative">
                <Key className="absolute left-3 top-1/2 -translate-y-1/2 text-secondary" size={18} />
                <input 
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="输入登录密码..."
                  className="w-full bg-surface border border-outline-variant rounded-xl pl-10 pr-4 py-3 outline-none focus:ring-2 focus:ring-primary/20 transition-all"
                  required
                />
              </div>
            </div>
            <button 
              type="submit"
              disabled={loading}
              className="w-full bg-primary text-on-primary py-3 rounded-xl font-bold hover:opacity-90 transition-all shadow-md disabled:opacity-50"
            >
              {loading ? '处理中...' : '登录系统'}
            </button>
          </form>
        </div>
        
        <div className="px-8 py-4 bg-surface text-center border-t border-outline-variant">
          <p className="text-xs text-secondary flex items-center justify-center gap-1">
            <ShieldCheck size={14} /> 强加密保护 · 安全物理存储
          </p>
        </div>
      </motion.div>
    </div>
  );
}
