import React, { useState, useEffect } from 'react';
import { RefreshCw, Trash2, MessageSquare, Sparkles, Send, BookOpen, Settings2, AlertTriangle, Copy, Syringe, Undo2, Stethoscope } from 'lucide-react';
import * as api from '../api';

export default function ReviewsView() {
  const [config, setConfig] = useState<api.ReviewConfig | null>(null);
  const [books, setBooks] = useState<api.ReviewBook[]>([]);
  const [activeBook, setActiveBook] = useState<api.ReviewBook | null>(null);
  const [reviews, setReviews] = useState<api.ReviewItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showConfig, setShowConfig] = useState(false);

  // AI 配置表单
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('gemini-2.5-flash');
  const [baseUrl, setBaseUrl] = useState('https://generativelanguage.googleapis.com');
  const [density, setDensity] = useState('6');
  const [personas, setPersonas] = useState('');
  const [reviewToken, setReviewToken] = useState('');
  const [autoFetch, setAutoFetch] = useState(true);
  const [readerUrl, setReaderUrl] = useState('');
  const [readerToken, setReaderToken] = useState('');
  const [saving, setSaving] = useState(false);
  const [mixin, setMixin] = useState('');
  const [injecting, setInjecting] = useState(false);
  const [markName, setMarkName] = useState(true);
  const [mark, setMark] = useState('💬');
  const [injectResult, setInjectResult] = useState<api.InjectResult | null>(null);

  // 诊断
  const [diagBook, setDiagBook] = useState('');
  const [diagAuthor, setDiagAuthor] = useState('');
  const [diagChapter, setDiagChapter] = useState('');
  const [diagBookUrl, setDiagBookUrl] = useState('');
  const [diagOrigin, setDiagOrigin] = useState('');
  const [diagnosing, setDiagnosing] = useState(false);
  const [diagSteps, setDiagSteps] = useState<api.DiagStep[]>([]);

  // 批注表单
  const [bookName, setBookName] = useState('');
  const [bookAuthor, setBookAuthor] = useState('');
  const [chapterTitle, setChapterTitle] = useState('');
  const [paraIndex, setParaIndex] = useState('1');
  const [penName, setPenName] = useState('我');
  const [content, setContent] = useState('');
  const [posting, setPosting] = useState(false);

  const fetchAll = async () => {
    setLoading(true);
    try {
      const [cfg, bookList] = await Promise.all([api.getReviewConfig(), api.getReviewBooks()]);
      setConfig(cfg);
      setBooks(bookList.books);
      setModel(cfg.model);
      setBaseUrl(cfg.baseUrl);
      setDensity(String(cfg.density));
      setPersonas(cfg.personas.join('\n'));
      setAutoFetch(cfg.autoFetch);
      setReaderUrl(cfg.readerUrl);
    } catch (e) {
      console.error('获取段评数据失败', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAll();
  }, []);

  useEffect(() => {
    const handler = () => fetchAll();
    window.addEventListener('refresh-data', handler);
    return () => window.removeEventListener('refresh-data', handler);
  }, []);

  const openBook = async (book: api.ReviewBook) => {
    setActiveBook(book);
    setBookName(book.book_name);
    setBookAuthor(book.author || '');
    try {
      const data = await api.getReviews(book.book_key);
      setReviews(data.reviews);
    } catch (e) {
      alert('获取评论失败: ' + String(e));
    }
  };

  const handleSaveConfig = async () => {
    setSaving(true);
    try {
      const payload: Record<string, string> = {
        gemini_model: model.trim(),
        gemini_base_url: baseUrl.trim().replace(/\/+$/, ''),
        review_density: density,
        review_personas: personas,
        review_auto_fetch: autoFetch ? '1' : '0',
        reader_url: readerUrl.trim().replace(/\/+$/, ''),
      };
      // 留空表示不改动已保存的 Key
      if (apiKey.trim()) payload.gemini_api_key = apiKey.trim();
      if (reviewToken.trim()) payload.review_token = reviewToken.trim();
      if (readerToken.trim()) payload.reader_access_token = readerToken.trim();
      await api.saveSystemConfig(payload);
      setApiKey('');
      setReviewToken('');
      await fetchAll();
      alert('段评配置已保存');
    } catch (e) {
      alert('保存失败: ' + String(e));
    } finally {
      setSaving(false);
    }
  };

  const handlePost = async () => {
    if (!bookName.trim() || !chapterTitle.trim() || !content.trim()) {
      alert('书名、章节标题和批注内容都不能为空');
      return;
    }
    setPosting(true);
    try {
      await api.addReview({
        bookName: bookName.trim(),
        author: bookAuthor.trim(),
        chapterTitle: chapterTitle.trim(),
        paraIndex: Number(paraIndex),
        content: content.trim(),
        penName: penName.trim() || '我',
      });
      setContent('');
      await fetchAll();
      if (activeBook) await openBook(activeBook);
      else alert('批注已发布');
    } catch (e) {
      alert('发布失败: ' + String(e));
    } finally {
      setPosting(false);
    }
  };

  const handleCopyMixin = async () => {
    try {
      const { script } = await api.getReviewMixin();
      setMixin(script);
      await navigator.clipboard.writeText(script);
      alert('混入脚本已复制，粘到你现有 JS 书源的末尾');
    } catch (e) {
      alert('获取脚本失败: ' + String(e));
    }
  };

  const handleCopyJsSource = async () => {
    try {
      const { script } = await api.getReviewJsSource();
      setMixin(script);
      await navigator.clipboard.writeText(script);
      alert('完整 JS 书源模板已复制，填上站点规则后新建一个 JS 书源导入');
    } catch (e) {
      alert('获取模板失败: ' + String(e));
    }
  };

  const handleInject = async (revoke: boolean) => {
    const msg = revoke
      ? '撤销注入？只会清掉本服务写进去的段评规则，别人手配的和 JS 书源都不动。'
      : '给订阅里的规则书源批量写入段评规则？JS 书源会跳过（它们该用混入脚本），已有其他段评规则的源也不会被覆盖。';
    if (!confirm(msg)) return;

    setInjecting(true);
    try {
      const r = await api.injectReviewRule({ revoke, markName, mark });
      setInjectResult(r);
      if (!revoke && !r.hasToken) {
        alert(
          `已写入 ${r.changed} 个书源。\n\n注意：你还没配访问令牌，/review/* 目前是完全公开的。` +
            '建议先在上面填一个 review_token，然后重新注入一次。'
        );
      }
    } catch (e) {
      alert('操作失败: ' + String(e));
    } finally {
      setInjecting(false);
    }
  };

  const handleDiagnose = async (generate: boolean) => {
    if (!diagBook.trim() || !diagChapter.trim()) {
      alert('书名和章节标题不能为空');
      return;
    }
    setDiagnosing(true);
    setDiagSteps([]);
    try {
      const r = await api.diagnoseReview({
        bookName: diagBook.trim(),
        author: diagAuthor.trim(),
        chapterTitle: diagChapter.trim(),
        bookUrl: diagBookUrl.trim(),
        origin: diagOrigin.trim(),
        generate,
      });
      setDiagSteps(r.steps);
      if (generate) await fetchAll();
    } catch (e) {
      alert('诊断失败: ' + String(e));
    } finally {
      setDiagnosing(false);
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('确定删除这条评论吗？它的回复也会一并删除。')) return;
    try {
      await api.deleteReview(id);
      setReviews((prev) => prev.filter((r) => r.id !== id && r.reply_to !== id));
    } catch (e) {
      alert('删除失败: ' + String(e));
    }
  };

  const handleClearAi = async () => {
    if (!activeBook) return;
    if (!confirm(`清空《${activeBook.book_name}》的全部 AI 段评？人工批注会保留，之后重新打开章节会再次生成。`)) return;
    try {
      await api.clearAiReviews(activeBook.book_key);
      await openBook(activeBook);
      await fetchAll();
    } catch (e) {
      alert('清空失败: ' + String(e));
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="animate-spin text-primary" size={32} />
      </div>
    );
  }

  const stats = config?.stats;

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">段评</h2>
          <p className="text-sm text-secondary mt-1">
            AI 陪读评论与个人批注。App 端段评是只读的，批注只能从这里发布。
          </p>
        </div>
        <button
          onClick={() => setShowConfig((v) => !v)}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold border border-outline-variant hover:bg-surface-container-low transition-all"
        >
          <Settings2 size={16} />
          生成配置
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="AI 段评" value={stats?.aiCount ?? 0} icon={<Sparkles size={16} />} />
        <StatCard label="个人批注" value={stats?.humanCount ?? 0} icon={<MessageSquare size={16} />} />
        <StatCard label="已处理章节" value={stats?.chapterCount ?? 0} icon={<BookOpen size={16} />} />
        <StatCard
          label="生成失败"
          value={stats?.failedCount ?? 0}
          icon={<AlertTriangle size={16} />}
          warn={(stats?.failedCount ?? 0) > 0}
        />
      </div>

      {showConfig && (
        <section className="bg-surface-container-lowest border border-outline-variant rounded-xl overflow-hidden shadow-sm">
          <div className="px-6 py-4 border-b border-outline-variant bg-surface-bright">
            <h3 className="font-semibold text-on-surface">AI 生成配置</h3>
            <p className="text-xs text-secondary mt-1">
              未填 API Key 时不会生成 AI 评论，个人批注仍可正常使用。
            </p>
          </div>
          <div className="p-6 space-y-4">
            <Field label={`Gemini API Key${config?.hasApiKey ? '（已配置，留空则不修改）' : ''}`}>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={config?.hasApiKey ? '••••••••' : '粘贴你的 API Key'}
                className="w-full bg-surface-container-low border border-outline-variant rounded-lg px-3 py-2 text-sm"
              />
            </Field>

            <Field label="接口地址（走反代或中转时改这里，不要带结尾斜杠）">
              <input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://generativelanguage.googleapis.com"
                className="w-full bg-surface-container-low border border-outline-variant rounded-lg px-3 py-2 text-sm font-mono"
              />
              <span className="text-xs text-secondary mt-1 block">
                实际请求地址：{baseUrl.replace(/\/+$/, '')}/v1beta/models/{model || '<模型>'}:generateContent
              </span>
            </Field>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Field label="模型">
                <input
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  className="w-full bg-surface-container-low border border-outline-variant rounded-lg px-3 py-2 text-sm"
                />
              </Field>
              <Field label="每章生成条数（1-20）">
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={density}
                  onChange={(e) => setDensity(e.target.value)}
                  className="w-full bg-surface-container-low border border-outline-variant rounded-lg px-3 py-2 text-sm"
                />
              </Field>
            </div>

            <div className="border-t border-outline-variant pt-4">
              <label className="flex items-center gap-2 text-sm font-medium cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={autoFetch}
                  onChange={(e) => setAutoFetch(e.target.checked)}
                  className="accent-primary"
                />
                借 reader 自动抓正文（让规则书源也能有 AI 段评）
              </label>
              <p className="text-xs text-secondary mt-1 mb-3">
                规则书源的段评 URL 只能发 GET，带不了正文。开启后服务端会调 reader 的
                <code> getChapterList </code>与<code> getBookContent </code>
                取回正文再生成——书源 JSON 直接随请求发过去，不需要书在 reader 书架上。
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Field label="reader 地址（留空则用部署时的 READER_URL）">
                  <input
                    value={readerUrl}
                    onChange={(e) => setReaderUrl(e.target.value)}
                    disabled={!autoFetch}
                    placeholder="http://legado-reader:8080"
                    className="w-full bg-surface-container-low border border-outline-variant rounded-lg px-3 py-2 text-sm font-mono disabled:opacity-40"
                  />
                </Field>
                <Field label="reader accessToken（未设密码则留空）">
                  <input
                    type="password"
                    value={readerToken}
                    onChange={(e) => setReaderToken(e.target.value)}
                    disabled={!autoFetch}
                    className="w-full bg-surface-container-low border border-outline-variant rounded-lg px-3 py-2 text-sm disabled:opacity-40"
                  />
                </Field>
              </div>
            </div>

            <Field label="访问令牌 review_token（留空则不修改；配上后 /review/* 必须带 token）">
              <input
                type="password"
                value={reviewToken}
                onChange={(e) => setReviewToken(e.target.value)}
                placeholder="建议随便填一串随机字符，避免别人白嫖你的额度"
                className="w-full bg-surface-container-low border border-outline-variant rounded-lg px-3 py-2 text-sm"
              />
            </Field>

            <Field label="评论人设（一行一个）">
              <textarea
                value={personas}
                onChange={(e) => setPersonas(e.target.value)}
                rows={6}
                className="w-full bg-surface-container-low border border-outline-variant rounded-lg px-3 py-2 text-sm font-mono"
              />
            </Field>

            <div className="flex gap-2">
              <button
                onClick={handleSaveConfig}
                disabled={saving}
                className="bg-primary text-on-primary px-4 py-2 rounded-lg text-sm font-semibold hover:opacity-90 disabled:opacity-50"
              >
                {saving ? '保存中...' : '保存配置'}
              </button>
              <button
                onClick={() => setPersonas((config?.defaultPersonas ?? []).join('\n'))}
                className="px-4 py-2 rounded-lg text-sm border border-outline-variant hover:bg-surface-container-low"
              >
                恢复默认人设
              </button>
            </div>
          </div>
        </section>
      )}

      <section className="bg-surface-container-lowest border border-outline-variant rounded-xl overflow-hidden shadow-sm">
        <div className="px-6 py-4 border-b border-outline-variant bg-surface-bright">
          <h3 className="font-semibold text-on-surface">书源接入</h3>
          <p className="text-xs text-secondary mt-1">
            两类书源走两条路。App 里段评是 <code>isJsSource() ? JS 函数 : ruleReview</code> 二选一，互不通用。
          </p>
        </div>

        <div className="p-6 space-y-6">
          <div>
            <p className="text-sm font-medium">A · 规则书源批量注入（推荐）</p>
            <p className="text-xs text-secondary mt-1 mb-3">
              给订阅里的规则书源写入段评规则，App 同步订阅后即可生效。
              JS 书源会自动跳过，已有其他段评规则的源不会被覆盖。
              开启上方「借 reader 自动抓正文」后，<strong>这类书源同样会自动生成 AI 段评</strong>，
              你只需要正常读书。首次进某一章图标不会立刻出现——后台抓正文加生成需要几秒，
              翻页回来或下次进入即可看到。
            </p>
            <label className="flex items-center gap-2 mb-3 text-xs cursor-pointer select-none">
              <input
                type="checkbox"
                checked={markName}
                onChange={(e) => setMarkName(e.target.checked)}
                className="accent-primary"
              />
              <span>给书源名加前缀标记，方便在换源列表里一眼认出</span>
              <input
                value={mark}
                onChange={(e) => setMark(e.target.value)}
                disabled={!markName}
                maxLength={4}
                className="w-16 bg-surface-container-low border border-outline-variant rounded px-2 py-1 text-center disabled:opacity-40"
              />
              <span className="text-secondary">
                效果：{markName ? `${mark}笔趣实现` : '笔趣实现'}
              </span>
            </label>

            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => handleInject(false)}
                disabled={injecting}
                className="flex items-center gap-2 bg-primary text-on-primary px-4 py-2 rounded-lg text-sm font-semibold hover:opacity-90 disabled:opacity-50"
              >
                <Syringe size={16} />
                {injecting ? '处理中...' : '注入全部规则书源'}
              </button>
              <button
                onClick={() => handleInject(true)}
                disabled={injecting}
                className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm border border-outline-variant hover:bg-surface-container-low disabled:opacity-50"
              >
                <Undo2 size={16} />
                撤销注入
              </button>
            </div>

            {injectResult && (
              <div className="mt-3 text-xs bg-surface-container-low border border-outline-variant rounded-lg px-4 py-3 space-y-1">
                <p className="font-medium">
                  {injectResult.mode === 'inject' ? '注入完成' : '撤销完成'}：改动{' '}
                  <span className="text-primary font-semibold">{injectResult.changed}</span> 个书源
                </p>
                <p className="text-secondary">
                  跳过 JS 书源 {injectResult.jsSkipped} 个 · 无需改动 {injectResult.untouched} 个
                  {injectResult.renamed > 0 && ` · 重命名 ${injectResult.renamed} 个`}
                  {injectResult.broken > 0 && ` · 跳过损坏数据 ${injectResult.broken} 条`}
                </p>
                {!injectResult.hasToken && (
                  <p className="text-error">未配置访问令牌，/review/* 当前对任何人开放</p>
                )}
                <p className="text-secondary">别忘了在 App 里重新同步一次订阅。</p>
              </div>
            )}
          </div>

          <div className="border-t border-outline-variant pt-6">
            <p className="text-sm font-medium">B · JS 书源（更快、无需 reader）</p>
            <p className="text-xs text-secondary mt-1 mb-3">
              JS 书源能在 <code>getReviewSummary</code> 里直接把正文投喂过来，
              不必绕 reader 反查目录，首章出图标也更快。已有 JS 书源就用混入脚本，从零开始用完整模板。
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={handleCopyMixin}
                className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm border border-outline-variant hover:bg-surface-container-low"
              >
                <Copy size={16} />
                复制混入脚本
              </button>
              <button
                onClick={handleCopyJsSource}
                className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm border border-outline-variant hover:bg-surface-container-low"
              >
                <Copy size={16} />
                复制完整 JS 书源模板
              </button>
              {mixin && (
                <button
                  onClick={() => setMixin('')}
                  className="px-4 py-2 rounded-lg text-sm text-secondary hover:text-on-surface"
                >
                  收起
                </button>
              )}
            </div>

            {mixin && (
              <pre className="mt-3 max-h-96 overflow-auto bg-[#1e1e1e] text-[#d4d4d4] text-xs font-mono p-4 rounded-lg">
                {mixin}
              </pre>
            )}
          </div>
        </div>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <section className="bg-surface-container-lowest border border-outline-variant rounded-xl overflow-hidden shadow-sm">
          <div className="px-5 py-3 border-b border-outline-variant bg-surface-bright">
            <h3 className="font-semibold text-sm">书目（{books.length}）</h3>
          </div>
          <div className="divide-y divide-outline-variant max-h-112 overflow-y-auto">
            {books.length === 0 ? (
              <p className="p-5 text-sm text-secondary text-center">
                还没有任何书。用装了段评混入的书源打开一章，或在右侧直接发一条批注。
              </p>
            ) : (
              books.map((b) => (
                <button
                  key={b.book_key}
                  onClick={() => openBook(b)}
                  className={`w-full text-left px-5 py-3 hover:bg-surface-container-low transition-colors ${
                    activeBook?.book_key === b.book_key ? 'bg-surface-container-low' : ''
                  }`}
                >
                  <p className="text-sm font-medium truncate">{b.book_name}</p>
                  <p className="text-xs text-secondary mt-0.5">
                    {b.author || '佚名'} · {b.chapter_count} 章
                    {b.failed_count > 0 && (
                      <span className="text-error"> · {b.failed_count} 章生成失败</span>
                    )}
                  </p>
                </button>
              ))
            )}
          </div>
        </section>

        <section className="lg:col-span-2 bg-surface-container-lowest border border-outline-variant rounded-xl overflow-hidden shadow-sm">
          <div className="px-5 py-3 border-b border-outline-variant bg-surface-bright flex justify-between items-center">
            <h3 className="font-semibold text-sm">
              {activeBook ? `《${activeBook.book_name}》的评论` : '评论'}
            </h3>
            {activeBook && (
              <button onClick={handleClearAi} className="text-xs text-error hover:underline">
                清空本书 AI 段评
              </button>
            )}
          </div>
          <div className="divide-y divide-outline-variant max-h-112 overflow-y-auto">
            {!activeBook ? (
              <p className="p-5 text-sm text-secondary text-center">从左侧选一本书查看评论。</p>
            ) : reviews.length === 0 ? (
              <p className="p-5 text-sm text-secondary text-center">这本书还没有评论。</p>
            ) : (
              reviews.map((r) => (
                <div key={r.id} className="px-5 py-3 flex items-start gap-3">
                  <span
                    className={`shrink-0 mt-0.5 text-[10px] px-1.5 py-0.5 rounded ${
                      r.origin === 'ai'
                        ? 'bg-primary/10 text-primary'
                        : 'bg-tertiary/10 text-tertiary'
                    }`}
                  >
                    {r.origin === 'ai' ? 'AI' : '我'}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs text-secondary">
                      {r.author} · 第 {r.para_index === -1 ? '标题' : r.para_index} 段
                      {r.reply_to && <span> · 回复 #{r.reply_to}</span>}
                    </p>
                    <p className="text-sm mt-1 wrap-break-word">{r.content}</p>
                  </div>
                  <button
                    onClick={() => handleDelete(r.id)}
                    className="shrink-0 text-outline hover:text-error transition-colors"
                    title="删除"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))
            )}
          </div>
        </section>
      </div>

      <section className="bg-surface-container-lowest border border-outline-variant rounded-xl overflow-hidden shadow-sm">
        <div className="px-6 py-4 border-b border-outline-variant bg-surface-bright">
          <h3 className="font-semibold text-on-surface">诊断</h3>
          <p className="text-xs text-secondary mt-1">
            段评不出现时用这里排查。填 App 里显示的书名和章节标题，会同步跑一遍完整链路并逐步汇报。
            带上 bookUrl 与书源地址才能测到抓正文那几步。
          </p>
        </div>
        <div className="p-6 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Field label="书名">
              <input
                value={diagBook}
                onChange={(e) => setDiagBook(e.target.value)}
                placeholder="异度旅社"
                className="w-full bg-surface-container-low border border-outline-variant rounded-lg px-3 py-2 text-sm"
              />
            </Field>
            <Field label="作者">
              <input
                value={diagAuthor}
                onChange={(e) => setDiagAuthor(e.target.value)}
                placeholder="远瞳"
                className="w-full bg-surface-container-low border border-outline-variant rounded-lg px-3 py-2 text-sm"
              />
            </Field>
            <Field label="章节标题（与 App 显示一致）">
              <input
                value={diagChapter}
                onChange={(e) => setDiagChapter(e.target.value)}
                placeholder="第五百七十九章 边境的惊鸿一瞥"
                className="w-full bg-surface-container-low border border-outline-variant rounded-lg px-3 py-2 text-sm"
              />
            </Field>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="书籍链接 bookUrl（选填）">
              <input
                value={diagBookUrl}
                onChange={(e) => setDiagBookUrl(e.target.value)}
                placeholder="http://m.rulianshi.cc/xxx/"
                className="w-full bg-surface-container-low border border-outline-variant rounded-lg px-3 py-2 text-sm font-mono"
              />
            </Field>
            <Field label="书源地址 origin（选填）">
              <input
                value={diagOrigin}
                onChange={(e) => setDiagOrigin(e.target.value)}
                placeholder="http://m.rulianshi.cc"
                className="w-full bg-surface-container-low border border-outline-variant rounded-lg px-3 py-2 text-sm font-mono"
              />
            </Field>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => handleDiagnose(false)}
              disabled={diagnosing}
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold border border-outline-variant hover:bg-surface-container-low disabled:opacity-50"
            >
              <Stethoscope size={16} />
              {diagnosing ? '诊断中...' : '只检查不生成'}
            </button>
            <button
              onClick={() => handleDiagnose(true)}
              disabled={diagnosing}
              className="flex items-center gap-2 bg-primary text-on-primary px-4 py-2 rounded-lg text-sm font-semibold hover:opacity-90 disabled:opacity-50"
            >
              <Sparkles size={16} />
              {diagnosing ? '执行中...' : '诊断并立即生成本章'}
            </button>
          </div>

          {diagSteps.length > 0 && (
            <div className="border border-outline-variant rounded-lg divide-y divide-outline-variant text-xs">
              {diagSteps.map((s, i) => (
                <div key={i} className="px-4 py-2.5 flex items-start gap-3">
                  <span className={s.ok ? 'text-primary shrink-0' : 'text-error shrink-0'}>
                    {s.ok ? '✓' : '✗'}
                  </span>
                  <span className="font-medium shrink-0 w-24">{s.name}</span>
                  <span className={`min-w-0 wrap-break-word ${s.ok ? 'text-secondary' : 'text-error'}`}>
                    {s.detail}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      <section className="bg-surface-container-lowest border border-outline-variant rounded-xl overflow-hidden shadow-sm">
        <div className="px-6 py-4 border-b border-outline-variant bg-surface-bright">
          <h3 className="font-semibold text-on-surface">发表批注</h3>
          <p className="text-xs text-secondary mt-1">
            书名、作者和章节标题要和书源里显示的一致才能对上；段落序号从 1 起，章节标题填 -1。
          </p>
        </div>
        <div className="p-6 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Field label="书名">
              <input
                value={bookName}
                onChange={(e) => setBookName(e.target.value)}
                className="w-full bg-surface-container-low border border-outline-variant rounded-lg px-3 py-2 text-sm"
              />
            </Field>
            <Field label="作者">
              <input
                value={bookAuthor}
                onChange={(e) => setBookAuthor(e.target.value)}
                className="w-full bg-surface-container-low border border-outline-variant rounded-lg px-3 py-2 text-sm"
              />
            </Field>
            <Field label="章节标题">
              <input
                value={chapterTitle}
                onChange={(e) => setChapterTitle(e.target.value)}
                placeholder="第一章 ……"
                className="w-full bg-surface-container-low border border-outline-variant rounded-lg px-3 py-2 text-sm"
              />
            </Field>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <Field label="段落序号">
              <input
                type="number"
                value={paraIndex}
                onChange={(e) => setParaIndex(e.target.value)}
                className="w-full bg-surface-container-low border border-outline-variant rounded-lg px-3 py-2 text-sm"
              />
            </Field>
            <Field label="署名">
              <input
                value={penName}
                onChange={(e) => setPenName(e.target.value)}
                className="w-full bg-surface-container-low border border-outline-variant rounded-lg px-3 py-2 text-sm"
              />
            </Field>
            <div className="md:col-span-2">
              <Field label="批注内容">
                <input
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handlePost()}
                  placeholder="读到这里想说的话……"
                  className="w-full bg-surface-container-low border border-outline-variant rounded-lg px-3 py-2 text-sm"
                />
              </Field>
            </div>
          </div>

          <button
            onClick={handlePost}
            disabled={posting}
            className="flex items-center gap-2 bg-primary text-on-primary px-4 py-2 rounded-lg text-sm font-semibold hover:opacity-90 disabled:opacity-50"
          >
            <Send size={16} />
            {posting ? '发布中...' : '发布批注'}
          </button>
        </div>
      </section>
    </div>
  );
}

function StatCard({
  label,
  value,
  icon,
  warn,
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
  warn?: boolean;
}) {
  return (
    <div className="bg-surface-container-lowest border border-outline-variant rounded-xl px-4 py-3">
      <div className={`flex items-center gap-1.5 text-xs ${warn ? 'text-error' : 'text-secondary'}`}>
        {icon}
        {label}
      </div>
      <p className={`text-2xl font-bold mt-1 ${warn ? 'text-error' : ''}`}>{value}</p>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-secondary mb-1.5 block">{label}</span>
      {children}
    </label>
  );
}
