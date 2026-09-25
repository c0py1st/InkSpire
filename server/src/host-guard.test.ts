import { describe, expect, it } from 'vitest';
import { isAllowedHost } from './host-guard';

describe('isAllowedHost（DNS rebinding 防线）', () => {
  it('放行指向本机端口的三种写法', () => {
    expect(isAllowedHost('127.0.0.1:8787', 8787)).toBe(true);
    expect(isAllowedHost('localhost:8787', 8787)).toBe(true);
    expect(isAllowedHost('[::1]:8787', 8787)).toBe(true);
  });
  it('大小写与首尾空白不成为绕过口', () => {
    expect(isAllowedHost('LocalHost:8787', 8787)).toBe(true);
    expect(isAllowedHost(' 127.0.0.1:8787 ', 8787)).toBe(true);
  });
  it('拒绝外域、IP 伪装与端口错位', () => {
    expect(isAllowedHost('evil.example.com:8787', 8787)).toBe(false);
    expect(isAllowedHost('attacker.io.127.0.0.1.nip.io:8787', 8787)).toBe(false);
    expect(isAllowedHost('127.0.0.1', 8787)).toBe(false);
    expect(isAllowedHost('127.0.0.1:9999', 8787)).toBe(false);
    expect(isAllowedHost('127.0.0.1.evil.com:8787', 8787)).toBe(false);
    expect(isAllowedHost(undefined, 8787)).toBe(false);
  });
});
