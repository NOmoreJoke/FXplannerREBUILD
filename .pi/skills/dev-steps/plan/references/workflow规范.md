# Workflow 创建规范

> 本文件是 dispatch skill 的引用规范，非独立 skill。

# 指令

根据用户提供的任务描述和参考文档，创建一个高质量的 Workflow 脚本。

## 必须遵守的规范

### 1. Subagent Prompt 结构（每个 agent 都要有）

```
你的任务：[具体任务描述]

## 执行步骤（必须全部完成）

1. [具体操作，明确工具名]（如：用 Write 工具创建 xxx.ts）
2. [具体操作]
3. [验证步骤]（如：用 Bash 执行 ls -la xxx.ts 确认文件存在）
4. 返回 JSON（见下方格式）

## 不接受的行为

- ❌ [明确列出什么行为不算完成]
- ❌ 只返回文件路径但没有调用工具
- ❌ 验证命令没有真实执行

## 返回 JSON 格式

{
  "status": "ok|failed",
  [任务相关字段],
  "verificationCommand": "[执行了什么验证命令]",
  "verificationOutput": "[验证命令的实际输出，必须贴原文]",
  [验证结果布尔字段]: true|false,
  "notes": "关键决策或失败原因"
}

验证标准：[明确什么算验证通过]
```

### 2. Schema 强制（每个 agent 调用都要加）

```javascript
const result = await agent('...', {
  label: '任务名',
  phase: '阶段名',
  schema: {
    type: 'object',
    properties: {
      status: { enum: ['ok', 'failed'] },
      verificationCommand: { type: 'string' },
      verificationOutput: { type: 'string' },
      [验证结果字段]: { type: 'boolean' },
    },
    required: ['status', 'verificationCommand', 'verificationOutput', ...]
  }
});
```

### 3. 汇聚节点检查（不信任前面的报告）

```javascript
phase('验收汇总')

// 真实检查产出，不盲信 JSON
log('检查各线产出...');

// 示例：检查文件是否真的存在
if (resA && resA.allFilesExist === false) {
  log('⚠️ 线A 报告文件创建失败');
}

// 可以用 Bash 再次验证关键产出
const verify = await agent(`
  用 Bash 真实检查：
  1. ls [关键文件]
  2. [其他验证命令]
  返回 { verified: true/false, output: "..." }
`, { schema: ... });

const finalReport = await agent(`
  汇总各线结果：
  - 线A: ${resA?.status} (验证结果: ${resA?.验证字段})
  - 线B: ...
  
  如实汇报：成功的任务、失败的任务、需要手动补充的任务
  不要掩盖失败。
`, ...);
```

---

## 执行流程

### 步骤 1：理解任务

询问用户（如果不清楚）：
- 任务拆分方式（并行/串行/pipeline）
- 参考文档路径
- 验证标准（什么算成功）

### 步骤 2：设计结构

```javascript
export const meta = {
  name: '任务名-kebab-case',
  description: '一句话描述',
  phases: [
    { title: '阶段1', detail: '简述' },
    { title: '阶段2', detail: '简述' },
  ],
}

// 共享上下文
const SHARED = `
# 工作目录
[绝对路径]

# 任务背景
[简述]

# 参考文档
[文档路径列表]

# 返回格式（JSON 字符串）
{ "status": "ok|failed", ... }
`

phase('阶段1')
const [resA, resB] = await parallel([
  () => agent(`${SHARED} + 线A具体 prompt`, { schema: ... }),
  () => agent(`${SHARED} + 线B具体 prompt`, { schema: ... }),
])

phase('阶段2')
const final = await agent(`${SHARED} + 汇聚 prompt`, ...);

return { A: resA, B: resB, final };
```

### 步骤 3：写每个 subagent 的 prompt

必须包含 4 部分（见上方「Subagent Prompt 结构」）：
1. 执行步骤（明确工具调用）
2. 不接受的行为
3. 返回 JSON 格式（含验证字段）
4. 验证标准

