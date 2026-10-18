import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'bin', 'safe-load-lab.js');

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8' });
}

test('prints version', () => {
  const res = run(['version']);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /^\d+\.\d+\.\d+/);
});

test('validates basic config', () => {
  const res = run(['validate', '--config', 'examples/basic.json']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Config is valid/);
});

test('requires ownership flag for run', () => {
  const res = run(['run', '--url', 'http://localhost:1']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Missing required safety flag/);
});

test('plans advanced local config', () => {
  const res = run(['plan', '--config', 'examples/advanced.json', '--env', 'local']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Stages:/);
  assert.match(res.stdout, /graphql-viewer/);
});

test('prints help with ab, mock, and import-curl commands', () => {
  const res = run(['help']);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /ab, diff/);
  assert.match(res.stdout, /mock/);
  assert.match(res.stdout, /import-curl/);
});

