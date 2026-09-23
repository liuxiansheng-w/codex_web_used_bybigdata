import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

// Exercise only reads and static text formatting: no model, SQL or file writes.
const { values } = parseArgs({ options: {
  'https-port': { type: 'string', default: '443' },
  'http-port': { type: 'string', default: '80' },
  cert: { type: 'string', default: '/Library/Application Support/Ningmeng/Domain/ningmeng.pem' },
} });
const tlsPort = Number(values['https-port']);
const httpPort = Number(values['http-port']);
const origin = `https://ningmeng.com${tlsPort === 443 ? '' : `:${tlsPort}`}`;
const ca = await readFile(values.cert);

function request(urlPath, { secure = true, headers = {}, body, stream = false } = {}) {
  return new Promise((resolve, reject) => {
    const transport = secure ? https : http;
    const req = transport.request({
      hostname: 'ningmeng.com', servername: 'ningmeng.com', port: secure ? tlsPort : httpPort,
      path: urlPath, method: body === undefined ? 'GET' : 'POST',
      ca, agent: false, timeout: 15_000,
      lookup: (_hostname, options, callback) => callback(null, ...(options.all ? [[{ address: '127.0.0.1', family: 4 }]] : ['127.0.0.1', 4])),
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      const finish = () => resolve({ status: res.statusCode, headers: res.headers, text });
      res.on('data', chunk => {
        text += chunk;
        if (stream && text.includes('event: snapshot\n')) { finish(); res.destroy(); }
        else if (text.length > 32 * 1024 * 1024) { reject(new Error('Unexpectedly large response.')); res.destroy(); }
      });
      res.on('end', finish);
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('Request timed out.')));
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

const redirect = await request('/?local-domain-check=1', { secure: false });
assert.equal(redirect.status, 308);
assert.equal(redirect.headers.location, `${origin}/?local-domain-check=1`);
const page = await request('/');
assert.equal(page.status, 200);
assert.match(page.text, /柠檬/);
const setCookie = page.headers['set-cookie'].find(value => value.startsWith('codex_desk='));
assert.match(setCookie, /; secure/i);
assert.match(setCookie, /; httponly/i);
assert.match(setCookie, /; samesite=strict/i);
assert.doesNotMatch(setCookie, /; domain=/i);
const cookie = setCookie.split(';')[0];
const bootstrap = await request('/api/bootstrap', { headers: { Cookie: cookie } });
assert.equal(bootstrap.status, 200);
const { csrf } = JSON.parse(bootstrap.text);
assert.ok(csrf);
const auth = { Cookie: cookie, Origin: origin, 'X-Codex-Csrf': csrf };
const body = { content: 'x=1', language: 'python', action: 'format' };
const format = await request('/api/project/language', { headers: auth, body });
assert.equal(format.status, 200);
assert.equal(JSON.parse(format.text).content.trim(), 'x = 1');
for (const [label, urlPath, options, expected] of [
  ['HTTP Host', '/', { secure: false, headers: { Host: 'invalid.example' } }, 403],
  ['HTTPS Host', '/', { headers: { Host: 'invalid.example' } }, 403],
  ['cross-origin GET', '/api/bootstrap', { headers: { Cookie: cookie, Origin: 'https://invalid.example' } }, 403],
  ['cross-site fetch', '/', { headers: { 'Sec-Fetch-Site': 'cross-site' } }, 403],
  ['missing session', '/api/bootstrap', {}, 401],
  ['missing CSRF', '/api/project/language', { headers: { Cookie: cookie, Origin: origin }, body }, 403],
  ['invalid CSRF', '/api/project/language', { headers: { ...auth, 'X-Codex-Csrf': 'invalid' }, body }, 403],
  ['missing Origin', '/api/project/language', { headers: { Cookie: cookie, 'X-Codex-Csrf': csrf }, body }, 403],
  ['cross-origin POST', '/api/project/language', { headers: { ...auth, Origin: 'https://invalid.example' }, body }, 403],
]) assert.equal((await request(urlPath, options)).status, expected, label);
const start = Date.now();
const stream = await request('/api/events', { headers: { Cookie: cookie }, stream: true });
assert.equal(stream.status, 200);
assert.match(stream.headers['content-type'], /text\/event-stream/);
assert.match(stream.text, /event: snapshot\n/);
console.log(`PASS: TLS identity, redirect, page, secure session, bootstrap, static formatting, 9 access checks, SSE (${Date.now() - start} ms).`);
