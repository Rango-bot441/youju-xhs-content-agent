import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib';
import { parseHTML } from 'linkedom';

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_TEXT = 250_000;
const TIMEOUT_MS = 45_000;
const MAX_REDIRECTS = 4;
const BLOCK_TAGS = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'UL', 'OL', 'TR', 'BR', 'BLOCKQUOTE', 'PRE']);

function cleanText(value) {
  return String(value ?? '').replace(/\u0000/g, '').replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function extractRegionalHtml(html) {
  const { document } = parseHTML(html);
  const region = document.querySelector('.studyMap');
  if (!region) return null;
  for (const node of region.querySelectorAll('script,style,noscript')) node.remove();
  const parts = [];
  const pageNote = document.querySelector('.zysx_box');
  if (pageNote) {
    const text = cleanText(pageNote.textContent);
    if (text && !parts.includes(text)) parts.push(text);
  }
  for (const node of region.querySelectorAll('.xqBox, .slideTxt')) {
    const text = cleanText(node.textContent);
    if (text) parts.push(text);
  }
  return cleanText(parts.join('\n\n')) || cleanText(region.textContent);
}

function rejectGarbledText(text) {
  const replacements = text.match(/\uFFFD/g)?.length || 0;
  if (replacements > 3 && replacements / Math.max(1, text.length) > 0.02) {
    throw new Error('资料含有大量无法解码的文字，请转换为 UTF-8 文本后导入，或直接复制正确显示的正文。');
  }
}

export function chunkText(text, sourceId) {
  const normalized = cleanText(text);
  if (!normalized) return [];
  const chunks = [];
  let current = '';
  const flush = () => {
    if (current.trim()) chunks.push({ id: `${sourceId}:p${chunks.length + 1}`, text: current.trim() });
    current = '';
  };
  // Deterministic paragraph-aware chunks. No semantic-retrieval claim or hidden overlap.
  for (const paragraph of normalized.split(/\n\s*\n/)) {
    const pieces = paragraph.length > 1100 ? (paragraph.match(/[^。！？.!?\n]+[。！？.!?\n]*|[。！？.!?\n]+/gu) || [paragraph]) : [paragraph];
    for (const piece of pieces) {
      let remaining = piece.trim();
      while (remaining.length > 1100) {
        flush();
        let cut = 1100;
        if (/^[\uDC00-\uDFFF]$/.test(remaining[cut])) cut--;
        current = remaining.slice(0, cut); flush(); remaining = remaining.slice(cut);
      }
      if (!remaining) continue;
      if (current.length + remaining.length + 2 > 1100) flush();
      current += `${current ? '\n\n' : ''}${remaining}`;
    }
  }
  flush();
  return chunks;
}

export function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 192 && b === 0 && (c === 0 || c === 2))
      || (a === 192 && b === 88 && c === 99) || (a === 198 && (b === 18 || b === 19))
      || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113));
  }
  if (family === 6) {
    // Only public global unicast. This also rejects mapped IPv4, NAT64, local and multicast ranges.
    const [first, second = '0'] = address.toLowerCase().split(':');
    const a = parseInt(first || '0', 16);
    const b = parseInt(second || '0', 16);
    return a >= 0x2000 && a <= 0x3fff && a !== 0x2002 && a !== 0x3fff
      && !(a === 0x2001 && (b <= 0x01ff || b === 0x0db8));
  }
  return false;
}

function parsePublicUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('链接格式不正确，请提供完整的公开网页链接。'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('只支持 http 或 https 公开网页链接。');
  if (url.username || url.password) throw new Error('不支持包含账号密码的链接。');
  if (url.port && !['80', '443'].includes(url.port)) throw new Error('只支持公开网页的 80 或 443 端口。');
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!hostname || /(^|\.)(localhost|local|internal|lan|home|test|invalid|onion)$/.test(hostname)) {
    throw new Error('不能访问本机、内网或保留域名，请使用公开网页。');
  }
  url.hash = '';
  return { url, hostname };
}

export async function validatePublicUrl(value, lookup = dnsLookup) {
  const { url, hostname } = parsePublicUrl(value);
  let addresses;
  if (isIP(hostname)) addresses = [{ address: hostname, family: isIP(hostname) }];
  else {
    try { addresses = await lookup(hostname, { all: true, verbatim: true }); }
    catch { throw new Error('网页域名无法解析，请检查链接后重试。'); }
  }
  if (!Array.isArray(addresses) || !addresses.length || addresses.some(item => !isPublicAddress(item.address))) {
    throw new Error('不能访问本机、内网或保留 IP 地址，请使用公开网页。');
  }
  // Prefer IPv4 when both exist: many local networks advertise AAAA but have no usable IPv6 route.
  const selected = addresses.find(item => isIP(item.address) === 4) || addresses[0];
  return { url, hostname, address: selected.address, family: isIP(selected.address) };
}

