import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
const commit = git('rev-parse', 'HEAD');
if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Expected a complete Git commit');
if (git('status', '--porcelain', '--untracked-files=normal')) throw new Error('Release requires a clean checkout');
if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== commit) throw new Error('Checked-out commit differs from workflow provenance');
const output = resolve(root, 'release');
await mkdir(output, { recursive: true });
const artifacts = [];
for (const [name, directory] of [['idea-lab', 'dist'], ['claude-relay', 'claude-gateway/dist']]) {
  const file = name + '-' + commit + '.tar.gz';
  execFileSync('tar', ['-czf', resolve(output, file), '-C', resolve(root, directory), '.'], { cwd: root, stdio: 'inherit', windowsHide: true });
  const content = await readFile(resolve(output, file));
  artifacts.push({ file, bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') });
}
await writeFile(resolve(output, 'provenance.json'), JSON.stringify({ schema: 1, repository: 'edrft99/idea-lab', commit, workflowRun: process.env.GITHUB_RUN_ID || null, published: false, artifacts }, null, 2) + '\n');
console.log('Verified build artifacts packaged; no Site publication performed.');
