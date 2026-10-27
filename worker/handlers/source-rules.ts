import { parseHTML } from 'linkedom/worker';

class UnsupportedRule extends Error {}

/** 仅解释静态规则；不执行订阅里的 JS，也不把字符串命中当作解析成功。 */
function jsonValues(root: any, rule: string): any[] {
  let path = rule.replace(/^@json:/i, '').trim();
  if (!path.startsWith('$')) path = '$.' + path;
  path = path.replace(/\.\[/g, '[');
  const tokens = path.slice(1).match(/\.[\w-]+|\[(?:\*|\d+|"[^"\\]+"|'[^'\\]+')\]/g) ?? [];
  if (tokens.join('') !== path.slice(1)) throw new UnsupportedRule();
  let values = [root];
  for (const token of tokens) {
    if (token === '[*]') values = values.flatMap(v => Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : []);
    else {
      const key = token.startsWith('.') ? token.slice(1) : token.slice(1, -1).replace(/^["']|["']$/g, '');
      values = values.map(v => v && typeof v === 'object' ? v[key] : undefined).filter(v => v !== undefined && v !== null);
    }
  }
  return values;
}

function htmlNodes(root: any, rule: string): any[] {
  const parts = rule.replace(/^@css:/i, '').split('@');
  let nodes = [root];
  for (const part of parts) {
    if (!part) continue;
    let selector = part.trim();
    const index = selector.match(/([.!])(-?\d+)$/);
    if (index) selector = selector.slice(0, index.index);
    selector = selector.replace(/^class\./i, '.').replace(/^id\./i, '#').replace(/^tag\./i, '');
    // JSoup 特有选择器、XPath 和复杂的默认规则交给 reader。
    if (!selector || /##|&&|%%|\{\{|^\/|:contains|:matches|^children\b/i.test(selector)) throw new UnsupportedRule();
    nodes = nodes.flatMap(node => {
      let found: any[];
      try { found = Array.from(node.querySelectorAll(selector)); } catch { throw new UnsupportedRule(); }
      if (!index) return found;
      const n = Number(index[2]);
      const at = n < 0 ? found.length + n : n;
      return index[1] === '!' ? found.filter((_, i) => i !== at) : found[at] ? [found[at]] : [];
    });
  }
  return nodes;
}

function field(root: any, rule: string, json: boolean): string {
  if (!rule || /@js:|<js>|##|@put:|&&|%%/i.test(rule)) throw new UnsupportedRule();
  for (const alternative of rule.split('||')) {
    let values: any[];
    if (json) {
      if (alternative.includes('{{')) {
        return alternative.replace(/\{\{([^}]+)\}\}/g, (_m, path) => String(jsonValues(root, path)[0] ?? ''));
      }
      values = jsonValues(root, alternative);
    } else {
      const split = alternative.lastIndexOf('@');
      const attr = split < 0 ? 'text' : alternative.slice(split + 1).trim();
      const selector = split < 0 ? alternative : alternative.slice(0, split);
      const nodes = selector ? htmlNodes(root, selector) : [root];
      values = nodes.map(node => attr === 'text' || attr === 'textNodes' ? node.textContent : attr === 'html' ? node.innerHTML : node.getAttribute(attr));
    }
    const value = values.find(v => typeof v === 'string' && v.trim());
    if (value) return value.trim();
  }
  return '';
}

export function extractSearchBooks(text: string, contentType: string, rules: any, baseUrl: string): {
  supported: boolean; books: { name: string; url: string }[]; matched: number;
} {
  if (!rules || typeof rules.bookList !== 'string' || !rules.bookList.trim()) return { supported: false, books: [], matched: 0 };
  if (/@js:|<js>|##|&&|%%/i.test(rules.bookList)) return { supported: false, books: [], matched: 0 };
  const json = /json/i.test(contentType) || /^[\s\uFEFF]*[\[{]/.test(text);
  try {
    const root = json ? JSON.parse(text.replace(/^\uFEFF/, '')) : parseHTML(text).document;
    let nodes: any[] = [];
    for (const rule of rules.bookList.split('||')) {
      nodes = json ? jsonValues(root, rule).flatMap(v => Array.isArray(v) ? v : [v]) : htmlNodes(root, rule);
      if (nodes.length) break;
    }
    const books: { name: string; url: string }[] = [];
    for (const node of nodes.slice(0, 30)) {
      const name = field(node, rules.name, json);
      const rawUrl = field(node, rules.bookUrl, json);
      if (!name || !rawUrl || /^(?:javascript:|data:|#)/i.test(rawUrl)) continue;
      let url: URL;
      try { url = new URL(rawUrl, baseUrl); } catch { continue; }
      if (/^https?:$/.test(url.protocol)) books.push({ name, url: url.href });
    }
    return { supported: true, books, matched: nodes.length };
  } catch { return { supported: false, books: [], matched: 0 }; }
}