export function openProxyTunnel(target, proxyValue, timeout, dependencies = {}) {
  let proxy;
  try { proxy = new URL(proxyValue); } catch { return Promise.reject(new Error('资料导入代理地址无效，请检查 XHS_SOURCE_PROXY 配置。')); }
  if (!['http:', 'https:'].includes(proxy.protocol)) return Promise.reject(new Error('资料导入代理仅支持 HTTP 或 HTTPS CONNECT。'));
  return new Promise((resolve, reject) => {
    let finished = false;
    let request;
    let socket;
    let secureSocket;
    const finish = (error, result) => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      if (error) { secureSocket?.destroy(); socket?.destroy(); request?.destroy(); reject(error); }
      else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error('资料导入代理连接超时，请检查代理后重试。')), timeout);
    const port = target.url.port || (target.url.protocol === 'https:' ? '443' : '80');
    const authority = `${target.family === 6 ? `[${target.address}]` : target.address}:${port}`;
    const headers = { Host: authority };
    try {
      if (proxy.username || proxy.password) headers['Proxy-Authorization'] = `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}`;
      // CONNECT always names the vetted IP, never a hostname that the proxy can re-resolve.
      const makeRequest = dependencies.request || (proxy.protocol === 'https:' ? https.request : http.request);
      request = makeRequest(proxy, { method: 'CONNECT', path: authority, headers, agent: false });
      request.on('connect', (response, connection, head) => {
        socket = connection;
        if (response.statusCode !== 200) { finish(new Error(`资料导入代理返回 HTTP ${response.statusCode || 0}，请检查代理配置。`)); return; }
        if (head?.length) connection.unshift(head);
        connection.on('error', () => finish(new Error('资料导入代理连接中断，请重试。')));
        if (target.url.protocol === 'http:') { finish(null, connection); return; }
        const connectTls = dependencies.connectTls || tls.connect;
        secureSocket = connectTls({
          socket: connection,
          servername: isIP(target.hostname) ? undefined : target.hostname,
          rejectUnauthorized: true,
          ALPNProtocols: ['http/1.1'],
          checkServerIdentity: (_servername, certificate) => tls.checkServerIdentity(target.hostname, certificate),
        });
        secureSocket.once('secureConnect', () => finish(null, secureSocket));
        secureSocket.once('error', () => finish(new Error('无法验证目标网页的 HTTPS 证书或建立安全连接，请检查代理。')));
      });
      request.on('response', response => { response.destroy(); finish(new Error(`资料导入代理拒绝 CONNECT 请求（HTTP ${response.statusCode || 0}）。`)); });
      request.on('error', () => finish(new Error('无法连接资料导入代理，请检查代理是否已启动。')));
      request.end();
    } catch { finish(new Error('资料导入代理配置或连接无效，请检查后重试。')); }
  });
}

async function requestTarget(target, timeout, requestImpl, proxyValue) {
  const started = Date.now();
  let agent;
  if (proxyValue) {
    const socket = await openProxyTunnel(target, proxyValue, timeout);
    agent = target.url.protocol === 'https:' ? new https.Agent({ keepAlive: false }) : new http.Agent({ keepAlive: false });
    agent.createConnection = (_options, callback) => { callback(null, socket); };
    timeout = Math.max(1, timeout - (Date.now() - started));
  }
  return new Promise((resolve, reject) => {
    let finished = false;
    let req;
    let res;
    const finish = (error, value) => {
      if (finished) return;
      finished = true; clearTimeout(timer); agent?.destroy();
      if (error) { res?.destroy(); req?.destroy(); reject(error); } else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('读取网页超时，请重试或直接粘贴正文。')), timeout);
    const request = requestImpl || (target.url.protocol === 'https:' ? https.request : http.request);
    try {
      req = request(target.url, {
        method: 'GET', agent: agent || false,
        headers: { 'User-Agent': 'XHS-Content-Agent/0.1 (user-requested source import)', Accept: 'text/html,text/plain,text/markdown,application/xhtml+xml', 'Accept-Encoding': 'gzip, deflate, br' },
        // Pin the already-vetted address. No second DNS lookup or pooled connection.
        lookup: (_host, options, callback) => {
          if (typeof options === 'function') callback = options;
          if (typeof options === 'object' && options.all) callback(null, [{ address: target.address, family: target.family }]);
          else callback(null, target.address, target.family);
        },
      }, response => {
        res = response;
        const status = response.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(status)) {
          const location = response.headers.location;
          response.destroy();
          if (!location) finish(new Error('网页跳转缺少目标链接。'));
          else finish(null, { redirect: location });
          return;
        }
        if (status < 200 || status >= 300) { finish(new Error(`网页返回 HTTP ${status}，请检查链接或直接粘贴正文。`)); return; }
        if (Number(response.headers['content-length']) > MAX_BYTES) { finish(new Error('网页超过 2 MB，请导入精简后的正文。')); return; }
        const buffers = [];
        let size = 0;
        response.on('data', buffer => {
          size += buffer.length;
          if (size > MAX_BYTES) { finish(new Error('网页超过 2 MB，请导入精简后的正文。')); return; }
          buffers.push(buffer);
        });
        response.on('end', () => finish(null, { body: Buffer.concat(buffers), headers: response.headers }));
        response.on('error', () => finish(new Error('网页连接中断，请重试或直接粘贴正文。')));
      });
      req.on('error', () => finish(new Error('无法连接公开网页，请重试或直接粘贴正文。')));
      req.end();
    } catch { finish(new Error('无法连接公开网页，请检查链接后重试。')); }
  });
}

