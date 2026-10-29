import { describe, expect, it } from 'vitest';
import { sensitiveContentRule, sensitivePathRule, sensitiveRule } from './sensitive.js';

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
  ])('路径 %s → %s', (p, id) => expect(sensitivePathRule(p)).toBe(id));
  it('普通文件不命中', () => {
    for (const p of ['src/env.ts', 'src/keys.ts', 'README.md', 'environment.d.ts', 'src/monkey.ts'])
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
  ])('内容 %s → %s', (c, id) => expect(sensitiveContentRule(c)).toBe(id));
  it('普通代码不误报', () => {
    for (const c of [
      'export const AKIA = 1;',
      "const skip = 'sk-short';",
      '// BEGIN PUBLIC KEY',
      'const ask = task-runner;',
    ])
      expect(sensitiveContentRule(c)).toBeNull();
  });
  it('sensitiveRule:路径优先,content=null 只看路径', () => {
    expect(sensitiveRule('.env', null)).toBe('dotenv');
    expect(sensitiveRule('src/a.ts', null)).toBeNull();
    expect(sensitiveRule('src/a.ts', 'x AKIAFAKEFAKEFAKE0000')).toBe('aws-access-key-id');
  });
});
