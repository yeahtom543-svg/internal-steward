const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const rules = [
  ['model-key', /\bsk-[A-Za-z0-9_-]{20,}\b/g],
  ['tencent-access-id', /\bAKID[A-Za-z0-9]{16,}\b/g],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,})\b/g],
  ['wecom-identifier', /\bww[a-fA-F0-9]{12,}\b/g],
  ['push-credential', /\b(?:AT_|UID_)[A-Za-z0-9]{16,}\b/g],
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ['credential-url', /https:\/\/(?:api\.day\.app\/[A-Za-z0-9_-]{12,}|[^\s"'<>]+[?&](?:access_token|corpsecret|secret|api_key|token)=[A-Za-z0-9_-]{12,})/g],
];
const configAssignment = /(?:^\s*|[,{]\s*)(?:const\s+|let\s+|var\s+)?["']?(WECOM_(?:APP_SECRET|TOKEN|AES_KEY|AGENT_ID|CORP_ID|TO_USER)|(?:DEEPSEEK|GLM|AI)_API_KEY|COS_(?:SECRET_ID|SECRET_KEY)|BARK_KEY|WXPUSHER_(?:TOKEN|UID))\s*["']?\s*[:=]\s*(["'])([^"'\r\n]+)\2/gm;
const fixtures = new Set(['fake', 'offline-test-key', 'custom-test-key', 'legacy-key', 'test', 'mock-token', 'secret', 'corp', 'member', 'creator', '1', '1000002']);

function inspectFile(file, content) {
  const name = file.replace(/\\/g, '/');
  const hits = [];
  if (/(?:^|\/)(?:\.env(?:\..*)?|state\.json|schedule\.json|assistant_config\.json|credentials[^/]*|secrets[^/]*|node_modules|\.git)(?:\/|$)/i.test(name) && name !== '.env.example') hits.push('forbidden-file');
  if (/\.(?:png|jpe?g|gif|webp|zip|xml|ics|pem|key|p12|pfx|log)$/i.test(name)) hits.push('private-artifact');
  if (Buffer.byteLength(content) > 1000000 || content.includes('\0')) hits.push('binary-or-large-file');
  for (const [label, pattern] of rules) {
    pattern.lastIndex = 0;
    if (pattern.test(content)) hits.push(label);
  }
  configAssignment.lastIndex = 0;
  for (const match of content.matchAll(configAssignment)) {
    const value = match[3];
    if (!value || /^<[^>]+>$/.test(value)) continue;
    if (name.startsWith('tests/') && fixtures.has(value)) continue;
    hits.push('literal-config:' + match[1]);
  }
  return [...new Set(hits)];
}
function git(args) { return execFileSync('git', args, { cwd: root, maxBuffer: 8 * 1024 * 1024 }); }
function check(staged) {
  const args = staged ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'] : ['ls-files', '--cached', '--others', '--exclude-standard', '-z'];
  const files = [...new Set(git(args).toString().split('\0').filter(Boolean))];
  let failed = false;
  for (const file of files) {
    const full = path.resolve(root, file);
    if (!full.startsWith(root + path.sep)) throw new Error('File outside repository');
    if (!staged && fs.lstatSync(full).isSymbolicLink()) throw new Error('Symbolic links are not allowed in the source release.');
    const bytes = staged ? git(['show', ':' + file]) : fs.readFileSync(full);
    for (const rule of inspectFile(file, bytes.toString('utf8'))) {
      console.error(file + ': ' + rule);
      failed = true;
    }
  }
  if (failed) throw new Error('Sensitive content detected; upload stopped. Matching values are not printed.');
  console.log('Secret guard passed: ' + files.length + ' files (' + (staged ? 'staged' : 'working tree') + ').');
}
if (require.main === module) {
  try { check(process.argv.includes('--staged')); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { inspectFile };
