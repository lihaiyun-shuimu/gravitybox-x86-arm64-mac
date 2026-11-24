import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  clearSystemProxyCache,
  createProxyFetch,
  fetchWithProxy,
  getRuntimeProxyConfig,
  loadProxyConfigFromStateDir,
  normalizeManualProxyUrl,
  parseScutilProxyOutput,
  readSystemProxySnapshot,
  redactProxyUrl,
  resolveEffectiveProxy,
  resolveOutboundFetch,
  setRuntimeProxyConfig,
  shouldBypassProxy,
} from '../dist/proxy.js';
import { sanitizeError } from '../dist/files.js';
import { getActiveLocale, setActiveLocale } from '../dist/i18n.js';
import { resolveOpensslBin, sendBackendRpc, stopBackendChild } from './test-ipc.mjs';

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function listenServer(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Failed to bind ephemeral TCP port'));
        return;
      }
      resolve(addr.port);
    });
  });
}

function closeServer(server) {
  return new Promise(resolve => {
    try {
      server.closeAllConnections?.();
      server.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

function rpc(directory, payload) {
  return sendBackendRpc(directory, payload, { timeoutMs: 8000 });
}

test('parseScutilProxyOutput parses HTTP+HTTPS, HTTP-only, SOCKS-only, PAC, disabled, ExceptionsList, and ignores nested Scoped blocks', () => {
  const fullOutput = `
<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
    1 : 169.254/16
    2 : "internal.example.test"
  }
  FTPPassive : 1
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7891
  HTTPSProxy : 127.0.0.1
  SOCKSEnable : 1
  SOCKSPort : 7892
  SOCKSProxy : 127.0.0.1
  __SCOPED__ : <dictionary> {
    en0 : <dictionary> {
      HTTPEnable : 1
      HTTPPort : 9999
      HTTPProxy : 192.0.2.9
    }
  }
}
`;
  const full = parseScutilProxyOutput(fullOutput);
  assert.equal(full.httpEnabled, true);
  assert.equal(full.httpUrl, 'http://127.0.0.1:7890');
  assert.equal(full.httpsEnabled, true);
  assert.equal(full.httpsUrl, 'http://127.0.0.1:7891');
  assert.equal(full.socksEnabled, true);
  assert.equal(full.socksUrl, 'socks5://127.0.0.1:7892');
  assert.equal(full.pacEnabled, false);
  assert.equal(full.pacUrl, null);
  assert.deepEqual(full.exceptions, ['*.local', '169.254/16', 'internal.example.test']);

  const httpOnly = parseScutilProxyOutput(`
<dictionary> {
  HTTPEnable : 1
  HTTPPort : 8080
  HTTPProxy : proxy.example.test
  HTTPSEnable : 0
  HTTPSPort : 8080
  HTTPSProxy : proxy.example.test
}
`);
  assert.equal(httpOnly.httpEnabled, true);
  assert.equal(httpOnly.httpUrl, 'http://proxy.example.test:8080');
  assert.equal(httpOnly.httpsEnabled, false);
  assert.equal(httpOnly.httpsUrl, null);

  const socksOnly = parseScutilProxyOutput(`
<dictionary> {
  HTTPEnable : 0
  HTTPSEnable : 0
  SOCKSEnable : 1
  SOCKSPort : 1080
  SOCKSProxy : ::1
}
`);
  assert.equal(socksOnly.httpEnabled, false);
  assert.equal(socksOnly.httpsEnabled, false);
  assert.equal(socksOnly.socksEnabled, true);
  assert.equal(socksOnly.socksUrl, 'socks5://[::1]:1080');

  const pacOnly = parseScutilProxyOutput(`
<dictionary> {
  ProxyAutoConfigEnable : 1
  ProxyAutoConfigURLString : http://127.0.0.1:7890/proxy.pac
}
`);
  assert.equal(pacOnly.pacEnabled, true);
  assert.equal(pacOnly.pacUrl, 'http://127.0.0.1:7890/proxy.pac');
  assert.equal(pacOnly.httpEnabled, false);

  const disabled = parseScutilProxyOutput(`
<dictionary> {
  FTPPassive : 1
}
`);
  assert.equal(disabled.httpEnabled, false);
  assert.equal(disabled.httpsEnabled, false);
  assert.equal(disabled.socksEnabled, false);
  assert.equal(disabled.pacEnabled, false);
  assert.deepEqual(disabled.exceptions, []);
});

test('normalizeManualProxyUrl validates and normalizes valid inputs and rejects unsafe/invalid URLs', () => {
  assert.equal(normalizeManualProxyUrl('http://127.0.0.1:7890'), 'http://127.0.0.1:7890');
  assert.equal(normalizeManualProxyUrl('  http://127.0.0.1:7890/  '), 'http://127.0.0.1:7890');
  assert.equal(normalizeManualProxyUrl('127.0.0.1:7890'), 'http://127.0.0.1:7890');
  assert.equal(normalizeManualProxyUrl('HTTPS://Proxy.Example.Test:8443'), 'https://proxy.example.test:8443');
  assert.equal(normalizeManualProxyUrl('http://127.0.0.1:80'), 'http://127.0.0.1:80');
  assert.equal(normalizeManualProxyUrl('https://proxy.example.test:443'), 'https://proxy.example.test:443');
  assert.equal(normalizeManualProxyUrl('[::1]:7890'), 'http://[::1]:7890');
  assert.equal(normalizeManualProxyUrl('http://user:pass@127.0.0.1:7890'), 'http://user:pass@127.0.0.1:7890');

  const invalidCases = [
    '',
    '   ',
    null,
    123,
    'socks5://127.0.0.1:1080',
    'socks://127.0.0.1:1080',
    'ftp://proxy.example.test:21',
    'javascript:alert(1)',
    'javascript:1234',
    'file:///etc/passwd',
    'http://:7890',
    'http://127.0.0.1',
    'https://proxy.example.test',
    'http://127.0.0.1:0',
    'http://127.0.0.1:65536',
    'http://127.0.0.1:99999',
    'http://127.0.0.1:abc',
    'http://127.0.0.1:7890/some/path',
    'http://127.0.0.1:7890?foo=bar',
    'http://127.0.0.1:7890#hash',
    'not a url',
    'http://127.0.0.1:7890\nX-Injected: 1',
  ];
  for (const raw of invalidCases) {
    assert.throws(() => normalizeManualProxyUrl(raw), `Expected invalid input to throw: ${JSON.stringify(raw)}`);
  }
});

test('shouldBypassProxy always bypasses loopback hosts and honors wildcards, CIDR, suffixes, and NO_PROXY', () => {
  // Mandatory loopback bypass even with empty exceptions and empty NO_PROXY
  assert.equal(shouldBypassProxy('http://127.0.0.1:9222/json', [], ''), true);
  assert.equal(shouldBypassProxy('https://127.0.0.1:50001/rpc', [], ''), true);
  assert.equal(shouldBypassProxy('http://127.0.5.9:8080/health', [], ''), true);
  assert.equal(shouldBypassProxy('http://localhost:3000/callback', [], ''), true);
  assert.equal(shouldBypassProxy('https://sub.localhost/test', [], ''), true);
  assert.equal(shouldBypassProxy('http://[::1]:8080/status', [], ''), true);

  // Regular remote hosts do not bypass by default
  assert.equal(shouldBypassProxy('https://oauth2.googleapis.com/token', [], ''), false);
  assert.equal(shouldBypassProxy('https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist', [], ''), false);

  // Wildcards, suffixes, macOS short CIDR, standard CIDR, port-specific
  const exceptions = ['*.local', '169.254/16', '198.51.100.0/24', '.corp.example.test', 'api.internal.test:8443'];
  assert.equal(shouldBypassProxy('http://printer.local/status', exceptions, ''), true);
  assert.equal(shouldBypassProxy('http://a.b.local/status', exceptions, ''), true);
  assert.equal(shouldBypassProxy('http://local/status', exceptions, ''), false);
  assert.equal(shouldBypassProxy('http://169.254.12.34/meta', exceptions, ''), true);
  assert.equal(shouldBypassProxy('http://169.253.12.34/meta', exceptions, ''), false);
  assert.equal(shouldBypassProxy('https://198.51.100.42/v1', exceptions, ''), true);
  assert.equal(shouldBypassProxy('https://198.51.101.42/v1', exceptions, ''), false);
  assert.equal(shouldBypassProxy('https://svc.corp.example.test/v1', exceptions, ''), true);
  assert.equal(shouldBypassProxy('https://corp.example.test/v1', exceptions, ''), true);
  assert.equal(shouldBypassProxy('https://evilcorp.example.test/v1', exceptions, ''), false);
  assert.equal(shouldBypassProxy('https://api.internal.test:8443/v1', exceptions, ''), true);
  assert.equal(shouldBypassProxy('https://api.internal.test:443/v1', exceptions, ''), false);

  // NO_PROXY env patterns
  assert.equal(shouldBypassProxy('https://direct.example.test/api', [], 'example.test'), true);
  assert.equal(shouldBypassProxy('https://other.invalid/api', [], '*'), true);
});

test('resolveEffectiveProxy, loadProxyConfigFromStateDir, and resolveOutboundFetch preserve test mocks and report accurate sources', async () => {
  const prev = getRuntimeProxyConfig();
  const tempDir = await mkdtemp(join(tmpdir(), 'gb-proxy-cfg-'));
  try {
    // Missing config.json -> off
    assert.deepEqual(loadProxyConfigFromStateDir(tempDir), { mode: 'off', manualUrl: '' });
    assert.equal(resolveOutboundFetch(globalThis.fetch), globalThis.fetch);

    // Valid config.json -> manual normalized
    await writeFile(
      join(tempDir, 'config.json'),
      JSON.stringify({ antigravityProxyMode: 'manual', antigravityProxyManualUrl: '127.0.0.1:7890' })
    );
    assert.deepEqual(loadProxyConfigFromStateDir(tempDir), {
      mode: 'manual',
      manualUrl: 'http://127.0.0.1:7890',
    });

    // CRITICAL: resolveOutboundFetch switches ONLY globalThis.fetch, never injected test mocks
    assert.equal(resolveOutboundFetch(globalThis.fetch), fetchWithProxy);
    const customMock = async () => new Response('mock');
    assert.equal(resolveOutboundFetch(customMock), customMock);

    // Injectable scutil reader cases
    clearSystemProxyCache();
    const sysHttpHttps = await resolveEffectiveProxy({
      config: { mode: 'system', manualUrl: '' },
      execScutil: async () => `
<dictionary> {
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7891
  HTTPSProxy : 127.0.0.1
}
`,
    });
    assert.equal(sysHttpHttps.source, 'system');
    assert.equal(sysHttpHttps.httpUrl, 'http://127.0.0.1:7890');
    assert.equal(sysHttpHttps.httpsUrl, 'http://127.0.0.1:7891');
    assert.equal(sysHttpHttps.effectiveUrl, 'http://127.0.0.1:7891');

    const sysPac = await resolveEffectiveProxy({
      config: { mode: 'system', manualUrl: '' },
      execScutil: async () => `
<dictionary> {
  ProxyAutoConfigEnable : 1
  ProxyAutoConfigURLString : http://127.0.0.1:7890/pac
}
`,
    });
    assert.equal(sysPac.source, 'system_pac_unsupported');
    assert.equal(sysPac.effectiveUrl, null);

    const sysSocks = await resolveEffectiveProxy({
      config: { mode: 'system', manualUrl: '' },
      execScutil: async () => `
<dictionary> {
  SOCKSEnable : 1
  SOCKSPort : 1080
  SOCKSProxy : 127.0.0.1
}
`,
    });
    assert.equal(sysSocks.source, 'system_socks_unsupported');
    assert.equal(sysSocks.effectiveUrl, null);

    const sysEmpty = await readSystemProxySnapshot({ execScutil: async () => '<dictionary> {\n}\n' });
    assert.equal(sysEmpty.httpUrl, null);
    const sysUnconfigured = await resolveEffectiveProxy({
      config: { mode: 'system', manualUrl: '' },
      systemSnapshot: sysEmpty,
    });
    assert.equal(sysUnconfigured.source, 'system_unconfigured');
    assert.equal(sysUnconfigured.effectiveUrl, null);
  } finally {
    setRuntimeProxyConfig(prev);
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('fetchWithProxy forwards HTTP requests, handles redirects and 304, bypasses 127.0.0.1 loopback, and honors AbortSignal', async () => {
  const prev = getRuntimeProxyConfig();
  const seenByProxy = [];

  const proxyServer = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      seenByProxy.push({
        method: req.method,
        url: req.url,
        host: req.headers.host,
        customHeader: req.headers['x-gb-test'],
        proxyAuth: req.headers['proxy-authorization'],
        body,
      });

      if (req.url === 'http://proxy-target.example.invalid/echo') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'X-Via': 'local-test-proxy' });
        res.end(JSON.stringify({ ok: true, method: req.method, body, header: req.headers['x-gb-test'] }));
        return;
      }
      if (req.url === 'http://proxy-target.example.invalid/not-modified') {
        res.writeHead(304, { ETag: '"v1"' });
        res.end();
        return;
      }
      if (req.url === 'http://proxy-target.example.invalid/redir-1') {
        res.writeHead(302, { Location: 'http://proxy-target.example.invalid/redir-2' });
        res.end();
        return;
      }
      if (req.url === 'http://proxy-target.example.invalid/redir-2') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('redirect-final-ok');
        return;
      }
      if (req.url === 'http://proxy-target.example.invalid/slow') {
        // Hold open until client aborts
        const timer = setTimeout(() => {
          if (!res.writableEnded) {
            res.writeHead(200);
            res.end('too-late');
          }
        }, 10_000);
        timer.unref();
        req.on('close', () => clearTimeout(timer));
        return;
      }
      res.writeHead(404);
      res.end('not found');
    });
  });

  const directLoopbackServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ direct: true }));
  });

  const proxyPort = await listenServer(proxyServer);
  const directPort = await listenServer(directLoopbackServer);

  try {
    setRuntimeProxyConfig({
      mode: 'manual',
      manualUrl: `http://alice:secret@127.0.0.1:${proxyPort}`,
    });

    // 1. Proxied HTTP POST with URLSearchParams body & custom headers
    const postResp = await fetchWithProxy('http://proxy-target.example.invalid/echo', {
      method: 'POST',
      headers: { 'X-GB-Test': 'hello-proxy' },
      body: new URLSearchParams({ grant_type: 'refresh_token', token: 'abc' }),
    });
    assert.equal(postResp.ok, true);
    assert.equal(postResp.status, 200);
    assert.equal(postResp.url, 'http://proxy-target.example.invalid/echo');
    assert.equal(postResp.headers.get('x-via'), 'local-test-proxy');
    const postJson = await postResp.json();
    assert.deepEqual(postJson, {
      ok: true,
      method: 'POST',
      body: 'grant_type=refresh_token&token=abc',
      header: 'hello-proxy',
    });
    assert.equal(
      seenByProxy[0].proxyAuth,
      `Basic ${Buffer.from('alice:secret').toString('base64')}`
    );

    // 2. 304 Not Modified (null-body status must not throw)
    const resp304 = await fetchWithProxy('http://proxy-target.example.invalid/not-modified');
    assert.equal(resp304.status, 304);
    assert.equal(resp304.headers.get('etag'), '"v1"');

    // 3. Redirect manual vs follow
    const manualRedir = await fetchWithProxy('http://proxy-target.example.invalid/redir-1', {
      redirect: 'manual',
    });
    assert.equal(manualRedir.status, 302);
    assert.equal(manualRedir.headers.get('location'), 'http://proxy-target.example.invalid/redir-2');

    const followedRedir = await fetchWithProxy('http://proxy-target.example.invalid/redir-1', {
      redirect: 'follow',
    });
    assert.equal(followedRedir.status, 200);
    assert.equal(followedRedir.url, 'http://proxy-target.example.invalid/redir-2');
    assert.equal(await followedRedir.text(), 'redirect-final-ok');

    // 4. Loopback target 127.0.0.1 MUST bypass the proxy completely
    const proxyCountBeforeLoopback = seenByProxy.length;
    const directResp = await fetchWithProxy(`http://127.0.0.1:${directPort}/local-rpc`);
    assert.equal(directResp.ok, true);
    assert.deepEqual(await directResp.json(), { direct: true });
    assert.equal(
      seenByProxy.length,
      proxyCountBeforeLoopback,
      '127.0.0.1 loopback request must NEVER go through the proxy'
    );

    // 5. AbortSignal pre-aborted & in-flight abort
    const preAborted = new AbortController();
    preAborted.abort(new Error('pre-aborted-reason'));
    await assert.rejects(
      () => fetchWithProxy('http://proxy-target.example.invalid/echo', { signal: preAborted.signal }),
      /pre-aborted-reason/
    );

    const inFlightAc = new AbortController();
    setTimeout(() => inFlightAc.abort(new Error('cancelled-in-flight')), 80);
    await assert.rejects(
      () => fetchWithProxy('http://proxy-target.example.invalid/slow', { signal: inFlightAc.signal }),
      /cancelled-in-flight/
    );
  } finally {
    setRuntimeProxyConfig(prev);
    await closeServer(proxyServer);
    await closeServer(directLoopbackServer);
  }
});