export async function fetchPublicUrl(value, options = {}) {
  const deadline = Date.now() + TIMEOUT_MS;
  let current = value;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('读取网页超时，请重试或直接粘贴正文。');
    let timer;
    let target;
    try {
      target = await Promise.race([
        validatePublicUrl(current, options.lookup || dnsLookup),
        new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('网页域名解析超时。')), remaining); }),
      ]);
    } finally { clearTimeout(timer); }
    const proxy = options.proxy !== undefined ? options.proxy : options.request ? '' : process.env.XHS_SOURCE_PROXY
      || (target.url.protocol === 'https:' ? process.env.HTTPS_PROXY || process.env.https_proxy : '')
      || process.env.HTTP_PROXY || process.env.http_proxy || '';
    const response = await requestTarget(target, Math.max(1, deadline - Date.now()), options.request, proxy);
    if (response.redirect) {
      if (redirects === MAX_REDIRECTS) throw new Error('网页跳转次数过多，请提供最终页面链接。');
      try { current = new URL(response.redirect, target.url).href; } catch { throw new Error('网页跳转链接无效。'); }
      continue;
    }
    let body = response.body;
    const encoding = (response.headers['content-encoding'] || '').toLowerCase();
    try {
      if (encoding === 'gzip') body = gunzipSync(body, { maxOutputLength: MAX_BYTES });
      else if (encoding === 'deflate') body = inflateSync(body, { maxOutputLength: MAX_BYTES });
      else if (encoding === 'br') body = brotliDecompressSync(body, { maxOutputLength: MAX_BYTES });
      else if (encoding && encoding !== 'identity') throw new Error('unsupported');
    } catch { throw new Error('网页编码不受支持或解压后超过 2 MB，请直接粘贴正文。'); }
    const contentType = (response.headers['content-type'] || '').toLowerCase();
    if (contentType && !/^(text\/(html|plain|markdown)|application\/xhtml\+xml)\b/.test(contentType)) {
      throw new Error('该链接不是可读取的网页或文本；首版支持文本、Markdown 和 HTML。');
    }
    let text;
    const prefix = body.subarray(0, 4096).toString('latin1');
    const metaCharset = prefix.match(/<meta\b[^>]*charset\s*=\s*["']?([a-z0-9_-]+)/i)?.[1];
    const bomCharset = body[0] === 0xff && body[1] === 0xfe ? 'utf-16le' : body[0] === 0xfe && body[1] === 0xff ? 'utf-16be' : '';
    const charset = contentType.match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1] || bomCharset || metaCharset || 'utf-8';
    try { text = new TextDecoder(charset, { fatal: false }).decode(body); }
    catch { throw new Error('网页文字编码不受支持，请直接粘贴正文。'); }
    rejectGarbledText(text);
    return { text, url: target.url.href, contentType };
  }
  throw new Error('网页跳转次数过多。');
}

