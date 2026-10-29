import { describe, expect, it } from 'vitest';
import {
  exclusionRule,
  MAX_SEND_BYTES,
  sensitiveContentRule,
  sensitivePathRule,
  sensitiveRule,
  unsendableContentRule,
} from './sensitive.js';

describe('敏感文件规则', () => {
  it.each([
    ['.env', 'dotenv'],
    ['apps/api/.env.local', 'dotenv'],
    ['certs/server.pem', 'pem'],
    ['home/.ssh/id_rsa', 'ssh-key'],
    ['id_ed25519.pub', 'ssh-key'],
    ['tls/server.KEY', 'key-file'],
    ['tls/ca.crt', 'certificate'],
    ['a/b.p12', 'keystore'],
    ['b.pfx', 'keystore'],
    ['android/release.jks', 'keystore'],
    ['.npmrc', 'npmrc'],
    ['.netrc', 'netrc'],
    ['credentials', 'credentials-file'],
    ['home/.aws/credentials', 'credentials-file'],
    ['.git-credentials', 'credentials-file'],
    ['config/gcp-credentials.json', 'credentials-file'],
    ['config/secrets.yml', 'secrets-file'],
    ['secrets.json', 'secrets-file'],
    ['deploy/secrets.enc.yaml', 'secrets-file'],
  ])('路径 %s → %s', (p, id) => expect(sensitivePathRule(p)).toBe(id));
  it('普通文件不命中', () => {
    for (const p of [
      'src/credentials.ts',
      'src/my-secrets-util.ts',
      'src/env.ts',
      'src/keys.ts',
      'README.md',
      'environment.d.ts',
      'src/monkey.ts',
    ])
      expect(sensitivePathRule(p)).toBeNull();
  });
  it.each([
    ['-----BEGIN PRIVATE KEY-----\nMIIFAKE\n', 'private-key-block'],
    ['-----BEGIN RSA PRIVATE KEY-----', 'private-key-block'],
    ['-----BEGIN OPENSSH PRIVATE KEY-----', 'private-key-block'],
    ["const id = 'AKIAFAKEFAKEFAKE0000';", 'aws-access-key-id'],
    ['token=ghp_FAKEFAKEFAKEFAKEFAKEFAKE0000', 'github-token'],
    ['github_pat_FAKE_FAKEFAKEFAKEFAKEFAKE00', 'github-token'],
    ['OPENAI=sk-FAKEFAKEFAKEFAKEFAKE0000', 'openai-style-key'],
    ['STRIPE=sk_test_FAKEFAKEFAKEFAKE0000', 'stripe-secret-key'],
    ['//registry.npmjs.org/:_authToken=FAKE-0000', 'npm-auth-token'],
    ['_authToken = FAKE0000', 'npm-auth-token'],
    ['NPM=npm_' + 'F'.repeat(36), 'npm-token'],
    ['Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.FAKEFAKEFAKEsig', 'jwt'],
  ])('内容 %s → %s', (c, id) => expect(sensitiveContentRule(c)).toBe(id));
  it('普通代码不误报', () => {
    for (const c of [
      'export const AKIA = 1;',
      "const skip = 'sk-short';",
      '// BEGIN PUBLIC KEY',
      'const ask = task-runner;',
      '//registry.npmjs.org/:_authToken=${NPM_TOKEN}',
      'this._authToken = token;',
      "const npm_version = 'npm_short';",
      "const s = 'eyJ.eyJ.x';",
    ])
      expect(sensitiveContentRule(c)).toBeNull();
  });
  it('sensitiveRule:路径优先,content=null 只看路径', () => {
    expect(sensitiveRule('.env', null)).toBe('dotenv');
    expect(sensitiveRule('src/a.ts', null)).toBeNull();
    expect(sensitiveRule('src/a.ts', 'x AKIAFAKEFAKEFAKE0000')).toBe('aws-access-key-id');
  });
});

describe('超限 / 二进制内容', () => {
  it('超过 MAX_SEND_BYTES → too-large;含 NUL → binary;普通文本 null', () => {
    expect(unsendableContentRule('a'.repeat(MAX_SEND_BYTES + 1))).toBe('too-large');
    expect(unsendableContentRule('a'.repeat(MAX_SEND_BYTES))).toBeNull();
    // 多字节字符按 UTF-8 字节数算
    expect(unsendableContentRule('中'.repeat(Math.ceil(MAX_SEND_BYTES / 3) + 1))).toBe('too-large');
    expect(unsendableContentRule('PNG\u0000\u0001')).toBe('binary');
    expect(unsendableContentRule('export const a = 1;')).toBeNull();
  });
  it('exclusionRule:敏感优先,其次体积/二进制;content=null 只看路径', () => {
    expect(exclusionRule('.env', 'x\u0000')).toBe('dotenv');
    expect(exclusionRule('src/a.ts', 'x\u0000')).toBe('binary');
    expect(exclusionRule('src/a.ts', null)).toBeNull();
    expect(exclusionRule('src/a.ts', 'ok')).toBeNull();
  });
});
