import { readdir, readFile, lstat } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Conservative release hygiene, not a formal DLP or security certification.
// Scan ignored candidates too: an ignore rule does not sanitize a future commit.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const candidates = new Set();
const report = (path, rule, line) => problems.push(`${path}${line ? ':' + line : ''}: ${rule}`);
const unix = path => path.split(sep).join('/');
const sensitiveName = /(?:^|\/)(?:\.env(?:\..*)?|[^/]*(?:credentials?|secrets?|launch[-_]url|verify[-_]gui)[^/]*|id_(?:rsa|ed25519))(?:$|\/)/i;
const media = /\.(?:wav|wave|mp3|mp4|m4a|aac|flac|ogg|opus|webm|png|jpe?g|gif|webp|bmp|ico|pdf|zip|tgz|gz|tar|7z|sqlite|db|pem|p12|pfx|key)$/i;
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const path = resolve(directory, entry.name);
    const name = unix(relative(root, path));
    if (entry.isSymbolicLink()) { report(name, 'symbolic link requires explicit review'); continue; }
    if (sensitiveName.test(name)) report(name, 'sensitive filename');
    if (entry.isDirectory()) await walk(path);
    else if (entry.isFile()) candidates.add(name);
    else report(name, 'unexpected filesystem entry');
  }
}
function privateV4(address) {
  const bytes = address.split('.').map(Number);
  if (bytes.some(n => n > 255)) return false;
  const [a, b] = bytes;
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || a >= 224;
}
const rules = [
  ['host-specific absolute path', /(?:^|[\s"'`(=])(?:\/(?:home|root|var|opt|etc|run|usr|Users|Volumes|private|tmp)\/|[A-Za-z]:[\\/]|\\\\[A-Za-z0-9])/gm],
  ['private DNS suffix', /\b(?:[a-z0-9-]+\.)+(?:internal|local|lan|corp|intranet|home)\b/gi],
  ['private IPv6 address', /(?:\[|\s|["'])(?:::1\b|(?:f[cd][0-9a-f]{2}|fe[89ab][0-9a-f]):[0-9a-f:]+)/gi],
  ['PEM key or certificate', /-----BEGIN (?:[A-Z]+ )*(?:PRIVATE KEY|CERTIFICATE)-----/g],
  ['credential assignment', /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|password|passwd|secret)\b["']?\s*[:=]\s*["'`][^"'`\r\n]{8,}["'`]/gi],
  ['bearer credential', /\bBearer\s+[A-Za-z0-9_~+/.=-]{12,}/g],
  ['provider token signature', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|sk-[A-Za-z0-9]{24,})\b/g],
  ['JWT-like credential', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g],
  ['legacy backend identity', /q\u0077en/i],
];
// Only these literal public/test URL hosts are expected in this small project.
// A new URL needs review, not an automatic broad exception for its entire file.
const allowedUrlHosts = new Set(['github.com', 'registry.npmjs.org', 'dictation.test', 'www.w3.org', 'opencollective.com', 'asr.example.com', 'example.com', 'localhost']);
async function scan(name) {
  const path = resolve(root, name);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) { report(name, 'package entry is not a regular file'); return; }
  if (sensitiveName.test(name)) report(name, 'sensitive filename');
  if (media.test(name) || (/\.svg$/i.test(name) && name !== 'icon.svg')) report(name, 'binary/media/archive requires provenance review');
  const bytes = await readFile(path);
  if (bytes.includes(0)) { report(name, 'binary content is not allowed'); return; }
  const text = bytes.toString('utf8');
  if (text.includes('\ufffd')) report(name, 'non-UTF-8 or replacement characters require review');
  for (const [label, pattern] of rules) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern.global ? pattern : new RegExp(pattern.source, pattern.flags + 'g'))) {
      report(name, label, text.slice(0, match.index).split('\n').length);
    }
  }
  for (const match of text.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)) {
    if (privateV4(match[0])) report(name, 'private/reserved IPv4 address', text.slice(0, match.index).split('\n').length);
  }
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'`\\)\]}]+/g)) {
    try {
      const url = new URL(match[0]);
      const line = text.slice(0, match.index).split('\n').length;
      if (url.username || url.password) report(name, 'URL contains credentials', line);
      if (!allowedUrlHosts.has(url.hostname)) report(name, 'URL host needs public-release review', line);
      if ([...url.searchParams.keys()].some(key => /token|secret|password|auth|key/i.test(key))) report(name, 'credential-like URL query', line);
    } catch { report(name, 'malformed literal URL requires review', text.slice(0, match.index).split('\n').length); }
  }
}
await walk(root);
const required = ['README.md', 'SECURITY.md', 'CONTRIBUTING.md', 'THIRD_PARTY_NOTICES.md', 'client.js'];
for (const name of required) if (!candidates.has(name)) report(name, 'required release file is missing; build first');
// Lifecycle scripts MUST be suppressed: prepack itself invokes this checker.
const pack = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
let packageFiles = [];
if (pack.error || pack.status !== 0) report('package.json', 'npm package dry-run failed; inspect npm diagnostics separately');
else {
  try {
    const result = JSON.parse(pack.stdout);
    packageFiles = result[0].files.map(file => file.path);
    for (const name of packageFiles) {
      if (name.startsWith('/') || name.split(/[\\/]/).includes('..')) { report('package.json', 'unsafe package path'); continue; }
      candidates.add(name);
    }
    for (const name of ['client.js', 'THIRD_PARTY_NOTICES.md']) if (!packageFiles.includes(name)) report(name, 'required file missing from npm package');
  } catch { report('package.json', 'unexpected npm package dry-run output'); }
}
for (const name of [...candidates].sort()) await scan(name);
const unique = [...new Set(problems)];
if (unique.length) {
  console.error('Potential public-release leaks or review items (matched values are intentionally omitted):');
  for (const issue of unique) console.error(' - ' + issue);
  process.exitCode = 1;
} else {
  console.log(`Public-content heuristic check passed: ${candidates.size} candidate files, ${packageFiles.length} package entries.`);
  console.log('Manual review and owner authorization are still required; this is not a formal DLP guarantee.');
}