function extractHtml(html) {
  const { document } = parseHTML(html);
  const title = cleanText(document.querySelector('title')?.textContent || document.querySelector('h1')?.textContent || '');
  document.querySelectorAll('head,script,style,nav,footer,header,aside,form,svg,noscript,iframe,[hidden],[aria-hidden="true"]').forEach(node => node.remove());
  const root = document.querySelector('main') || document.querySelector('article') || document.querySelector('body') || document;
  let parts = [];
  const visit = (node, depth = 0) => {
    if (depth > 150) return;
    if (node.nodeType === 3) { parts.push(node.textContent); return; }
    const block = BLOCK_TAGS.has(node.nodeName);
    if (block) parts.push('\n');
    for (const child of node.childNodes || []) visit(child, depth + 1);
    if (block) parts.push('\n');
  };
  visit(root);
  const text = cleanText(parts.join(''));
  const gated = /登录后(?:查看|浏览|继续)|请先登录|扫码登录后|完成安全验证|访问过于频繁|access denied|sign in to continue|verify you are human|enable javascript and cookies/i;
  const loginTitle = /^(?:登录|注册|安全验证|sign in|log in|access denied|just a moment)[\s!！—\-|·]*/i;
  if ((gated.test(text) && text.length < 1600) || (loginTitle.test(title) && text.length < 2500)) {
    throw new Error('网页需要登录或安全验证，尚未读取正文。请登录后复制有权使用的内容，再粘贴导入。');
  }
  if (text.length < 30) throw new Error('网页没有足够的可读取正文，可能依赖登录或动态加载。请直接粘贴正文。');
  return { title, text };
}

export async function importSource({ title = '', text, url = '', kind = '' } = {}) {
  let importedText;
  let importedTitle = cleanText(title).slice(0, 200);
  let sourceUrl = '';
  let sourceKind = 'text';
  if (typeof text === 'string') {
    if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('资料超过 2 MB，请拆分后导入。');
    if (!text.trim()) throw new Error('请提供非空的资料正文。');
    rejectGarbledText(text);
    const isHtml = kind === 'html' || /<(?:!doctype|html|body|main|article)(?:\s|>)/i.test(text);
    if (isHtml) {
      const regional = extractRegionalHtml(text);
      const extracted = regional ? { title: '', text: regional } : extractHtml(text);
      importedText = extracted.text; importedTitle ||= extracted.title; sourceKind = 'html';
    } else { importedText = cleanText(text); sourceKind = kind === 'markdown' || kind === 'md' ? 'markdown' : 'text'; }
    if (url) sourceUrl = parsePublicUrl(url).url.href;
  } else {
    if (!url) throw new Error('请提供资料正文或公开网页链接。');
    const fetched = await fetchPublicUrl(url);
    sourceUrl = fetched.url; sourceKind = 'url';
    if (/html/.test(fetched.contentType) || /<(?:!doctype|html|body|main|article)(?:\s|>)/i.test(fetched.text)) {
      const regional = extractRegionalHtml(fetched.text);
      const extracted = regional ? { title: '', text: regional } : extractHtml(fetched.text);
      importedText = extracted.text; importedTitle ||= extracted.title;
    } else importedText = cleanText(fetched.text);
  }
  if (!importedText?.trim()) throw new Error('资料中没有可读取的正文。');
  if (importedText.length > MAX_TEXT) throw new Error('正文超过 25 万字符，请按章节拆分导入。');
  importedTitle ||= importedText.split('\n').find(Boolean)?.slice(0, 60) || '未命名资料';
  return { title: importedTitle, text: importedText, url: sourceUrl, kind: sourceKind };
}

function queryTerms(query) {
  const terms = new Set();
  for (const word of query.toLowerCase().match(/[a-z0-9][a-z0-9_-]*|[\p{Script=Han}]+/gu) || []) {
    if (/^[a-z0-9]/.test(word)) { if (word.length > 1) terms.add(word); continue; }
    if (word.length >= 2 && word.length <= 12) terms.add(word);
    for (let i = 0; i < word.length - 1; i++) terms.add(word.slice(i, i + 2));
  }
  return [...terms].slice(0, 80);
}

export function searchChunks(sources, query, limit = 6) {
  const normalized = cleanText(query).toLowerCase().slice(0, 500);
  const terms = queryTerms(normalized);
  if (!terms.length) return [];
  const results = [];
  for (const source of sources) {
    const sourceTitle = String(source.title || '');
    for (const chunk of source.chunks || []) {
      const body = chunk.text.toLowerCase();
      const matchedTerms = terms.filter(term => body.includes(term));
      if (!matchedTerms.length) continue;
      let score = matchedTerms.reduce((sum, term) => sum + (term.length > 2 ? 3 : 1) + (sourceTitle.toLowerCase().includes(term) ? 0.5 : 0), 0);
      if (normalized.length >= 2 && body.includes(normalized)) score += 5;
      results.push({ sourceId: source.id, sourceTitle, id: chunk.id, text: chunk.text, score, matchedTerms });
    }
  }
  return results.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, Math.max(1, Math.min(20, Number(limit) || 6)));
}