### 步骤 4：加 schema 强制

每个 agent() 调用都加 schema 参数，强制返回包含验证字段。

### 步骤 5：汇聚检查

不信任前面线的报告，真实检查关键产出。

---

## 示例（供参考）

### 场景：补全 3 个测试文件

```javascript
export const meta = {
  name: 'supplement-tests',
  description: '补全缺失的测试文件并验证',
  phases: [
    { title: '并行补测试', detail: '线A单测 ∥ 线B接口测试 ∥ 线C E2E' },
    { title: '验收', detail: '检查产出 + 执行测试 + 生成报告' },
  ],
}

const WT = '/path/to/worktree'
const SHARED = `
# 工作目录
${WT}

# 任务背景
补全缺失的测试文件

# 返回格式
{ "status": "ok|failed", "filesCreated": [...], "verificationOutput": "...", "allFilesExist": true|false }
`

phase('并行补测试')
const [resA, resB, resC] = await parallel([
  () => agent(`${SHARED}

你的任务：创建后端单元测试文件

## 执行步骤

1. 用 Write 工具创建 services/chat/test/xxx.spec.ts（含 5 个测试用例）
2. 用 Write 工具创建 services/chat/test/yyy.spec.ts（含 3 个测试用例）
3. 用 Bash 验证文件存在：cd ${WT} && ls -la services/chat/test/xxx.spec.ts services/chat/test/yyy.spec.ts
4. 返回 JSON

## 不接受的行为

- ❌ 只返回文件路径但没有调用 Write 工具
- ❌ Write 调用失败但仍报告 status: "ok"
- ❌ 验证命令没有真实执行

## 返回 JSON 格式

{
  "status": "ok|failed",
  "filesCreated": ["绝对路径列表"],
  "verificationCommand": "ls -la ...",
  "verificationOutput": "<实际执行 ls 的输出，必须贴原文>",
  "allFilesExist": true|false,
  "notes": "关键决策或失败原因"
}

验证标准：verificationOutput 必须显示 2 个 .spec.ts 文件。
`, {
    label: '线A-单测',
    phase: '并行补测试',
    schema: {
      type: 'object',
      properties: {
        status: { enum: ['ok', 'failed'] },
        filesCreated: { type: 'array' },
        verificationCommand: { type: 'string' },
        verificationOutput: { type: 'string' },
        allFilesExist: { type: 'boolean' },
      },
      required: ['status', 'filesCreated', 'verificationOutput', 'allFilesExist'],
    }
  }),
  
  // 线B、线C 类似结构...
])

phase('验收')

// 检查各线产出
log('检查线A产出...');
if (!resA || resA.allFilesExist === false) {
  log('⚠️ 线A 文件创建失败');
}

const final = await agent(`
  各线结果：
  - 线A: ${resA?.status}, filesCreated: ${resA?.filesCreated?.length ?? 0}, 验证: ${resA?.allFilesExist}
  - 线B: ...
  - 线C: ...
  
  用 Bash 真实检查所有测试文件是否存在。
  
  如实汇报：
  - 成功创建的文件（X 个）
  - 创建失败的文件（Y 个）+ 原因
  - 需要手动补充的任务
  
  不要掩盖失败。
`, { schema: ... });

return { A: resA, B: resB, C: resC, final };
```

---

## 检查清单（生成 Workflow 后自检）

- [ ] 每个 agent prompt 有「执行步骤」（明确工具调用）
- [ ] 每个 agent prompt 有「不接受的行为」
- [ ] 每个 agent 返回格式包含 verificationCommand / verificationOutput / 验证结果布尔字段
- [ ] 每个 agent() 调用有 schema 参数强制验证字段
- [ ] 汇聚节点检查前面线的验证结果，不盲信
- [ ] 汇聚节点如实汇报成功/失败，不掩盖问题

---

## 输出

直接调用 Workflow 工具，传入生成的脚本。

提示用户：「Workflow 已启动（Run ID: xxx），完成后会通知你。用 /workflows 看进度。」