test('HTTP CONNECT tunneling routes HTTPS requests through local proxy server with TLS verification and honors AbortSignal', async () => {
  const prev = getRuntimeProxyConfig();
  const certDir = await mkdtemp(join(tmpdir(), 'gb-proxy-tls-'));
  const keyPath = join(certDir, 'server.key');
  const certPath = join(certDir, 'server.crt');

  // Generate ephemeral self-signed certificate for SAN DNS:connect-target.example.invalid
  await execFileAsync(resolveOpensslBin(), [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    keyPath,
    '-out',
    certPath,
    '-days',
    '1',
    '-subj',
    '/CN=connect-target.example.invalid',
    '-addext',
    'subjectAltName=DNS:connect-target.example.invalid',
  ]);
  const [keyPem, certPem] = await Promise.all([readFile(keyPath), readFile(certPath)]);

  const tlsOriginServer = https.createServer({ key: keyPem, cert: certPem }, (req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          tunneled: true,
          path: req.url,
          method: req.method,
          body: Buffer.concat(chunks).toString('utf8'),
        })
      );
    });
  });
  const originPort = await listenServer(tlsOriginServer);

  const connectTargets = [];
  const openSockets = new Set();
  const connectProxyServer = http.createServer((_req, res) => {
    res.writeHead(405);
    res.end('CONNECT only');
  });

  connectProxyServer.on('connect', (req, clientSocket, head) => {
    openSockets.add(clientSocket);
    clientSocket.on('error', () => {});
    clientSocket.once('close', () => openSockets.delete(clientSocket));
    connectTargets.push({
      target: req.url,
      proxyAuth: req.headers['proxy-authorization'],
    });

    if (req.url === 'stall-target.example.invalid:443') {
      // Stall intentionally before sending 200 Connection Established to test CONNECT abort
      return;
    }
    if (req.url === 'deny-target.example.invalid:443') {
      clientSocket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n');
      return;
    }

    // Tunnel connect-target.example.invalid:443 to our local ephemeral TLS server
    const upstream = net.connect(originPort, '127.0.0.1', () => {
      openSockets.add(upstream);
      upstream.once('close', () => openSockets.delete(upstream));
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  });

  const proxyPort = await listenServer(connectProxyServer);

  try {
    setRuntimeProxyConfig({
      mode: 'manual',
      manualUrl: `http://bob:pw@127.0.0.1:${proxyPort}`,
    });

    const proxyFetchWithTestCa = createProxyFetch({ tlsCa: certPem });

    // 1. End-to-end HTTPS POST over HTTP CONNECT tunnel
    const resp = await proxyFetchWithTestCa('https://connect-target.example.invalid/v1internal:loadCodeAssist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY' } }),
    });
    assert.equal(resp.ok, true);
    assert.equal(resp.status, 200);
    assert.equal(resp.url, 'https://connect-target.example.invalid/v1internal:loadCodeAssist');
    const json = await resp.json();
    assert.deepEqual(json, {
      tunneled: true,
      path: '/v1internal:loadCodeAssist',
      method: 'POST',
      body: JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY' } }),
    });
    assert.equal(connectTargets[0].target, 'connect-target.example.invalid:443');
    assert.equal(
      connectTargets[0].proxyAuth,
      `Basic ${Buffer.from('bob:pw').toString('base64')}`
    );

    // 2. Non-200 CONNECT response fails clearly
    await assert.rejects(
      () => proxyFetchWithTestCa('https://deny-target.example.invalid/test'),
      /Proxy CONNECT failed with HTTP 407/
    );

    // 3. AbortSignal during stalled CONNECT handshake aborts promptly
    const ac = new AbortController();
    setTimeout(() => ac.abort(new Error('connect-aborted')), 80);
    await assert.rejects(
      () => proxyFetchWithTestCa('https://stall-target.example.invalid/test', { signal: ac.signal }),
      /connect-aborted/
    );
  } finally {
    setRuntimeProxyConfig(prev);
    for (const sock of openSockets) sock.destroy();
    openSockets.clear();
    await closeServer(connectProxyServer);
    await closeServer(tlsOriginServer);
    await rm(certDir, { recursive: true, force: true });
  }
});

