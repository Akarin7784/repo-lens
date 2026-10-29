import { describe, expect, it } from 'vitest';
import { ipKey } from './ip-key.js';

describe('ipKey(IPv6 /64)', () => {
  it('IPv4 原样返回', () => {
    expect(ipKey('1.2.3.4')).toBe('1.2.3.4');
    expect(ipKey(' 10.0.0.1 ')).toBe('10.0.0.1');
  });
  it('IPv4-mapped 按 IPv4 处理', () => {
    expect(ipKey('::ffff:1.2.3.4')).toBe('1.2.3.4');
    expect(ipKey('::FFFF:10.0.0.9')).toBe('10.0.0.9');
  });
  it('同一 /64 内两个地址共用键,不同 /64 分开', () => {
    const a = ipKey('2001:db8:1:2:aaaa::1');
    const b = ipKey('2001:db8:1:2:bbbb::ffff');
    const c = ipKey('2001:db8:1:3::1');
    expect(a).toBe('2001:0db8:0001:0002::/64');
    expect(b).toBe(a);
    expect(c).toBe('2001:0db8:0001:0003::/64');
    expect(c).not.toBe(a);
  });
  it('压缩写法与展开写法落到同一 /64', () => {
    expect(ipKey('2001:db8::1')).toBe(ipKey('2001:0db8:0000:0000:0000:0000:0000:0001'));
    expect(ipKey('2001:db8::1')).toBe('2001:0db8:0000:0000::/64');
  });
  it('去掉 zone id', () => {
    expect(ipKey('fe80::1%eth0')).toBe(ipKey('fe80::1'));
  });
});
