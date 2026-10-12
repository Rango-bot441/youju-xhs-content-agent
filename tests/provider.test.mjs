import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { callModel, checkProvider, getProviderInfo, resolveCodexCredentials } from '../lib/provider.mjs';

const INPUT = [{ role: 'user', content: '连接检查' }];
const envNames = ['XHS_API_KEY', 'XHS_BASE_URL', 'XHS_MODEL', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL'];
const credential = 'sk-provider-test-only-not-a-real-secret';

async function withService(handler, execute) {
  const original = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
  const server = createServer(async (req, res) => {
    try {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      await handler(req, res, raw ? JSON.parse(raw) : null);
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  for (const name of envNames) delete process.env[name];
  Object.assign(process.env, {
    XHS_API_KEY: credential,
    XHS_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
    XHS_MODEL: 'provider-test-model',
  });
  try { await execute(); }
  finally {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

function result(output = [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '连接成功' }] }]) {
  return { id: 'resp_test', model: 'provider-test-model', status: 'completed', output, usage: { input_tokens: 7, output_tokens: 3 } };
}

test('JSON response preserves Responses items and usage without exposing credentials', async () => {
  await withService((req, res, body) => {
    assert.equal(req.url, '/v1/responses');
    assert.equal(req.headers.authorization, `Bearer ${credential}`);
    assert.equal(body.store, false);
    assert.equal(body.stream, true);
    res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': 'request-test' });
    res.end(JSON.stringify(result()));
  }, async () => {
    const info = await getProviderInfo();
    assert.deepEqual(info, { ready: true, model: 'provider-test-model', source: 'XHS 环境变量' });
    assert.ok(!JSON.stringify(info).includes(credential));
    const response = await callModel({ instructions: '只做连接检查。', input: INPUT });
    assert.deepEqual(response.usage, { inputTokens: 7, outputTokens: 3 });
    assert.equal(response.requestId, 'request-test');
    assert.equal(response.output[0].content[0].text, '连接成功');
  });
});

test('split SSE events preserve function calls and support tool result continuation', async () => {
  let requests = 0;
  const call = { type: 'function_call', id: 'fc_test', call_id: 'call_test', name: 'read_source', arguments: '{"sourceId":"public"}', status: 'completed' };
  await withService((req, res, body) => {
    requests++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (requests === 1) {
      assert.equal(body.tools[0].name, 'read_source');
      assert.equal(body.parallel_tool_calls, false);
      const output = [call];
      const events = [
        { type: 'response.output_item.added', output_index: 0, item: { ...call, arguments: '' } },
        { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"sourceId":' },
        { type: 'response.function_call_arguments.delta', output_index: 0, delta: '"public"}' },
        { type: 'response.output_item.done', output_index: 0, item: call },
        { type: 'response.completed', response: result(output) },
      ].map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join('');
      res.write(events.slice(0, 43));
      res.end(events.slice(43));
    } else {
      assert.equal(body.input.at(-1).type, 'function_call_output');
      assert.equal(body.input.at(-1).call_id, 'call_test');
      res.end(`data: ${JSON.stringify({ type: 'response.completed', response: result() })}\n\ndata: [DONE]\n\n`);
    }
  }, async () => {
    const tools = [{ type: 'function', name: 'read_source', description: '读取公开资料', parameters: { type: 'object', properties: { sourceId: { type: 'string' } }, required: ['sourceId'], additionalProperties: false }, strict: true }];
    const first = await callModel({ instructions: '调用资料工具。', input: INPUT, tools });
    assert.deepEqual(first.output, [call]);
    const next = await callModel({ instructions: '依据工具输出回复。', input: [...INPUT, ...first.output, { type: 'function_call_output', call_id: 'call_test', output: '公开资料读取成功' }], tools });
    assert.equal(next.output[0].content[0].text, '连接成功');
  });
});

test('stream ending without terminal event fails rather than manufacturing success', async () => {
  await withService((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: result().output[0] })}\n\ndata: [DONE]\n\n`);
  }, async () => {
    await assert.rejects(callModel({ input: INPUT }), /未收到完成事件/);
    const check = await checkProvider();
    assert.equal(check.ready, false);
  });
});

test('reasoning text is excluded while opaque state survives tool continuations', async () => {
  await withService((req, res, body) => {
    assert.deepEqual(body.include, ['reasoning.encrypted_content']);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(result([
      { type: 'reasoning', id: 'rs_test', encrypted_content: 'opaque-state', summary: [{ type: 'summary_text', text: 'must-not-be-stored' }], content: [{ text: 'private-reasoning' }] },
      result().output[0],
    ])));
  }, async () => {
    const response = await callModel({ input: INPUT });
    assert.deepEqual(response.output[0], { type: 'reasoning', id: 'rs_test', encrypted_content: 'opaque-state', summary: [] });
    assert.ok(!JSON.stringify(response).includes('must-not-be-stored'));
    assert.ok(!JSON.stringify(response).includes('private-reasoning'));
  });
});

test('HTTP errors redact exact credentials and bearer tokens', async () => {
  await withService((req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `rejected ${credential}; Authorization: Bearer another-secret-value` } }));
  }, async () => {
    try { await callModel({ input: INPUT }); assert.fail('expected request failure'); }
    catch (error) {
      assert.match(error.message, /HTTP 401/);
      assert.ok(!error.message.includes(credential));
      assert.ok(!error.message.includes('another-secret-value'));
    }
  });
});

test('redirect is not followed with service credentials', async () => {
  let count = 0;
  await withService((req, res) => {
    count++;
    res.writeHead(307, { location: '/other-service' });
    res.end();
  }, async () => {
    await assert.rejects(callModel({ input: INPUT }), /拒绝向其他地址转发/);
    assert.equal(count, 1);
  });
});

test('caller cancellation stops an in-flight request', async () => {
  await withService(() => {}, async () => {
    const controller = new AbortController();
    const pending = callModel({ input: INPUT, signal: controller.signal });
    setTimeout(() => controller.abort(), 25);
    await assert.rejects(pending, /已取消/);
  });
});

test('the configured 180-second limit actively aborts an unfinished request', async t => {
  const nativeTimeout = globalThis.setTimeout;
  let matchedTimeout = 0;
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
    if (delay === 180_000) matchedTimeout++;
    return nativeTimeout(callback, delay === 180_000 ? 25 : delay, ...args);
  });
  await withService(() => {}, async () => {
    await assert.rejects(callModel({ input: INPUT }), /超过 180 秒，已取消/);
    assert.equal(matchedTimeout, 1);
  });
});

test('GPT-5 and GPT-6 families request low reasoning while other models keep their protocol', async () => {
  const expected = ['gpt-5.6-terra', 'gpt-6-astra', 'gpt-5', 'another-provider-model'];
  let requests = 0;
  await withService((req, res, body) => {
    assert.equal(body.model, expected[requests]);
    assert.deepEqual(body.reasoning, requests < 3 ? { effort: 'low' } : undefined);
    requests++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(result()));
  }, async () => {
    for (const model of expected) {
      process.env.XHS_MODEL = model;
      await callModel({ input: INPUT });
    }
    assert.equal(requests, expected.length);
  });
});

test('an incomplete explicit credential group does not borrow another source key', async () => {
  await withService(() => { throw new Error('must not make a request'); }, async () => {
    delete process.env.XHS_API_KEY;
    process.env.OPENAI_API_KEY = 'other-source-test-key';
    process.env.OPENAI_MODEL = 'other-model';
    const info = await getProviderInfo();
    assert.equal(info.ready, false);
    assert.match(info.error, /不会借用其他服务/);
  });
});

test('external plaintext service URL is rejected before a request sends a key', async () => {
  await withService(() => { throw new Error('must not make a request'); }, async () => {
    process.env.XHS_BASE_URL = 'http://example.com/v1';
    const info = await getProviderInfo();
    assert.equal(info.ready, false);
    assert.match(info.error, /必须使用 HTTPS/);
  });
});

test('partial output and malformed response are explicit failures', async () => {
  let requests = 0;
  await withService((req, res) => {
    requests++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(requests === 1 ? { ...result(), status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } : { status: 'completed', output: [] }));
  }, async () => {
    await assert.rejects(callModel({ input: INPUT }), /max_output_tokens/);
    await assert.rejects(callModel({ input: INPUT }), /未返回有效输出/);
  });
});

test('successful check is based on a real response rather than configuration presence', async () => {
  let count = 0;
  await withService((req, res) => {
    count++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(result()));
  }, async () => {
    const check = await checkProvider();
    assert.equal(count, 1);
    assert.deepEqual(check, { ready: true, model: 'provider-test-model', message: '真实模型连接成功。', usage: { inputTokens: 7, outputTokens: 3 } });
  });
});

test('custom providers cannot borrow auth.json credentials unless explicitly opted in', async () => {
  let reads = 0;
  const readAuth = async () => { reads++; return { OPENAI_API_KEY: 'synthetic-local-auth' }; };
  const absent = await resolveCodexCredentials('custom', {}, {}, readAuth);
  const disabled = await resolveCodexCredentials('custom', { requires_openai_auth: false }, {}, readAuth);
  assert.equal(absent.key, undefined);
  assert.equal(disabled.key, undefined);
  assert.equal(reads, 0);
  const openai = await resolveCodexCredentials('openai', {}, {}, readAuth);
  const enabled = await resolveCodexCredentials('custom', { requires_openai_auth: true }, {}, readAuth);
  assert.equal(openai.key, 'synthetic-local-auth');
  assert.equal(enabled.key, 'synthetic-local-auth');
  assert.equal(reads, 2);
});

test('provider-specific tokens, headers and environment keys never read unrelated auth.json', async () => {
  const readAuth = async () => assert.fail('provider credential must not fall back to auth.json');
  const direct = await resolveCodexCredentials('custom', { requires_openai_auth: true, experimental_bearer_token: 'provider-token', env_key: 'MISSING' }, {}, readAuth);
  assert.equal(direct.key, 'provider-token');
  const header = await resolveCodexCredentials('custom', { requires_openai_auth: true, http_headers: { Authorization: 'Bearer header-token' } }, {}, readAuth);
  assert.equal(header.headers.Authorization, 'Bearer header-token');
  const fromEnv = await resolveCodexCredentials('custom', { env_key: 'PROVIDER_KEY' }, { PROVIDER_KEY: 'environment-token' }, readAuth);
  assert.equal(fromEnv.key, 'environment-token');
  await assert.rejects(resolveCodexCredentials('custom', { requires_openai_auth: true, env_key: 'MISSING' }, {}, readAuth), /凭据环境变量尚未配置/);
});

test('incomplete SSE retains reported usage while marking the request failed', async () => {
  await withService((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'failed-request' });
    res.end(`data: ${JSON.stringify({ type: 'response.incomplete', response: { ...result(), status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 17, output_tokens: 8 } } })}\n\n`);
  }, async () => {
    await assert.rejects(callModel({ input: INPUT }), error => {
      assert.match(error.message, /max_output_tokens/);
      assert.deepEqual(error.usage, { inputTokens: 17, outputTokens: 8 });
      assert.equal(error.usageUnknown, false);
      assert.equal(error.requestId, 'failed-request');
      return true;
    });
  });
});

test('a connection failure without usage is explicitly unknown rather than zero cost', async () => {
  await withService((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: [DONE]\n\n');
  }, async () => {
    await assert.rejects(callModel({ input: INPUT }), error => {
      assert.equal(error.usageUnknown, true);
      assert.deepEqual(error.usage, { inputTokens: 0, outputTokens: 0 });
      assert.equal(error.requestId, '');
      return true;
    });
  });
});

test('a successful response with omitted usage remains labeled unknown', async () => {
  await withService((req, res) => {
    const value = result(); delete value.usage;
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value));
  }, async () => {
    const response = await callModel({ input: INPUT });
    assert.equal(response.usageUnknown, true);
    assert.deepEqual(response.usage, { inputTokens: 0, outputTokens: 0 });
  });
});