test('main.ts IPC loads proxy config from config.json and handles proxy_get / proxy_set', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gb-proxy-ipc-'));
  await mkdir(join(directory, '词典'), { recursive: true });
  await writeFile(
    join(directory, 'config.json'),
    JSON.stringify({
      schema: 2,
      applicationChannel: 'stable',
      antigravityProxyMode: 'manual',
      antigravityProxyManualUrl: '127.0.0.1:7890',
    })
  );

  const env = {
    ...process.env,
    GRAVITYBOX_PROBE_LS: 'false',
    GRAVITYBOX_DISABLE_AUTO_PRICING_NETWORK: '1',
    GRAVITYBOX_DISABLE_AUTO_QUOTA_REFRESH: '1',
  };
  const child = spawn(
    process.execPath,
    [
      join(root, 'dist', 'main.js'),
      '--state-dir', directory,
      '--app', '/nonexistent',
      '--profile', join(directory, 'no-profile'),
      '--home-dir', directory,
      '--app-support-dir', directory,
      '--gemini-dir', join(directory, 'gemini'),
    ],
    { stdio: ['ignore', 'ignore', 'pipe'], env }
  );
  const closed = new Promise(resolve => child.once('close', resolve));

  try {
    const deadline = Date.now() + 12_000;
    let initialProxy;
    while (Date.now() < deadline) {
      try {
        initialProxy = await rpc(directory, { command: 'proxy_get' });
        if (initialProxy?.ok) break;
      } catch {}
      await sleep(30);
    }
    assert.equal(initialProxy?.ok, true);
    assert.deepEqual(initialProxy.proxy, {
      mode: 'manual',
      manualUrl: 'http://127.0.0.1:7890',
      effectiveUrl: 'http://127.0.0.1:7890',
      source: 'manual',
    });

    // Invalid proxy_set returns { ok: false, error } and keeps existing config intact
    const invalidRes = await rpc(directory, {
      command: 'proxy_set',
      mode: 'manual',
      manualUrl: 'socks5://127.0.0.1:1080',
    });
    assert.equal(invalidRes.ok, false);
    assert.equal(typeof invalidRes.error, 'string');
    assert.ok(invalidRes.error.length > 0);

    const afterInvalid = await rpc(directory, { command: 'proxy_get' });
    assert.equal(afterInvalid.ok, true);
    assert.equal(afterInvalid.proxy.effectiveUrl, 'http://127.0.0.1:7890');

    // Valid proxy_set -> off
    const offRes = await rpc(directory, { command: 'proxy_set', mode: 'off' });
    assert.equal(offRes.ok, true);
    assert.equal(offRes.proxy.mode, 'off');
    assert.equal(offRes.proxy.effectiveUrl, null);
    assert.equal(offRes.proxy.source, 'off');

    // Valid proxy_set -> new manual URL (bare host:port normalized)
    const nextManual = await rpc(directory, {
      command: 'proxy_set',
      mode: 'manual',
      manualUrl: '127.0.0.1:8888',
    });
    assert.equal(nextManual.ok, true);
    assert.deepEqual(nextManual.proxy, {
      mode: 'manual',
      manualUrl: 'http://127.0.0.1:8888',
      effectiveUrl: 'http://127.0.0.1:8888',
      source: 'manual',
    });

    // Credentialed manual proxy URL must be redacted in both proxy_set and proxy_get IPC replies
    const authManual = await rpc(directory, {
      command: 'proxy_set',
      mode: 'manual',
      manualUrl: 'http://alice:super-secret-pass@127.0.0.1:8888',
    });
    assert.equal(authManual.ok, true);
    assert.deepEqual(authManual.proxy, {
      mode: 'manual',
      manualUrl: 'http://alice:[REDACTED]@127.0.0.1:8888',
      effectiveUrl: 'http://alice:[REDACTED]@127.0.0.1:8888',
      source: 'manual',
    });
    assert.equal(JSON.stringify(authManual).includes('super-secret-pass'), false);

    const authGet = await rpc(directory, { command: 'proxy_get' });
    assert.equal(authGet.ok, true);
    assert.deepEqual(authGet.proxy, {
      mode: 'manual',
      manualUrl: 'http://alice:[REDACTED]@127.0.0.1:8888',
      effectiveUrl: 'http://alice:[REDACTED]@127.0.0.1:8888',
      source: 'manual',
    });
    assert.equal(JSON.stringify(authGet).includes('super-secret-pass'), false);

    await rpc(directory, { command: 'stop' });
    await closed;
  } finally {
    await stopBackendChild(child);
    await closed;
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('createProxyFetch enforces maxResponseBytes across HTTP forwarding and HTTPS CONNECT tunnels', async (t) => {
  const certDir = await mkdtemp(join(tmpdir(), 'gb-proxy-maxbytes-'));
  const keyPath = join(certDir, 'server.key');
  const certPath = join(certDir, 'server.crt');
  t.after(() => rm(certDir, { recursive: true, force: true }));

  await execFileAsync(resolveOpensslBin(), [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    keyPath,
    '-out',
    certPath,
    '-days',
    '1',
    '-subj',
    '/CN=size-target.example.invalid',
    '-addext',
    'subjectAltName=DNS:size-target.example.invalid',
  ]);
  const [keyPem, certPem] = await Promise.all([readFile(keyPath), readFile(certPath)]);

  const tlsOriginServer = https.createServer({ key: keyPem, cert: certPem }, (req, res) => {
    if (req.url === '/ok') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('12345678');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.write(Buffer.alloc(32, 0x61));
    const timer = setTimeout(() => {
      if (!res.writableEnded) {
        res.write(Buffer.alloc(1024, 0x62));
        res.end();
      }
    }, 20);
    timer.unref();
    req.on('close', () => clearTimeout(timer));
  });
  const originPort = await listenServer(tlsOriginServer);

  const openSockets = new Set();
  const proxyServer = http.createServer((req, res) => {
    if (req.url === 'http://size-target.example.invalid/ok') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('12345678');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.write(Buffer.alloc(32, 0x61));
    const timer = setTimeout(() => {
      if (!res.writableEnded) {
        res.write(Buffer.alloc(1024, 0x62));
        res.end();
      }
    }, 20);
    timer.unref();
    req.on('close', () => clearTimeout(timer));
  });
  proxyServer.on('connect', (_req, clientSocket, head) => {
    openSockets.add(clientSocket);
    clientSocket.once('close', () => openSockets.delete(clientSocket));
    const upstream = net.connect(originPort, '127.0.0.1', () => {
      openSockets.add(upstream);
      upstream.once('close', () => openSockets.delete(upstream));
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  });
  const proxyPort = await listenServer(proxyServer);

  try {
    const proxyUrl = `http://127.0.0.1:${proxyPort}`;
    const boundedFetch = createProxyFetch({
      tlsCa: certPem,
      maxResponseBytes: 16,
      resolveProxy: async () => ({
        mode: 'manual',
        manualUrl: proxyUrl,
        effectiveUrl: proxyUrl,
        httpUrl: proxyUrl,
        httpsUrl: proxyUrl,
        exceptions: [],
        source: 'manual',
      }),
    });

    const httpOk = await boundedFetch('http://size-target.example.invalid/ok');
    assert.equal(httpOk.status, 200);
    assert.equal(await httpOk.text(), '12345678');

    await assert.rejects(
      () => boundedFetch('http://size-target.example.invalid/too-large'),
      /exceeded maxResponseBytes \(16 bytes\)/
    );

    const httpsOk = await boundedFetch('https://size-target.example.invalid/ok');
    assert.equal(httpsOk.status, 200);
    assert.equal(await httpsOk.text(), '12345678');

    await assert.rejects(
      () => boundedFetch('https://size-target.example.invalid/too-large'),
      /exceeded maxResponseBytes \(16 bytes\)/
    );
  } finally {
    for (const sock of openSockets) sock.destroy();
    openSockets.clear();
    await closeServer(proxyServer);
    await closeServer(tlsOriginServer);
  }
});

test('createProxyFetch enforces timeoutMs on HTTP forwarding, CONNECT tunnel, and HTTPS responses while preserving AbortSignal priority', async (t) => {
  const certDir = await mkdtemp(join(tmpdir(), 'gb-proxy-timeout-'));
  const keyPath = join(certDir, 'server.key');
  const certPath = join(certDir, 'server.crt');
  t.after(() => rm(certDir, { recursive: true, force: true }));

  await execFileAsync(resolveOpensslBin(), [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    keyPath,
    '-out',
    certPath,
    '-days',
    '1',
    '-subj',
    '/CN=timeout-target.example.invalid',
    '-addext',
    'subjectAltName=DNS:timeout-target.example.invalid',
  ]);
  const [keyPem, certPem] = await Promise.all([readFile(keyPath), readFile(certPath)]);

  const tlsOriginServer = https.createServer({ key: keyPem, cert: certPem }, (req, res) => {
    const timer = setTimeout(() => {
      if (!res.writableEnded) {
        res.writeHead(200);
        res.end('late');
      }
    }, 5_000);
    timer.unref();
    req.on('close', () => clearTimeout(timer));
  });
  const originPort = await listenServer(tlsOriginServer);

  const openSockets = new Set();
  const proxyServer = http.createServer((req, res) => {
    const timer = setTimeout(() => {
      if (!res.writableEnded) {
        res.writeHead(200);
        res.end('late');
      }
    }, 5_000);
    timer.unref();
    req.on('close', () => clearTimeout(timer));
  });
  proxyServer.on('connect', (req, clientSocket, head) => {
    openSockets.add(clientSocket);
    clientSocket.on('error', () => {});
    clientSocket.once('close', () => openSockets.delete(clientSocket));
    if (req.url === 'stall-connect.example.invalid:443') {
      // Intentionally stall before replying 200 Connection Established
      return;
    }
    const upstream = net.connect(originPort, '127.0.0.1', () => {
      openSockets.add(upstream);
      upstream.once('close', () => openSockets.delete(upstream));
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  });
  const proxyPort = await listenServer(proxyServer);

  try {
    const proxyUrl = `http://127.0.0.1:${proxyPort}`;
    const resolveProxy = async () => ({
      mode: 'manual',
      manualUrl: proxyUrl,
      effectiveUrl: proxyUrl,
      httpUrl: proxyUrl,
      httpsUrl: proxyUrl,
      exceptions: [],
      source: 'manual',
    });

    const shortTimeoutFetch = createProxyFetch({
      tlsCa: certPem,
      timeoutMs: 80,
      resolveProxy,
    });

    // 1. Plain HTTP proxy request stalls -> socket/req timeout rejects promptly
    await assert.rejects(
      () => shortTimeoutFetch('http://timeout-target.example.invalid/slow'),
      /Proxied HTTP request timed out after 80ms/
    );

    // 2. CONNECT tunnel stalls before 200 -> openConnectTunnel timeout rejects promptly
    await assert.rejects(
      () => shortTimeoutFetch('https://stall-connect.example.invalid/slow'),
      /Proxy CONNECT tunnel timed out after 80ms/
    );

    // 3. CONNECT succeeds, but upstream HTTPS response stalls -> HTTPS request timeout rejects promptly
    await assert.rejects(
      () => shortTimeoutFetch('https://timeout-target.example.invalid/slow'),
      /Proxied HTTPS request timed out after 80ms/
    );

    // 4. External AbortSignal takes precedence over timeoutMs (both pre-aborted & earlier in-flight abort)
    const slowTimeoutFetch = createProxyFetch({
      tlsCa: certPem,
      timeoutMs: 5_000,
      resolveProxy,
    });
    const preAborted = new AbortController();
    preAborted.abort(new Error('signal-pre-aborted'));
    await assert.rejects(
      () => shortTimeoutFetch('https://stall-connect.example.invalid/slow', { signal: preAborted.signal }),
      /signal-pre-aborted/
    );

    const earlyAbort = new AbortController();
    setTimeout(() => earlyAbort.abort(new Error('signal-early-abort')), 30);
    await assert.rejects(
      () => slowTimeoutFetch('https://stall-connect.example.invalid/slow', { signal: earlyAbort.signal }),
      /signal-early-abort/
    );
  } finally {
    for (const sock of openSockets) sock.destroy();
    openSockets.clear();
    await closeServer(proxyServer);
    await closeServer(tlsOriginServer);
  }
});

test('redactProxyUrl preserves credential-free URLs and redacts embedded credentials', () => {
  assert.equal(redactProxyUrl(null), null);
  assert.equal(redactProxyUrl(''), '');
  assert.equal(redactProxyUrl('http://127.0.0.1:7890'), 'http://127.0.0.1:7890');
  assert.equal(redactProxyUrl('https://proxy.example.test:8443'), 'https://proxy.example.test:8443');
  assert.equal(redactProxyUrl('http://127.0.0.1:80'), 'http://127.0.0.1:80');

  assert.equal(
    redactProxyUrl('http://alice:s3cr3t@127.0.0.1:7890'),
    'http://alice:[REDACTED]@127.0.0.1:7890'
  );
  assert.equal(
    redactProxyUrl('https://alice:s3cr3t@127.0.0.1:443'),
    'https://alice:[REDACTED]@127.0.0.1:443'
  );
  assert.equal(
    redactProxyUrl('http://:barepass@127.0.0.1:7890'),
    'http://:[REDACTED]@127.0.0.1:7890'
  );
  assert.equal(
    redactProxyUrl('http://token-only@127.0.0.1:7890'),
    'http://[REDACTED]@127.0.0.1:7890'
  );
  assert.equal(
    redactProxyUrl('socks5://bob:socks-secret@127.0.0.1:1080'),
    'socks5://bob:[REDACTED]@127.0.0.1:1080'
  );
  assert.equal(
    redactProxyUrl('alice:raw-secret@127.0.0.1:7890'),
    'alice:[REDACTED]@127.0.0.1:7890'
  );
});

test('sanitizeError redacts credentials in http, https, and socks proxy URLs', () => {
  for (const scheme of ['http', 'https', 'socks', 'socks4', 'socks4a', 'socks5', 'socks5h']) {
    const cleaned = sanitizeError(`connect failed via ${scheme}://user:top-secret-pw@127.0.0.1:1080`);
    assert.equal(cleaned.includes('top-secret-pw'), false, `password leaked for ${scheme}`);
    assert.ok(cleaned.includes(`${scheme}://user:[REDACTED_API_KEY]@127.0.0.1:1080`), cleaned);
  }
  const barePass = sanitizeError('proxy error socks5://:bare-secret@127.0.0.1:1080');
  assert.equal(barePass.includes('bare-secret'), false);
  assert.ok(barePass.includes('socks5://:[REDACTED_API_KEY]@127.0.0.1:1080'), barePass);
});

test('P1-36: proxy validation errors localize cleanly across zh-Hans and en', () => {
  const prevLocale = getActiveLocale();
  try {
    setActiveLocale('en');
    assert.throws(() => normalizeManualProxyUrl(''), /^Error: Proxy URL cannot be empty$/);
    assert.throws(() => normalizeManualProxyUrl('socks5://127.0.0.1:1080'), /Unsupported proxy scheme "socks5:\/\/"/);
    assert.throws(() => setRuntimeProxyConfig({ mode: 'bogus' }), /Invalid proxy mode/);

    setActiveLocale('zh-Hans');
    assert.throws(() => normalizeManualProxyUrl(''), /代理地址不能为空/);
    assert.throws(() => normalizeManualProxyUrl('socks5://127.0.0.1:1080'), /不支持的代理协议/);
    assert.throws(() => setRuntimeProxyConfig({ mode: 'bogus' }), /代理模式无效/);
  } finally {
    setActiveLocale(prevLocale);
  }
});

test('P1-38 & P1-44: createProxyFetch blocks non-http(s) redirects, strips sensitive cross-origin headers, and tolerates raw % in proxy passwords', async () => {
  const receivedByHost = new Map();
  const proxyServer = http.createServer((req, res) => {
    const parsedUrl = new URL(req.url);
    receivedByHost.set(parsedUrl.hostname, {
      auth: req.headers['authorization'],
      cookie: req.headers['cookie'],
      proxyAuth: req.headers['proxy-authorization'],
    });
    if (parsedUrl.pathname === '/to-file') {
      res.writeHead(302, { Location: 'file:///etc/passwd' });
      res.end();
      return;
    }
    if (parsedUrl.pathname === '/to-other') {
      res.writeHead(302, { Location: 'http://target-b.example.invalid/final' });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  });
  const proxyPort = await listenServer(proxyServer);
  try {
    // Raw percent in password ("p%zz") must not throw URIError in buildProxyAuthHeader
    const proxyUrl = `http://alice:p%zz@127.0.0.1:${proxyPort}`;
    const proxiedFetch = createProxyFetch({
      resolveProxy: async () => ({
        mode: 'manual',
        manualUrl: proxyUrl,
        effectiveUrl: proxyUrl,
        httpUrl: proxyUrl,
        httpsUrl: proxyUrl,
        exceptions: [],
        source: 'manual',
      }),
    });

    await assert.rejects(
      () => proxiedFetch('http://target-a.example.invalid/to-file'),
      /Unsupported redirect protocol: file:/
    );

    const expectedBasic = `Basic ${Buffer.from('alice:p%zz').toString('base64')}`;
    const firstSeen = receivedByHost.get('target-a.example.invalid');
    assert.equal(firstSeen?.proxyAuth, expectedBasic);

    receivedByHost.clear();
    const res = await proxiedFetch('http://target-a.example.invalid/to-other', {
      headers: {
        Authorization: 'Bearer secret-token',
        Cookie: 'sid=secret-session',
        'Proxy-Authorization': 'Basic caller-override',
      },
    });
    assert.equal(res.status, 200);
    const secondSeen = receivedByHost.get('target-b.example.invalid');
    assert.equal(secondSeen?.auth, undefined, 'cross-origin redirect must strip Authorization');
    assert.equal(secondSeen?.cookie, undefined, 'cross-origin redirect must strip Cookie');
    // Caller-supplied Proxy-Authorization was stripped on cross-origin redirect, then replaced by proxy URL auth
    assert.equal(secondSeen?.proxyAuth, expectedBasic);
  } finally {
    await closeServer(proxyServer);
  }
});
