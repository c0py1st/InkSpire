import { describe, expect, it } from 'vitest';
import type { AppConfig, ProviderProfile } from '../../shared/src/types';
import { maskConfig, mergeKeys } from './config';

const prov = (id: string, apiKey: string, extra: Partial<ProviderProfile> = {}): ProviderProfile => ({
  id, name: id, baseURL: 'https://x.test/v1', apiKey, model: 'm', ...extra,
});
const cfg = (providers: ProviderProfile[], mockMode = false): AppConfig => ({
  providers, creativeId: providers[0]?.id ?? null, assistId: null, mockMode,
});

describe('maskConfig（出网脱敏）', () => {
  it('密钥一律置空，只留 hasKey 标志', () => {
    const out = maskConfig(cfg([prov('a', 'sk-secret'), prov('b', '   ')]));
    expect(out.providers[0].apiKey).toBe('');
    expect(out.providers[0].hasKey).toBe(true);
    expect(out.providers[1].apiKey).toBe('');
    expect(out.providers[1].hasKey).toBe(false);
  });
  it('非密钥字段原样保留', () => {
    const out = maskConfig(cfg([prov('a', 'k', { temperature: 0.7 })], true));
    expect(out.providers[0].temperature).toBe(0.7);
    expect(out.creativeId).toBe('a');
    expect(out.mockMode).toBe(true);
  });
});

describe('mergeKeys（入网按 id 认领已存密钥）', () => {
  const stored = cfg([prov('a', 'sk-real'), prov('b', 'sk-b')]);
  it('留空 = 保持已存密钥（界面脱敏后保存不能丢 Key）', () => {
    const incoming = cfg([prov('a', '', { hasKey: true, name: '改名了' })]);
    const out = mergeKeys(incoming, stored);
    expect(out.providers[0].apiKey).toBe('sk-real');
    expect(out.providers[0].name).toBe('改名了');
  });
  it('输入新值 = 覆盖', () => {
    const out = mergeKeys(cfg([prov('a', 'sk-new')]), stored);
    expect(out.providers[0].apiKey).toBe('sk-new');
  });
  it('新 id 留空 = 保持为空', () => {
    const out = mergeKeys(cfg([prov('a', ''), prov('c', '')]), stored);
    expect(out.providers[1].apiKey).toBe('');
  });
  it('未随体提交的存档项被丢弃（含其密钥）', () => {
    const out = mergeKeys(cfg([prov('a', '')]), stored);
    expect(out.providers).toHaveLength(1);
    expect(out.providers[0].id).toBe('a');
  });
  it('派生字段 hasKey 不落盘', () => {
    const out = mergeKeys(cfg([prov('a', '', { hasKey: true })]), stored);
    expect('hasKey' in out.providers[0]).toBe(false);
  });
  it('mockMode 与槽位原样透传', () => {
    const incoming = { ...cfg([prov('a', '')]), mockMode: true, assistId: 'a' };
    const out = mergeKeys(incoming, stored);
    expect(out.mockMode).toBe(true);
    expect(out.assistId).toBe('a');
  });
});
