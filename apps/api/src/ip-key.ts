import { isIPv4, isIPv6 } from 'node:net';

/**
 * 限流计数用的 IP 键:IPv4 原样;IPv6 按 /64 前缀(展开后前 4 组 + `::/64`);
 * IPv4-mapped(`::ffff:a.b.c.d`)按 IPv4 处理。zone id(`%eth0`)去掉。
 * 提交限流与问答限流共用。
 */
export function ipKey(ip: string): string {
  const bare = ip.trim().split('%')[0] ?? '';
  if (!bare) return ip;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(bare);
  if (mapped) return mapped[1]!;
  if (isIPv4(bare)) return bare;
  if (!isIPv6(bare)) return bare;
  const groups = expandIPv6(bare);
  return `${groups.slice(0, 4).join(':')}::/64`;
}

/** 展开为 8 个 4 位小写十六进制组(无缩写) */
function expandIPv6(ip: string): string[] {
  const lower = ip.toLowerCase();
  const [head = '', tail = ''] = lower.split('::');
  const hp = head ? head.split(':') : [];
  const tp = tail ? tail.split(':') : [];
  const mid = Array.from({ length: 8 - hp.length - tp.length }, () => '0');
  return [...hp, ...mid, ...tp].map((g) => g.padStart(4, '0'));
}
