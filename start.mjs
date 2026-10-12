import { execFile, spawn } from 'node:child_process';
import { constants } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { mkdir, open, readFile, writeFile, unlink } from 'node:fs/promises';

const execFileAsync = promisify(execFile);
const projectDir = dirname(fileURLToPath(import.meta.url));

function proxyAddress(host, port) {
  if (!host || /[\s/@?#]/.test(host)) return null;
  if (!/^\d+$/.test(port || '') || Number(port) < 1 || Number(port) > 65_535) return null;
  const hostname = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  try {
    const url = new URL(`http://${hostname}:${port}`);
    if (url.username || url.password || !url.hostname) return null;
    return url.origin;
  } catch { return null; }
}

export function parseSystemProxy(text) {
  const values = Object.create(null);
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.match(/^\s*(HTTPEnable|HTTPProxy|HTTPPort|HTTPSEnable|HTTPSProxy|HTTPSPort)\s*:\s*(.*?)\s*$/);
    if (match) values[match[1]] = match[2];
  }
  return {
    http: values.HTTPEnable === '1' ? proxyAddress(values.HTTPProxy, values.HTTPPort) : null,
    https: values.HTTPSEnable === '1' ? proxyAddress(values.HTTPSProxy, values.HTTPSPort) : null,
  };
}

function hasExplicitProxy(env, protocol) {
  return Object.hasOwn(env, `${protocol}_PROXY`) || Object.hasOwn(env, `${protocol.toLowerCase()}_proxy`);
}

export function buildChildEnv(env, systemProxyText = '', platform = process.platform) {
  const childEnv = { ...env };
  if (platform === 'darwin') {
    const system = parseSystemProxy(systemProxyText);
    if (!hasExplicitProxy(env, 'HTTP') && system.http) childEnv.HTTP_PROXY = system.http;
    if (!hasExplicitProxy(env, 'HTTPS') && system.https) childEnv.HTTPS_PROXY = system.https;
  }
  const hasProxy = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'].some(name => Boolean(childEnv[name]));
  if (hasProxy) {
    childEnv.NODE_USE_ENV_PROXY = '1';
    const bypass = new Set([...(childEnv.NO_PROXY || '').split(','), ...(childEnv.no_proxy || '').split(',')].map(value => value.trim()).filter(Boolean));
    for (const hostname of ['localhost', '127.0.0.1', '::1']) bypass.add(hostname);
    childEnv.NO_PROXY = [...bypass].join(',');
    // Keep lower-case variables consistent if the caller already uses them.
    if (Object.hasOwn(childEnv, 'no_proxy')) childEnv.no_proxy = childEnv.NO_PROXY;
  }
  return childEnv;
}

export async function getLaunchEnv(env = process.env) {
  let systemProxyText = '';
  if (process.platform === 'darwin' && (!hasExplicitProxy(env, 'HTTP') || !hasExplicitProxy(env, 'HTTPS'))) {
    try {
      const result = await execFileAsync('/usr/sbin/scutil', ['--proxy'], { encoding: 'utf8', timeout: 2000, maxBuffer: 65_536 });
      systemProxyText = result.stdout;
    } catch {
      // No system setting is required: preserve the caller's network configuration.
    }
  }
  return buildChildEnv(env, systemProxyText);
}

const serviceFile = resolve(projectDir, '.local/service.json');
const serverPath = resolve(projectDir, 'server.mjs');
async function health(port) {
  try { const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) }); return response.ok ? await response.json() : null; }
  catch { return null; }
}
async function serviceRecord() {
  try { return JSON.parse(await readFile(serviceFile, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new Error('本地服务记录无法读取；不会操作未知进程。'); }
}
async function ownsProcess(record) {
  if (!record || !Number.isSafeInteger(record.pid) || record.pid < 2 || record.serverPath !== serverPath || !Number.isInteger(record.port)) return false;
  try {
    const { stdout } = await execFileAsync('ps', ['-p', String(record.pid), '-o', 'command='], { encoding: 'utf8' });
    return stdout.trim() === `${process.execPath} ${serverPath}`;
  } catch { return false; }
}
async function manageService(mode, env) {
  const port = Number(env.PORT || 4318);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须是有效端口。');
  const record = await serviceRecord();
  if (mode === '--status') {
    const status = await health(record?.port || port);
    console.log(JSON.stringify({ running: status?.app === 'xhs-content-agent', managed: Boolean(record && status?.pid === record.pid && await ownsProcess(record)), ...status }));
    return;
  }
  if (mode === '--stop') {
    if (!record) { console.log('没有本项目登记的后台服务。'); return; }
    if (!await ownsProcess(record)) throw new Error('登记的进程已停止或身份不匹配；未终止任何进程。');
    const status = await health(record.port);
    if (status && (status.app !== 'xhs-content-agent' || status.pid !== record.pid)) throw new Error('端口正在由其他进程使用；未终止任何进程。');
    if (status?.activeRuns) throw new Error('仍有模型任务运行，请先在页面完成或取消任务。');
    process.kill(record.pid, 'SIGTERM');
    for (let i = 0; i < 30 && await ownsProcess(record); i++) await new Promise(resolveWait => setTimeout(resolveWait, 150));
    if (await ownsProcess(record)) throw new Error('服务尚未退出；未强制终止，请稍后检查状态。');
    await unlink(serviceFile);
    console.log('本项目后台服务已停止，资料与稿件保留。');
    return;
  }
  await mkdir(resolve(projectDir, '.local'), { recursive: true });
  const lockPath = resolve(projectDir, '.local/service-start.lock');
  let lock;
  try { lock = await open(lockPath, 'wx'); }
  catch { throw new Error('已有启动操作，或上次启动异常留下锁；请检查 .local/service-start.lock。'); }
  try {
    const status = await health(port);
    if (status) {
      if (status.app === 'xhs-content-agent') { console.log(`服务已运行：http://127.0.0.1:${port}${status.pid === record?.pid ? '' : '（由另一个启动会话管理）'}`); return; }
      throw new Error('端口已被其他应用使用，请设置其他 PORT。');
    }
    if (record && await ownsProcess(record)) throw new Error('已有登记进程但暂未通过健康检查；未重复启动。');
    const log = await open(resolve(projectDir, '.local/server.log'), 'a', 0o600);
    const child = spawn(process.execPath, [serverPath], { cwd: projectDir, env, detached: true, stdio: ['ignore', log.fd, log.fd] });
    let launchError; child.once('error', error => { launchError = error; });
    child.unref(); await log.close();
    for (let i = 0; i < 40; i++) {
      if (launchError) throw new Error('本地服务无法启动，请检查 Node.js。');
      const current = await health(port);
      if (current?.app === 'xhs-content-agent' && current.pid === child.pid) {
        await writeFile(serviceFile, JSON.stringify({ pid: child.pid, port, serverPath, startedAt: new Date().toISOString() }), { mode: 0o600 });
        console.log(`后台服务已就绪：http://127.0.0.1:${port}`); return;
      }
      if (child.exitCode !== null) break;
      await new Promise(resolveWait => setTimeout(resolveWait, 150));
    }
    if (child.pid && await ownsProcess({ pid: child.pid, port, serverPath })) child.kill('SIGTERM');
    throw new Error('启动未通过健康检查，请查看 .local/server.log。');
  } finally { await lock.close(); await unlink(lockPath).catch(() => {}); }
}

async function start() {
  const env = await getLaunchEnv();
  const mode = process.argv[2];
  if (['--background', '--status', '--stop'].includes(mode)) return manageService(mode, env);
  const child = spawn(process.execPath, mode === '--evaluate' ? [resolve(projectDir, 'scripts/evaluate.mjs'), ...process.argv.slice(3)] : [serverPath, ...process.argv.slice(2)], {
    cwd: projectDir,
    env,
    stdio: 'inherit',
  });
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const handlers = new Map(signals.map(signal => [signal, () => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  }]));
  for (const [signal, handler] of handlers) process.on(signal, handler);
  const cleanup = () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  };
  child.once('error', () => {
    cleanup();
    console.error('无法启动本地服务，请检查 Node.js 安装。');
    process.exitCode = 1;
  });
  child.once('exit', (code, signal) => {
    cleanup();
    if (signal) {
      process.exitCode = 128 + (constants.signals[signal] || 1);
      try { process.kill(process.pid, signal); } catch { /* Preserve numeric exit status. */ }
    } else {
      process.exitCode = code ?? 1;
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await start(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
