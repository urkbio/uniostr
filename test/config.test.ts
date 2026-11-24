import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ConfigError, loadConfig } from '../src/config/config.js';

const BASE_CONFIG = {
  host: '127.0.0.1',
  port: 7777,
  database: './data/relay.db',
  logLevel: 'info',
};

function writeConfig(content: Record<string, unknown>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'uniostr-config-'));
  const file = path.join(dir, 'config.json');
  writeFileSync(file, JSON.stringify(content), 'utf8');
  return file;
}

test('新字段缺省时取默认值', () => {
  const config = loadConfig(writeConfig(BASE_CONFIG));

  assert.equal(config.remoteRelay, '');
  assert.deepEqual(config.allowedPubkeys, []);
  assert.equal(config.requireAuth, false);
});

test('remoteRelay 接受 ws/wss 地址并拒绝非法地址', () => {
  const accepted = loadConfig(writeConfig({ ...BASE_CONFIG, remoteRelay: 'wss://relay.example.com' }));
  assert.equal(accepted.remoteRelay, 'wss://relay.example.com');

  assert.throws(
    () => loadConfig(writeConfig({ ...BASE_CONFIG, remoteRelay: 'https://relay.example.com' })),
    ConfigError,
  );
  assert.throws(() => loadConfig(writeConfig({ ...BASE_CONFIG, remoteRelay: 'not-a-url' })), ConfigError);
  assert.throws(() => loadConfig(writeConfig({ ...BASE_CONFIG, remoteRelay: 123 })), ConfigError);
});

test('allowedPubkeys 非法格式被拒绝', () => {
  assert.throws(
    () => loadConfig(writeConfig({ ...BASE_CONFIG, allowedPubkeys: ['abc'] })),
    ConfigError,
  );
});
