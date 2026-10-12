import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { chunkText, importSource, searchChunks, isPublicAddress, validatePublicUrl, fetchPublicUrl, openProxyTunnel } from '../lib/sources.mjs';

const BODY = '本地工作台支持资料导入、原文引用和人工审核。用户可以查看来源片段，再决定是否采纳生成内容。系统不会根据缺失的发布数据编造增长结论。';
const HTML = `<!doctype html><html><head><title>资料引用说明</title><style>.hide{display:none}</style></head><body><nav>导航不属于正文</nav><main><h1>资料引用说明</h1><p>${BODY}</p><script>不能被导入的脚本</script></main><footer>页脚不属于正文</footer></body></html>`;
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

async function startProxy(t, connectHandler) {
  const server = http.createServer();
  const sockets = new Set();
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('connect', connectHandler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

function responseFactory(responses, observed = []) {
  return (url, options, callback) => {
    const request = new EventEmitter();
    request.destroy = () => {};
    request.end = () => {
      observed.push({ url: url.href, options });
      queueMicrotask(() => {
        const item = responses.shift();
        if (!item) { request.emit('error', new Error('unexpected request')); return; }
        const response = new EventEmitter();
        response.statusCode = item.status || 200;
        response.headers = item.headers || { 'content-type': 'text/html; charset=utf-8' };
        response.destroy = () => {};
        callback(response);
        if (item.body !== undefined) response.emit('data', Buffer.isBuffer(item.body) ? item.body : Buffer.from(item.body));
        response.emit('end');
      });
    };
    return request;
  };
}

test('chunks have deterministic source-scoped citations and bounded size', () => {
  const text = Array.from({ length: 45 }, () => BODY).join('\n\n');
  const chunks = chunkText(text, 'source_reference');
  assert.ok(chunks.length > 1);
  assert.deepEqual(chunks, chunkText(text, 'source_reference'));
  chunks.forEach((chunk, index) => {
    assert.equal(chunk.id, `source_reference:p${index + 1}`);
    assert.ok(chunk.text.length <= 1100);
  });
  assert.deepEqual(chunkText(' \n ', 'source_reference'), []);
});

test('long paragraphs are split without breaking Unicode surrogate pairs', () => {
  const chunks = chunkText('资料引用😀'.repeat(550), 'source_unicode');
  assert.ok(chunks.length > 1);
  assert.equal(chunks.map(chunk => chunk.text).join(''), '资料引用😀'.repeat(550));
  for (const chunk of chunks) assert.equal(chunk.text.isWellFormed(), true);
});

test('HTML import extracts actual main text and removes scripts/navigation', async () => {
  const source = await importSource({ text: HTML, kind: 'html' });
  assert.equal(source.title, '资料引用说明');
  assert.equal(source.kind, 'html');
  assert.ok(source.text.includes(BODY));
  assert.equal(/脚本|导航不属于|页脚不属于|display:none/.test(source.text), false);
  const fragment = await importSource({ text: `<p>${BODY}</p>`, kind: 'html' });
  assert.equal(fragment.text, BODY);
});

test('text and Markdown imports preserve source content without fake metadata', async () => {
  const source = await importSource({ title: '人工审核说明', text: `# 人工审核\n\n${BODY}`, kind: 'markdown' });
  assert.equal(source.kind, 'markdown');
  assert.equal(source.url, '');
  assert.ok(source.text.includes('# 人工审核'));
  await assert.rejects(importSource({ text: '' }), /非空/);
  await assert.rejects(importSource({}), /正文或公开网页/);
  await assert.rejects(importSource({ text: 'a'.repeat(250_001) }), /25 万字符/);
});

test('login walls and dynamic empty HTML report clear import errors', async () => {
  await assert.rejects(importSource({ kind: 'html', text: '<html><head><title>登录 - 内容平台</title></head><body><main>登录后查看搜索结果。请扫描二维码并完成身份验证，然后继续访问页面内容。</main></body></html>' }), /尚未读取正文/);
  await assert.rejects(importSource({ kind: 'html', text: '<html><body><div id="app"></div><script>renderApp()</script></body></html>' }), /没有足够的可读取正文/);
});

test('official policy page with title-only dynamic placeholders is not accepted as source正文', async () => {
  await assert.rejects(importSource({ title: '海淀入学意见', text: '<html><head><meta name="ArticleTitle" content="海淀区2026年入学意见"></head><body><main id="mainText"><script>var sp=""; var sp2="";</script><p>扫一扫在手机打开当前页</p></main></body></html>', kind: 'html' }), /没有足够的可读取正文/);
});

test('regional education pages without main and article tags retain school list body', async () => {
  const html = '<html><head><title>美丽海淀</title></head><body><div class="studyMap"><div class="slideTxt"><h2>上地学区</h2><ul class="schoolArea"><li>北京市海淀区上地实验小学</li></ul></div></div><div class="zysx_box"><p>入学工作请以具体学校公告为准</p><p>数据截止时间至2023年08月</p></div></body></html>';
  const source = await importSource({ text: html, kind: 'html' });
  assert.match(source.text, /上地学区/);
  assert.match(source.text, /上地实验小学/);
  assert.match(source.text, /2023年08月/);
  assert.match(source.text, /入学工作请以具体学校公告为准/);
});

test('literal Chinese/keyword retrieval is ranked and reports matched terms', () => {
  const sources = [
    { id: 'source_reference', title: '资料引用说明', chunks: chunkText(BODY, 'source_reference') },
    { id: 'source_versions', title: '版本说明', chunks: chunkText('每次修改会创建一个新版本，原有稿件保持不变。', 'source_versions') },
  ];
  const results = searchChunks(sources, '资料引用');
  assert.equal(results[0].sourceId, 'source_reference');
  assert.ok(results[0].matchedTerms.includes('资料'));
  assert.ok(results[0].score > 0);
  assert.deepEqual(searchChunks(sources, '不存在的英文关键词_nonexistent'), []);
  assert.deepEqual(searchChunks(sources, '！'), []);
});

test('public IP filter blocks local, private, metadata, mapped and reserved addresses', () => {
  for (const address of ['0.0.0.0', '10.0.0.1', '127.0.0.1', '100.64.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.1.1', '192.0.2.1', '198.18.0.1', '203.0.113.1', '224.0.0.1', '255.255.255.255', '::', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', 'fc00::1', 'fe80::1', 'ff02::1', '2001:db8::1', '2002:7f00:1::', '64:ff9b::7f00:1']) {
    assert.equal(isPublicAddress(address), false, address);
  }
  for (const address of ['8.8.8.8', '93.184.216.34', '1.1.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888']) {
    assert.equal(isPublicAddress(address), true, address);
  }
});

test('URL validation rejects unsafe protocols, credentials, internal names and normalized IP tricks', async () => {
  for (const url of ['file:///etc/passwd', 'ftp://example.com/file', 'http://localhost/', 'http://test.local/', 'http://127.1/', 'http://2130706433/', 'http://0x7f000001/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://name:password@example.com/', 'http://example.com:8080/']) {
    await assert.rejects(validatePublicUrl(url, publicLookup), undefined, url);
  }
});

test('all DNS answers must be public, including mixed IPv4/IPv6 responses', async () => {
  const mixed = async () => [{ address: '93.184.216.34', family: 4 }, { address: '::1', family: 6 }];
  await assert.rejects(validatePublicUrl('https://example.com/', mixed), /内网或保留/);
  await assert.rejects(validatePublicUrl('https://example.com/', async () => []), /内网或保留/);
  const result = await validatePublicUrl('https://example.com/path#fragment', publicLookup);
  assert.equal(result.address, '93.184.216.34');
  assert.equal(result.url.href, 'https://example.com/path');
  const dualStack = await validatePublicUrl('https://example.com/', async () => [{ address: '2606:4700:4700::1111', family: 6 }, { address: '93.184.216.34', family: 4 }]);
  assert.equal(dualStack.family, 4);
});

test('network connection pins the vetted IP instead of resolving a second time', async () => {
  let dnsCalls = 0;
  const observed = [];
  const result = await fetchPublicUrl('https://example.com/path', {
    lookup: async () => { dnsCalls++; return dnsCalls === 1 ? [{ address: '93.184.216.34', family: 4 }] : [{ address: '127.0.0.1', family: 4 }]; },
    request: responseFactory([{ body: HTML }], observed),
  });
  assert.ok(result.text.includes(BODY));
  assert.equal(dnsCalls, 1);
  const pinned = await new Promise((resolve, reject) => observed[0].options.lookup('example.com', {}, (error, address, family) => error ? reject(error) : resolve({ address, family })));
  assert.deepEqual(pinned, { address: '93.184.216.34', family: 4 });
  const pinnedAll = await new Promise((resolve, reject) => observed[0].options.lookup('example.com', { all: true }, (error, addresses) => error ? reject(error) : resolve(addresses)));
  assert.deepEqual(pinnedAll, [{ address: '93.184.216.34', family: 4 }]);
  assert.equal(observed[0].options.agent, false);
});

test('every redirect is revalidated and private target is never requested', async () => {
  const observed = [];
  await assert.rejects(fetchPublicUrl('https://example.com/', {
    lookup: publicLookup,
    request: responseFactory([{ status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } }], observed),
  }), /内网或保留/);
  assert.equal(observed.length, 1);
  const dnsQueries = [];
  await assert.rejects(fetchPublicUrl('https://example.com/', {
    lookup: async hostname => { dnsQueries.push(hostname); return [{ address: hostname === 'redirect.example.com' ? '10.0.0.1' : '93.184.216.34', family: 4 }]; },
    request: responseFactory([{ status: 302, headers: { location: 'https://redirect.example.com/' } }]),
  }), /内网或保留/);
  assert.deepEqual(dnsQueries, ['example.com', 'redirect.example.com']);
});

test('relative redirects retain the final validated source URL', async () => {
  const observed = [];
  const result = await fetchPublicUrl('https://example.com/start', {
    lookup: publicLookup,
    request: responseFactory([{ status: 302, headers: { location: '/docs' } }, { body: HTML }], observed),
  });
  assert.equal(result.url, 'https://example.com/docs');
  assert.equal(observed.length, 2);
});

test('redirect loop, HTTP errors, binary files and oversize pages fail explicitly', async () => {
  await assert.rejects(fetchPublicUrl('https://example.com/', { lookup: publicLookup, request: responseFactory(Array.from({ length: 5 }, () => ({ status: 302, headers: { location: '/' } }))) }), /跳转次数/);
  await assert.rejects(fetchPublicUrl('https://example.com/', { lookup: publicLookup, request: responseFactory([{ status: 403 }]) }), /HTTP 403/);
  await assert.rejects(fetchPublicUrl('https://example.com/', { lookup: publicLookup, request: responseFactory([{ headers: { 'content-type': 'application/pdf' }, body: '%PDF' }]) }), /不是可读取/);
  await assert.rejects(fetchPublicUrl('https://example.com/', { lookup: publicLookup, request: responseFactory([{ headers: { 'content-length': '2097153' }, body: '' }]) }), /超过 2 MB/);
  await assert.rejects(fetchPublicUrl('https://example.com/', { lookup: publicLookup, request: responseFactory([{ body: Buffer.alloc(2 * 1024 * 1024 + 1) }]) }), /超过 2 MB/);
});

test('compression has a decompressed-size bound', async () => {
  const headers = { 'content-type': 'text/html', 'content-encoding': 'gzip' };
  const result = await fetchPublicUrl('https://example.com/', { lookup: publicLookup, request: responseFactory([{ headers, body: gzipSync(HTML) }]) });
  assert.equal(result.text, HTML);
  await assert.rejects(fetchPublicUrl('https://example.com/', { lookup: publicLookup, request: responseFactory([{ headers, body: gzipSync('x'.repeat(2 * 1024 * 1024 + 1)) }]) }), /解压后超过/);
});

test('declared legacy encoding and UTF-16 BOM decode while clearly garbled text is rejected', async () => {
  const latinHtml = Buffer.from('<html><head><meta charset="windows-1252"></head><body><main>Documentation: caf\u00e9 and source references.</main></body></html>', 'latin1');
  const legacy = await fetchPublicUrl('https://example.com/', { lookup: publicLookup, request: responseFactory([{ headers: { 'content-type': 'text/html' }, body: latinHtml }]) });
  assert.ok(legacy.text.includes('café'));
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(BODY, 'utf16le')]);
  const decoded = await fetchPublicUrl('https://example.com/', { lookup: publicLookup, request: responseFactory([{ headers: { 'content-type': 'text/plain' }, body: utf16 }]) });
  assert.equal(decoded.text, BODY);
  await assert.rejects(importSource({ text: '�'.repeat(20) }), /无法解码/);
  await assert.rejects(fetchPublicUrl('https://example.com/', { lookup: publicLookup, request: responseFactory([{ headers: { 'content-type': 'text/plain' }, body: Buffer.alloc(50, 0xff) }]) }), /无法解码/);
});

