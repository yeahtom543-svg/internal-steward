const { test } = require('node:test');
const assert = require('node:assert/strict');
const { inspectFile } = require('../scripts/check-secrets');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

test('常见密钥、私有文件和配置值不得进入暂存区', () => {
  assert.ok(inspectFile('index.js', 'sk-' + 'x'.repeat(32)).includes('model-key'));
  assert.ok(inspectFile('index.js', 'AK' + 'ID' + 'x'.repeat(32)).includes('tencent-access-id'));
  assert.ok(inspectFile('.env', 'NAME=value').includes('forbidden-file'));
  assert.ok(inspectFile('state.json', '{}').includes('forbidden-file'));
  assert.ok(inspectFile('proof.png', 'image').includes('private-artifact'));
  assert.ok(inspectFile('config.js', 'WECOM_' + 'AGENT_ID = "1234567"').some(x => x.startsWith('literal-config:')));
  assert.ok(inspectFile('config.js', 'WECOM_' + 'APP_SECRET = "' + 'z'.repeat(40) + '"').some(x => x.startsWith('literal-config:')));
});

test('暂存区含敏感赋值即使工作区已改回仍被阻止，输出不泄露匹配值', () => {
  const tempRoot = path.resolve(__dirname, '../tmp');
  fs.mkdirSync(tempRoot, { recursive: true });
  const temp = fs.mkdtempSync(path.join(tempRoot, 'internal-steward-guard-'));
  try {
    fs.mkdirSync(path.join(temp, 'scripts'));
    fs.copyFileSync(path.join(__dirname, '../scripts/check-secrets.js'), path.join(temp, 'scripts/check-secrets.js'));
    execFileSync('git', ['init', '--quiet'], { cwd: temp });
    const fakeValue = 'z'.repeat(40);
    fs.writeFileSync(path.join(temp, 'config.js'), 'WECOM_' + 'APP_SECRET = "' + fakeValue + '"');
    execFileSync('git', ['add', 'config.js'], { cwd: temp });
    fs.writeFileSync(path.join(temp, 'config.js'), 'const key = process.env.WECOM_APP_SECRET;');
    const result = spawnSync(process.execPath, ['scripts/check-secrets.js', '--staged'], { cwd: temp, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /literal-config/);
    assert.equal(result.stderr.includes(fakeValue), false);
  } finally {
    if (!path.resolve(temp).startsWith(tempRoot + path.sep)) throw new Error('Unexpected test directory');
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('空白模板及指定离线占位符允许，真实值不会因位于测试目录而豁免', () => {
  assert.deepEqual(inspectFile('.env.example', 'WECOM_' + 'APP_SECRET=\n'), []);
  assert.deepEqual(inspectFile('tests/mock.js', 'WECOM_' + 'APP_SECRET: "secret"'), []);
  assert.ok(inspectFile('tests/mock.js', 'WECOM_' + 'APP_SECRET: "' + 'z'.repeat(40) + '"').length);
  assert.deepEqual(inspectFile('index.js', 'const key = process.env.WECOM_APP_SECRET;'), []);
});
