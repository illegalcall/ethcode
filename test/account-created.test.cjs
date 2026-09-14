const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

for (const failure of [null, 'mkdir', 'export']) {
  test(`account creation emits only ${failure ? 'failure after ' + failure : 'success after persistence'}`, async () => {
    const events = [];
    let persisted = false;
    const failureError = new Error('storage failure');
    const mocks = {
      'viem': { checksumAddress: (address) => address },
      'viem/accounts': { generatePrivateKey: () => '0x' + '1'.repeat(64) },
      'fs': {
        existsSync: () => false,
        mkdirSync: () => { if (failure === 'mkdir') throw failureError; },
        readdirSync: () => [],
      },
      'path': path,
      'crypto': { randomBytes: (length) => Buffer.alloc(length) },
      'vscode': { window: {} },
      '../api/api': { event: {
        accountCreated: { fire: (event) => events.push({ ...event, persisted }) },
        updateAccountList: { fire: () => {} },
      } },
      '../lib': { logger: { log: () => {}, error: () => {} } },
      './networks': { isTestingNetwork: () => false },
      './keythereum': {
        dump: () => ({ address: '2'.repeat(40) }),
        exportToFile: () => { if (failure === 'export') throw failureError; persisted = true; },
      },
    };
    const source = ts.transpileModule(readFileSync(path.resolve('src/utils/wallet.ts'), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
    }).outputText;
    const module = { exports: {} };
    vm.runInNewContext(source, {
      module, exports: module.exports, Buffer,
      require: (name) => { if (!(name in mocks)) throw new Error(`Unexpected import: ${name}`); return mocks[name]; },
    });
    const address = module.exports.createKeyPair({ extensionPath: '/test-only' }, '/test-only', 'test-only-password');
    await Promise.resolve();
    assert.equal(events.length, 1);
    assert.equal(events[0].success, !failure);
    assert.equal(events[0].persisted, !failure);
    if (failure) { assert.equal(events[0].error, failureError); assert.equal(address, undefined); }
    else { assert.equal(address, '0x' + '2'.repeat(40)); assert.match(events[0].successMsg, /New account created/); }
  });
}