test('explicit proxy CONNECT pins public IP and proxy credentials never reach target', async t => {
  let connectPath;
  let connectAuthorization;
  let targetRequest;
  const proxy = await startProxy(t, (request, socket) => {
    connectPath = request.url;
    connectAuthorization = request.headers['proxy-authorization'];
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    socket.once('data', data => {
      targetRequest = data.toString();
      const body = Buffer.from(BODY);
      socket.end(`HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${BODY}`);
    });
  });
  const proxyUrl = new URL(proxy); proxyUrl.username = 'boundary-test'; proxyUrl.password = 'not-a-real-secret';
  const result = await fetchPublicUrl('http://example.com/reference', { lookup: publicLookup, proxy: proxyUrl.href });
  assert.equal(connectPath, '93.184.216.34:80');
  assert.ok(connectAuthorization.startsWith('Basic '));
  assert.match(targetRequest, /Host: example\.com/i);
  assert.doesNotMatch(targetRequest, /proxy-authorization|not-a-real-secret|boundary-test/i);
  assert.equal(result.text, BODY);
});

test('proxy transport still rejects redirect to private target before CONNECT', async t => {
  let connects = 0;
  const proxy = await startProxy(t, (_request, socket) => {
    connects++;
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    socket.once('data', () => socket.end('HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'));
  });
  await assert.rejects(fetchPublicUrl('http://example.com/', { lookup: publicLookup, proxy }), /内网或保留/);
  assert.equal(connects, 1);
});

