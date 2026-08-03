// template-review: 多视角评审 dev-steps 模板（规格/方案），输出重构建议
// 5 个视角并行独立评审 → 汇聚对比共识/分歧 → 输出重构报告

export const meta = {
	name: 'template-review',
	description: '多视角评审 dev-steps 模板（规格/方案），输出精简不缺重点的重构建议',
	phases: [
		{ title: '并行评审', detail: '5 个视角独立读模板并产出问题清单' },
		{ title: '汇聚', detail: '对比各视角，输出共识/分歧/重构建议' },
	],
}

const FILES = [
	'.pi/skills/dev-steps/discuss/SKILL.md',
	'.pi/skills/dev-steps/discuss/templates/规格.md',
	'.pi/skills/dev-steps/plan/SKILL.md',
	'.pi/skills/dev-steps/plan/templates/解决方案.md',
]

const SHARED = `
# 背景

项目 .pi/skills/dev-steps/ 下的 skill 模板驱动「需求讨论 → 技术方案 → 执行」的开发流程：

- discuss/templates/规格.md：业务视角，写「要什么、怎么算成」（模块能力、场景与验收路径）
- plan/templates/解决方案.md：技术视角，写「怎么做、怎么测」（架构、文件变更、测试设计）

用户要重构模板，目标：**精简但不缺关键重点；两个模板边界不重叠**。

# 必读文件（先用 Read 工具逐个读完再评审，未读文件就下结论 = 不合格）

${FILES.map((f) => '- ' + f).join('\n')}

# 返回 JSON

{
  "status": "ok",
  "problems": [{ "file": "文件路径", "issue": "具体问题（含位置）", "severity": "高|中|低" }],
  "suggestions": ["具体的修改建议"],
  "summary": "一段话总结你的评审结论"
}
`

const PERSPECTIVES = [
	{ id: '业务需求', focus: '规格模板能否把需求说清楚：模块、场景、验收是否够用；有没有遗漏的关键业务信息' },
	{ id: '技术实现', focus: '方案模板给的信息是否足够落地：架构、文件变更、异常降级；有没有写实现时才发现缺的信息' },
	{ id: '测试验收', focus: '验收路径与测试设计是否可执行、可判定；单元/接口/集成三层划分是否合理' },
	{ id: '简洁可维护', focus: '是否有冗余、重叠（特别是两个模板之间）；哪些内容可以砍而不损失关键信息' },
	{ id: 'AI执行者', focus: '模板作为给 LLM 的指令是否明确无歧义；哪些写法容易被 AI 误读、敷衍或跑偏' },
]

phase('并行评审')
const results = await parallel(
	PERSPECTIVES.map((p) => () =>
		agent(
			`${SHARED}

你的视角：${p.id}
关注点：${p.focus}

要求：
1. 先用 Read 工具读完所有必读文件
2. 只从你的视角评审，不越界
3. 问题要具体到文件和位置，禁止泛泛而谈
4. 返回 JSON`,
			{
				label: `评审-${p.id}`,
				phase: '并行评审',
				schema: {
					type: 'object',
					properties: {
						status: { enum: ['ok', 'failed'] },
						problems: { type: 'array' },
						suggestions: { type: 'array' },
						summary: { type: 'string' },
					},
					required: ['status', 'problems', 'suggestions', 'summary'],
				},
			},
		),
	),
)

// 配对稳定 ID 再过滤；null = 缺失覆盖，如实报告
const coverage = PERSPECTIVES.map((p, i) => ({ id: p.id, res: results[i] }))
for (const c of coverage) {
	if (!c.res) log(`⚠️ 视角 ${c.id} 未返回结果`)
}
const ok = coverage.filter((c) => c.res && c.res.status === 'ok')

phase('汇聚')
const report = await agent(
	`以下是 ${ok.length} 个视角对 dev-steps 模板的独立评审结果：

${ok
	.map(
		(c) => `## ${c.id}视角
总结：${c.res.summary}
问题：${JSON.stringify(c.res.problems)}
建议：${JSON.stringify(c.res.suggestions)}`,
	)
	.join('\n\n')}

请汇聚输出一份中文重构报告，结构：

1. **共识问题**：多视角都指出的，按严重度排序
2. **分歧点**：视角间冲突的建议，给出你的裁决和理由
3. **重构建议清单**：具体到文件，每条标注「必改/建议改/可选」
4. **总体判断**：一句话评价当前模板离「精简但不缺重点」有多远

如实汇报，不掩盖问题，不粉饰结论。`,
	{ label: '汇聚', phase: '汇聚' },
)

return {
	perspectives: ok.map((c) => ({ id: c.id, ...c.res })),
	missing: coverage.filter((c) => !c.res).map((c) => c.id),
	report,
}
