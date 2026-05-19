import React, { useState } from 'react';
import { X, Upload, Check, AlertCircle, FileJson } from 'lucide-react';
import * as api from '../api';

interface JsonImportModalProps {
  onClose: () => void;
  onSuccess: () => void;
}

type LegadoType = 'source' | 'rule' | 'txtTocRule' | 'dictRule' | 'subscription';

export default function JsonImportModal({ onClose, onSuccess }: JsonImportModalProps) {
  const [jsonText, setJsonText] = useState('');
  const [detectedType, setDetectedType] = useState<LegadoType | null>(null);
  const [itemCount, setItemCount] = useState<number>(0);
  const [parsedData, setParsedData] = useState<any[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [selectedType, setSelectedType] = useState<LegadoType>('source');

  const analyzeJson = (text: string) => {
    setError(null);
    setDetectedType(null);
    setParsedData(null);
    setItemCount(0);

    if (!text.trim()) return;

    try {
      let data = JSON.parse(text);
      if (!Array.isArray(data)) {
        data = [data]; // Normalize single object to array
      }

      if (data.length === 0) {
        setError('JSON 数组不能为空');
        return;
      }

      setParsedData(data);
      setItemCount(data.length);

      // Detect type by inspecting first element
      const first = data[0];
      let type: LegadoType = 'source';

      if (first.bookSourceUrl || first.bookSourceGroup || first.searchUrl) {
        type = 'source';
      } else if (first.sourceUrl && first.sourceName) {
        type = 'subscription';
      } else if (first.urlRule || first.showRule || first.sortNumber !== undefined) {
        type = 'dictRule';
      } else if (first.rule !== undefined || first.serialNumber !== undefined || first.serial_number !== undefined) {
        type = 'txtTocRule';
      } else if (first.pattern !== undefined || first.replacement !== undefined) {
        type = 'rule';
      } else {
        // Fallback guess
        type = 'source';
      }

      setDetectedType(type);
      setSelectedType(type);
    } catch (e: any) {
      setError('JSON 格式错误: ' + e.message);
    }
  };

  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setJsonText(val);
    analyzeJson(val);
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      setJsonText(text);
      analyzeJson(text);
    };
    reader.readAsText(file);
  };

  const handleImport = async () => {
    if (!parsedData || parsedData.length === 0) return;
    setImporting(true);
    try {
      let res;
      if (selectedType === 'source') {
        res = await api.importSources(parsedData);
      } else if (selectedType === 'rule') {
        res = await api.importReplaceRules(parsedData);
      } else if (selectedType === 'txtTocRule') {
        res = await api.importTxtTocRules(parsedData);
      } else if (selectedType === 'dictRule') {
        res = await api.importDictRules(parsedData);
      } else if (selectedType === 'subscription') {
        res = await api.importSubscriptions(parsedData);
      }

      const importedCount = res?.imported ?? parsedData.length;
      alert(`导入成功！共导入/更新 ${importedCount} 条记录。`);
      
      // Dispatch refresh event
      window.dispatchEvent(new CustomEvent('refresh-data'));
      onSuccess();
    } catch (e: any) {
      alert('导入失败: ' + String(e.message || e));
    } finally {
      setImporting(false);
    }
  };

  const typeLabels: Record<LegadoType, string> = {
    source: '📦 书源 (BookSource)',
    rule: '✨ 净化规则 (ReplaceRule)',
    txtTocRule: '📖 目录规则 (TxtTocRule)',
    dictRule: '🔍 字典规则 (DictRule)',
    subscription: '🛎️ 订阅源 (Subscription)',
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl w-full max-w-2xl overflow-hidden shadow-2xl flex flex-col max-h-[90vh]">
        <div className="px-6 py-4 border-b border-outline-variant flex justify-between items-center bg-surface-container-low">
          <div className="flex items-center gap-2">
            <FileJson className="text-primary" size={22} />
            <h3 className="text-lg font-bold tracking-tight">智能导入 JSON 规则</h3>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-surface-container rounded-lg transition-colors">
            <X size={20} />
          </button>
        </div>

        <div className="p-6 overflow-y-auto flex-1 space-y-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-bold text-secondary uppercase tracking-wider">上传 JSON 文件或粘贴内容</label>
            <div className="flex gap-4">
              <div className="flex-1 relative">
                <input
                  type="file"
                  accept=".json"
                  onChange={handleFileUpload}
                  className="hidden"
                  id="json-file-input"
                />
                <label
                  htmlFor="json-file-input"
                  className="flex items-center gap-2 justify-center px-4 py-2 border border-dashed border-outline rounded-lg text-sm font-bold cursor-pointer hover:bg-surface-container-low transition-colors"
                >
                  <Upload size={16} />
                  点击上传 .json 文件
                </label>
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <textarea
              value={jsonText}
              onChange={handleTextChange}
              placeholder="请在此粘贴 Legado/阅读的 JSON 文本内容..."
              className="w-full h-48 px-4 py-3 text-xs bg-surface border border-outline-variant rounded-lg font-mono leading-relaxed focus:outline-none focus:border-primary resize-none"
            />
          </div>

          {error && (
            <div className="bg-error-container/20 border border-error/20 p-4 rounded-xl flex items-start gap-3">
              <AlertCircle className="text-error mt-0.5 shrink-0" size={18} />
              <div className="text-xs text-error font-medium">{error}</div>
            </div>
          )}

          {parsedData && (
            <div className="bg-primary/5 border border-primary/10 p-4 rounded-xl space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Check className="text-primary" size={18} />
                  <span className="text-xs font-bold">解析成功，发现 <span className="text-primary font-extrabold">{itemCount}</span> 项数据</span>
                </div>
                {detectedType && (
                  <span className="text-[10px] bg-primary/10 text-primary px-2.5 py-1 rounded-full font-bold">
                    自动检测: {typeLabels[detectedType]}
                  </span>
                )}
              </div>

              <div className="flex flex-col gap-2 pt-2 border-t border-outline-variant/30">
                <label className="text-[10px] font-bold text-secondary">选择规则分类导入到：</label>
                <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
                  {(Object.keys(typeLabels) as LegadoType[]).map((type) => (
                    <button
                      key={type}
                      type="button"
                      onClick={() => setSelectedType(type)}
                      className={`px-3 py-2 rounded-lg text-[11px] font-bold border transition-all text-center ${
                        selectedType === type
                          ? 'bg-primary border-primary text-on-primary shadow-sm'
                          : 'bg-surface-container-low border-outline-variant hover:bg-surface-container transition-colors'
                      }`}
                    >
                      {type === 'source' ? '📦 书源' : type === 'rule' ? '✨ 净化' : type === 'txtTocRule' ? '📖 目录' : type === 'dictRule' ? '🔍 字典' : '🛎️ 订阅'}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-outline-variant bg-surface-container-low flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 border border-outline rounded-lg text-sm font-bold hover:bg-surface-container transition-colors"
          >
            取消
          </button>
          <button
            onClick={handleImport}
            disabled={importing || !parsedData}
            className="px-5 py-2 bg-primary text-on-primary rounded-lg text-sm font-bold hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-sm"
          >
            {importing ? '正在导入...' : '确认导入'}
          </button>
        </div>
      </div>
    </div>
  );
}