test('proxy errors and timeouts are explicit and redact authentication', async t => {
  const refused = await startProxy(t, (_request, socket) => socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n'));
  await assert.rejects(fetchPublicUrl('http://example.com/', { lookup: publicLookup, proxy: refused.replace('http://', 'http://name:secret@') }), error => /407/.test(error.message) && !/secret|name:/.test(error.message));
  const idle = await startProxy(t, () => {});
  const target = await validatePublicUrl('https://example.com/', publicLookup);
  await assert.rejects(openProxyTunnel(target, idle, 25), /代理连接超时/);
  await assert.rejects(openProxyTunnel(target, 'socks5://127.0.0.1:1080', 25), /仅支持 HTTP 或 HTTPS/);
});

test('HTTPS proxy tunnel preserves target SNI and mandatory certificate identity checks', async () => {
  const target = await validatePublicUrl('https://example.com/', publicLookup);
  let connectionOptions;
  let tunnelOptions;
  const socket = new PassThrough();
  const secureSocket = new PassThrough();
  const result = await openProxyTunnel(target, 'http://127.0.0.1:7890', 100, {
    request: (_url, options) => {
      tunnelOptions = options;
      const request = new EventEmitter(); request.destroy = () => {};
      request.end = () => queueMicrotask(() => request.emit('connect', { statusCode: 200 }, socket, Buffer.alloc(0)));
      return request;
    },
    connectTls: options => { connectionOptions = options; queueMicrotask(() => secureSocket.emit('secureConnect')); return secureSocket; },
  });
  assert.equal(tunnelOptions.path, '93.184.216.34:443');
  assert.equal(connectionOptions.servername, 'example.com');
  assert.equal(connectionOptions.rejectUnauthorized, true);
  assert.deepEqual(connectionOptions.ALPNProtocols, ['http/1.1']);
  assert.ok(connectionOptions.checkServerIdentity('ignored-by-design', { subjectaltname: 'DNS:wrong.example.com' }) instanceof Error);
  assert.equal(connectionOptions.checkServerIdentity('ignored-by-design', { subjectaltname: 'DNS:example.com' }), undefined);
  assert.equal(result, secureSocket);
  socket.destroy(); secureSocket.destroy();
});

test('failed target TLS verification yields a safe actionable error', async () => {
  const target = await validatePublicUrl('https://example.com/', publicLookup);
  const socket = new PassThrough();
  const secureSocket = new PassThrough();
  await assert.rejects(openProxyTunnel(target, 'http://name:secret@127.0.0.1:7890', 100, {
    request: () => {
      const request = new EventEmitter(); request.destroy = () => {};
      request.end = () => queueMicrotask(() => request.emit('connect', { statusCode: 200 }, socket, Buffer.alloc(0)));
      return request;
    },
    connectTls: () => { queueMicrotask(() => secureSocket.emit('error', new Error('certificate check failed with secret'))); return secureSocket; },
  }), error => /HTTPS 证书/.test(error.message) && !/secret/.test(error.message));
});
