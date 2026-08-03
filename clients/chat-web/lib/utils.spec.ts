import { describe, it, expect } from 'vitest';
import { cn } from './utils';

/**
 * 单元测试示例 ↔ lib/utils.ts
 * 约定：工具函数/hooks 的测试与源码同目录，命名 <被测文件>.test.ts
 */
describe('cn（className 合并工具）', () => {
  it('应该合并多个类名', () => {
    expect(cn('px-4', 'py-2')).toBe('px-4 py-2');
  });

  it('应该处理条件类名', () => {
    expect(cn('base', false && 'hidden', 'visible')).toBe('base visible');
  });

  it('冲突的 Tailwind 类应以后者为准', () => {
    expect(cn('px-4', 'px-8')).toBe('px-8');
  });

  it('空输入应该返回空字符串', () => {
    expect(cn()).toBe('');
  });
});
