import type { UserConfig } from '@commitlint/types';

/**
 * commitlint 配置（方案 §5.3）
 * 规范：Conventional Commits — type(scope): subject
 * 乱写 commit message 会在 commit-msg 钩子被直接拒绝。
 */
const config: UserConfig = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      ['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'build', 'ci', 'chore', 'revert'],
    ],
    'subject-max-length': [2, 'always', 100],
    // 中文提交信息不适用英文大小写规则
    'subject-case': [0],
  },
};

export default config;
