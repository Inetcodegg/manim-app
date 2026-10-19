const fs = require('node:fs');
const assert = require('node:assert/strict');
const ts = require('typescript');
const { WebSocketServer, WebSocket } = require('ws');
const Module = require('node:module');
const file = require('node:path').resolve(__dirname, '../src/shared/trustedOrigins.ts');
const module_ = new Module(file, module);
module_._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, file);
const { isTrustedAgentOrigin } = module_.exports;
const checks = [
  ['https://www.manimlabs.com', true, true], ['https://manimlabs.com', true, true],
  ['https://manim-std.vercel.app', true, true], ['http://localhost:3000', false, true],
  ['http://localhost:3000', true, false], ['https://www.manimlabs.com.evil.test', true, false],
  ['https://evil.test', true, false], ['https://www.manimlabs.com/path', true, false],
  ['https://www.manimlabs.com@evil.test', true, false], ['null', true, false], [undefined, true, false],
];
for (const [origin, packaged, expected] of checks) assert.equal(isTrustedAgentOrigin(origin, packaged), expected);
(async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, verifyClient: info => isTrustedAgentOrigin(info.origin, true) });
  await new Promise(resolve => server.once('listening', resolve));
  try {
    for (const [origin, expected] of [['https://www.manimlabs.com', true], ['https://evil.test', false], [undefined, false]]) {
      const accepted = await new Promise((resolve, reject) => {
        const client = new WebSocket(`ws://127.0.0.1:${server.address().port}`, origin ? { origin } : {});
        client.once('open', () => { client.close(); resolve(true); });
        client.once('unexpected-response', (_request, response) => { response.resume(); client.terminate(); assert.equal(response.statusCode, 401); resolve(false); });
        client.once('error', error => { if (expected) reject(error); });
      });
      assert.equal(accepted, expected);
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
  console.log('PASS trusted-origin cases and real WebSocket upgrade acceptance/denial before scene execution');
})().catch(error => { console.error(error); process.exitCode = 1; });
