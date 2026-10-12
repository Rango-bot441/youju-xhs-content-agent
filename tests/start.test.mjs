import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChildEnv, parseSystemProxy } from '../start.mjs';

const SYSTEM_PROXY = `<dictionary> {
  HTTPEnable : 1
  HTTPPort : 9123
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 9124
  HTTPSProxy : proxy.example.test
  SOCKSEnable : 1
  SOCKSPort : 9999
  SOCKSProxy : ignored.example.test
}`;

test('reads enabled system HTTP proxies without using SOCKS or fixed ports', () => {
  assert.deepEqual(parseSystemProxy(SYSTEM_PROXY), { http: 'http://127.0.0.1:9123', https: 'http://proxy.example.test:9124' });
  assert.deepEqual(parseSystemProxy('HTTPEnable : 0\nHTTPProxy : localhost\nHTTPPort : 9123'), { http: null, https: null });
});

test('child receives proxy support and local bypasses without changing parent environment', () => {
  const original = { APP_MODE: 'local', NO_PROXY: '.example.test' };
  const env = buildChildEnv(original, SYSTEM_PROXY, 'darwin');
  assert.equal(env.HTTP_PROXY, 'http://127.0.0.1:9123');
  assert.equal(env.HTTPS_PROXY, 'http://proxy.example.test:9124');
  assert.equal(env.NODE_USE_ENV_PROXY, '1');
  assert.equal(env.NO_PROXY, '.example.test,localhost,127.0.0.1,::1');
  assert.deepEqual(original, { APP_MODE: 'local', NO_PROXY: '.example.test' });
});

test('explicit upper-case and lower-case proxy variables win over system settings', () => {
  const env = buildChildEnv({ HTTP_PROXY: 'http://explicit.example.test:8080', https_proxy: 'http://secure.example.test:8081', no_proxy: 'internal.example.test,localhost' }, SYSTEM_PROXY, 'darwin');
  assert.equal(env.HTTP_PROXY, 'http://explicit.example.test:8080');
  assert.equal(env.https_proxy, 'http://secure.example.test:8081');
  assert.equal(env.HTTPS_PROXY, undefined);
  assert.equal(env.NO_PROXY, 'internal.example.test,localhost,127.0.0.1,::1');
  assert.equal(env.no_proxy, env.NO_PROXY);
});

test('an explicitly empty proxy variable is not overwritten', () => {
  const env = buildChildEnv({ HTTP_PROXY: '', HTTPS_PROXY: '' }, SYSTEM_PROXY, 'darwin');
  assert.equal(env.HTTP_PROXY, '');
  assert.equal(env.HTTPS_PROXY, '');
  assert.equal(env.NODE_USE_ENV_PROXY, undefined);
});

test('non-macOS ignores system output and supports explicitly supplied proxy settings', () => {
  assert.deepEqual(buildChildEnv({ APP_MODE: 'local' }, SYSTEM_PROXY, 'linux'), { APP_MODE: 'local' });
  const explicit = buildChildEnv({ HTTPS_PROXY: 'http://localhost:8456' }, '', 'win32');
  assert.equal(explicit.HTTPS_PROXY, 'http://localhost:8456');
  assert.equal(explicit.NODE_USE_ENV_PROXY, '1');
});

test('invalid addresses, embedded credentials and invalid ports are rejected', () => {
  for (const [host, port] of [['name:password@example.test', '1234'], ['example.test/path', '1234'], ['example.test', '70000'], ['example.test', '0'], ['example.test', 'not-a-port']]) {
    assert.equal(parseSystemProxy(`HTTPEnable : 1\nHTTPProxy : ${host}\nHTTPPort : ${port}`).http, null);
  }
  assert.equal(parseSystemProxy('HTTPEnable : 1\nHTTPProxy : ::1\nHTTPPort : 9123').http, 'http://[::1]:9123');
});

test('no available system proxy preserves the existing environment', () => {
  assert.deepEqual(buildChildEnv({ APP_MODE: 'local', NO_PROXY: 'custom.example.test' }, '', 'darwin'), { APP_MODE: 'local', NO_PROXY: 'custom.example.test' });
});
