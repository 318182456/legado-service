import React, { useState, useEffect } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { Fingerprint, Key, BookOpen, ArrowRight } from 'lucide-react';
import * as api from '../api';

interface LoginViewProps {
  onLogin: () => void;
}

export default function LoginView({ onLogin }: LoginViewProps) {
  const reduceMotion = useReducedMotion();
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
    <div className="login-page">
      <section className="login-story" aria-label="Legado 阅读工作空间">
        <div className="login-brand"><span className="brand-mark"><BookOpen size={23} /></span><span>Legado Hub</span></div>
        <div className="login-story-content"><p className="panel-eyebrow">A SPACE FOR YOUR READING</p><h1>把好书，<br />留在手边。</h1><p>整理书源，收藏风格。<br />为每一次翻页，准备一个安静的开始。</p>
          <div className="book-composition" aria-hidden="true"><div className="book-spine spine-one"><span>READ</span><i>阅读</i></div><div className="book-spine spine-two"><span>COLLECT</span><i>收藏</i></div><div className="book-spine spine-three"><span>EXPLORE</span><i>发现</i></div><div className="book-shelf" /></div>
        </div>
        <span className="login-story-footer">YOUR BOOKS. YOUR SPACE.</span>
      </section>
      <section className="login-form-area">
        <motion.div initial={reduceMotion ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: reduceMotion ? 0 : 0.15 }} className="login-form-card">
          <div className="login-mobile-brand"><BookOpen size={25} /><strong>Legado Hub</strong></div>
          <div className="login-heading"><p className="page-eyebrow">WELCOME BACK</p><h2>欢迎回来</h2><p>登录你的阅读工作空间</p></div>
          {hasPasskey && <><button onClick={handlePasskeyLogin} disabled={loading} className="login-passkey"><Fingerprint size={20} />使用 Passkey 登录</button><div className="login-divider"><span />或使用管理员密码<span /></div></>}
          <form onSubmit={handlePasswordLogin} className="space-y-5">
            <div className="space-y-2"><label htmlFor="admin-password" className="login-label">管理员密码</label><div className="relative"><Key className="absolute left-3.5 top-1/2 -translate-y-1/2 text-secondary" size={17} /><input id="admin-password" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} placeholder="请输入登录密码" className="login-password" required /></div></div>
            <button type="submit" disabled={loading} className="login-submit">{loading ? '正在登录…' : '进入工作空间'}<ArrowRight size={17} /></button>
          </form>
          <p className="login-hint">使用已设置的管理员密码{hasPasskey ? '或 Passkey' : ''}登录。</p>
        </motion.div>
        <footer>Legado Hub <span>·</span> 让阅读井然有序</footer>
      </section>
    </div>
  );
}
