#!/usr/bin/env bun
/**
 * 代码地图生成器（最终优化版）
 *
 * 设计原则：
 * 1. 简洁：纯文本缩进，无特殊符号，不会乱码
 * 2. 语义化：中文标记，一目了然
 * 3. 分层：按重要性组织，核心功能优先
 * 4. 多格式：树状文本 + 可折叠HTML + 拆分Markdown
 */

import {
	Project,
	type SourceFile,
	type ClassDeclaration,
	type FunctionDeclaration,
	type InterfaceDeclaration,
	type TypeAliasDeclaration,
} from "ts-morph";
import * as fs from "fs";
import * as path from "path";

// ============= 数据结构 =============

interface SymbolInfo {
	name: string;
	type: "class" | "function" | "interface" | "type";
	description?: string;
	isExported: boolean;
	decorators?: string[];
	params?: string[];
}

interface FileInfo {
	path: string;
	relativePath: string;
	description?: string;
	category: "core" | "helper" | "type" | "test" | "config";
	exports: SymbolInfo[];
}

interface ModuleInfo {
	name: string;
	displayName: string;
	description: string;
	files: FileInfo[];
}

interface ProjectData {
	name: string;
	generatedAt: string;
	modules: ModuleInfo[];
	stats: {
		totalFiles: number;
		totalExports: number;
		moduleCount: number;
	};
}

// ============= 工具函数 =============

/**
 * 提取 JSDoc 描述（只取第一行）
 */
function getDescription(
	node:
		| ClassDeclaration
		| FunctionDeclaration
		| InterfaceDeclaration
		| TypeAliasDeclaration,
): string | undefined {
	const jsDocs = node.getJsDocs();
	if (jsDocs.length > 0) {
		const desc = jsDocs[0].getDescription().trim();
		const firstLine = desc.split("\n")[0];
		return firstLine || undefined;
	}
	return undefined;
}

/**
 * 判断文件类别（按重要性分类）
 */
function categorizeFile(
	filePath: string,
	exports: SymbolInfo[],
): "core" | "helper" | "type" | "test" | "config" {
	// 测试文件
	if (filePath.includes(".spec.") || filePath.includes(".test.")) {
		return "test";
	}

	// 配置文件
	if (filePath.includes("config") || filePath.endsWith(".config.ts")) {
		return "config";
	}

	// 类型定义文件（只有接口和类型，没有逻辑）
	const hasOnlyTypes = exports.every(
		(e) => e.type === "interface" || e.type === "type",
	);
	if (hasOnlyTypes && exports.length > 0) {
		return "type";
	}

	// 辅助工具（包含 utils, helpers, hooks 等）
	if (
		filePath.includes("utils") ||
		filePath.includes("helpers") ||
		filePath.includes("hooks")
	) {
		return "helper";
	}

	// 核心业务逻辑（控制器、服务、主要组件、页面）
	return "core";
}

/**
 * 分析类
 */
function analyzeClass(cls: ClassDeclaration): SymbolInfo {
	return {
		name: cls.getName() || "<anonymous>",
		type: "class",
		description: getDescription(cls),
		isExported: cls.isExported(),
		decorators: cls.getDecorators().map((d) => d.getName()),
	};
}

/**
 * 分析函数
 */
function analyzeFunction(fn: FunctionDeclaration): SymbolInfo {
	return {
		name: fn.getName() || "<anonymous>",
		type: "function",
		description: getDescription(fn),
		isExported: fn.isExported(),
		params: fn.getParameters().map((p) => p.getName()),
	};
}

/**
 * 分析接口
 */
function analyzeInterface(iface: InterfaceDeclaration): SymbolInfo {
	return {
		name: iface.getName(),
		type: "interface",
		description: getDescription(iface),
		isExported: iface.isExported(),
	};
}

/**
 * 分析类型别名
 */
function analyzeTypeAlias(typeAlias: TypeAliasDeclaration): SymbolInfo {
	return {
		name: typeAlias.getName(),
		type: "type",
		description: getDescription(typeAlias),
		isExported: typeAlias.isExported(),
	};
}

/**
 * 分析文件
 */
function analyzeFile(sourceFile: SourceFile, projectRoot: string): FileInfo {
	const filePath = sourceFile.getFilePath();
	const relativePath = path.relative(projectRoot, filePath);

	// 文件描述
	let fileDescription: string | undefined;
	const statements = sourceFile.getStatements();
	if (statements.length > 0) {
		const firstStatement = statements[0];
		const leadingComments = firstStatement.getLeadingCommentRanges();
		if (leadingComments.length > 0) {
			const commentText = leadingComments[0].getText();
			fileDescription = commentText
				.replace(/^\/\*\*|\*\/$/g, "")
				.replace(/^\s*\*\s?/gm, "")
				.trim()
				.split("\n")[0];
		}
	}

	// 收集导出的符号
	const exports: SymbolInfo[] = [];

	sourceFile.getClasses().forEach((cls) => {
		if (cls.isExported()) {
			exports.push(analyzeClass(cls));
		}
	});

	sourceFile.getFunctions().forEach((fn) => {
		if (fn.isExported()) {
			exports.push(analyzeFunction(fn));
		}
	});

	sourceFile.getInterfaces().forEach((iface) => {
		if (iface.isExported()) {
			exports.push(analyzeInterface(iface));
		}
	});

	sourceFile.getTypeAliases().forEach((typeAlias) => {
		if (typeAlias.isExported()) {
			exports.push(analyzeTypeAlias(typeAlias));
		}
	});

	return {
		path: filePath,
		relativePath,
		description: fileDescription,
		category: categorizeFile(relativePath, exports),
		exports,
	};
}

// ============= 主分析流程 =============

async function analyzeProject(): Promise<ProjectData> {
	console.log("🔍 分析项目结构...\n");

	const projectRoot = path.resolve(__dirname, "..");

	const moduleConfigs = [
		{
			name: "clients/chat-web",
			displayName: "前端应用",
			description: "Next.js 前端，包含海报编辑器和 AI 对话",
			tsConfigPath: "clients/chat-web/tsconfig.json",
			sourcePath: "clients/chat-web",
		},
		{
			name: "services/chat",
			displayName: "后端服务",
			description: "NestJS API 服务，AI 对话和图片生成",
			tsConfigPath: "services/chat/tsconfig.json",
			sourcePath: "services/chat/src",
		},
		{
			name: "packages/money",
			displayName: "共享精度库",
			description: "币种常量与金额/汇率精度计算纯函数，前后端共用",
			tsConfigPath: "packages/money/tsconfig.json",
			sourcePath: "packages/money/src",
		},
	];

	const modules: ModuleInfo[] = [];

	for (const config of moduleConfigs) {
		const tsConfigPath = path.join(projectRoot, config.tsConfigPath);
		const sourcePath = path.join(projectRoot, config.sourcePath);

		if (!fs.existsSync(tsConfigPath) || !fs.existsSync(sourcePath)) {
			console.log(`⚠️  跳过：${config.name}`);
			continue;
		}

		console.log(`📂 ${config.displayName}`);

		const project = new Project({
			tsConfigFilePath: tsConfigPath,
			skipAddingFilesFromTsConfig: true,
		});

		project.addSourceFilesAtPaths([
			`${sourcePath}/**/*.ts`,
			`${sourcePath}/**/*.tsx`,
			`!${sourcePath}/**/node_modules/**`,
		]);

		const sourceFiles = project
			.getSourceFiles()
			.filter((sf) => !sf.getFilePath().includes("node_modules"));

		const files: FileInfo[] = sourceFiles
			.map((sf) => analyzeFile(sf, projectRoot))
			.filter((f) => f.exports.length > 0); // 只保留有导出的文件

		console.log(`   找到 ${files.length} 个文件\n`);

		modules.push({
			name: config.name,
			displayName: config.displayName,
			description: config.description,
			files,
		});
	}

	const totalFiles = modules.reduce((sum, m) => sum + m.files.length, 0);
	const totalExports = modules.reduce(
		(sum, m) => sum + m.files.reduce((s, f) => s + f.exports.length, 0),
		0,
	);

	return {
		name: "FXPlanner-new",
		generatedAt: new Date().toISOString(),
		modules,
		stats: {
			totalFiles,
			totalExports,
			moduleCount: modules.length,
		},
	};
}

// ============= 生成简洁树状文本 =============

/**
 * 生成简洁树状文本（纯缩进，中文标记，无特殊符号）
 */
function generateSimpleTree(data: ProjectData, outputDir: string): void {
	let md = `# ${data.name} 项目代码地图\n\n`;
	md += `生成时间：${new Date(data.generatedAt).toLocaleString("zh-CN")}\n\n`;
	md += `## 统计\n\n`;
	md += `模块：${data.stats.moduleCount} 个  \n`;
	md += `文件：${data.stats.totalFiles} 个  \n`;
	md += `导出：${data.stats.totalExports} 个\n\n`;
	md += `---\n\n`;

	data.modules.forEach((module) => {
		md += `## ${module.displayName}\n\n`;
		md += `${module.description}\n\n`;

		// 按类别分组
		const coreFiles = module.files.filter((f) => f.category === "core");
		const helperFiles = module.files.filter((f) => f.category === "helper");
		const typeFiles = module.files.filter((f) => f.category === "type");

		if (coreFiles.length > 0) {
			md += `### 核心功能\n\n`;
			md += renderFilesSimple(coreFiles, module.name);
		}

		if (helperFiles.length > 0) {
			md += `### 辅助工具\n\n`;
			md += renderFilesSimple(helperFiles, module.name);
		}

		if (typeFiles.length > 0) {
			md += `### 类型定义\n\n`;
			md += renderFilesSimple(typeFiles, module.name);
		}

		md += "\n---\n\n";
	});

	const filePath = path.join(outputDir, "tree.md");
	fs.writeFileSync(filePath, md, "utf-8");
	console.log(
		`✅ tree.md (${(fs.statSync(filePath).size / 1024).toFixed(1)} KB)`,
	);
}

/**
 * 渲染文件列表（简洁格式）
 */
function renderFilesSimple(files: FileInfo[], modulePrefix: string): string {
	let result = "";

	// 按目录组织
	const tree = buildSimpleTree(files, modulePrefix);
	result += renderTreeNode(tree, 0);

	return result;
}

interface SimpleTreeNode {
	name: string;
	type: "dir" | "file";
	file?: FileInfo;
	children: Map<string, SimpleTreeNode>;
}

function buildSimpleTree(
	files: FileInfo[],
	modulePrefix: string,
): SimpleTreeNode {
	const root: SimpleTreeNode = { name: "", type: "dir", children: new Map() };

	files.forEach((file) => {
		const relativePath = file.relativePath.replace(modulePrefix + "/", "");
		const parts = relativePath.split("/");
		let current = root;

		parts.forEach((part, index) => {
			if (!current.children.has(part)) {
				current.children.set(part, {
					name: part,
					type: index === parts.length - 1 ? "file" : "dir",
					file: index === parts.length - 1 ? file : undefined,
					children: new Map(),
				});
			}
			current = current.children.get(part)!;
		});
	});

	return root;
}

function renderTreeNode(node: SimpleTreeNode, depth: number): string {
	let result = "";
	const indent = "  ".repeat(depth);
	const entries = Array.from(node.children.entries()).sort(([a], [b]) =>
		a.localeCompare(b),
	);

	entries.forEach(([name, child]) => {
		if (child.type === "dir") {
			result += `${indent}${name}/\n`;
			result += renderTreeNode(child, depth + 1);
		} else if (child.file) {
			const file = child.file;
			result += `${indent}${name}`;
			if (file.description) {
				result += ` - ${file.description}`;
			}
			result += "\n";

			// 列出导出（限制3个）
			if (file.exports.length > 0) {
				const exportsToShow = file.exports.slice(0, 3);
				exportsToShow.forEach((exp) => {
					const typeLabel = getTypeLabel(exp.type);
					const paramStr =
						exp.params && exp.params.length > 0
							? `(${exp.params.join(", ")})`
							: "";
					const decorators =
						exp.decorators && exp.decorators.length > 0
							? ` @${exp.decorators.join(" @")}`
							: "";

					result += `${indent}  ${typeLabel} ${exp.name}${paramStr}${decorators}`;
					if (exp.description) {
						result += ` - ${exp.description}`;
					}
					result += "\n";
				});

				if (file.exports.length > 3) {
					result += `${indent}  ... 还有 ${file.exports.length - 3} 个\n`;
				}
			}
		}
	});

	return result;
}

function getTypeLabel(type: string): string {
	switch (type) {
		case "class":
			return "[类]";
		case "function":
			return "[函数]";
		case "interface":
			return "[接口]";
		case "type":
			return "[类型]";
		default:
			return "[其他]";
	}
}

// ============= 生成可折叠 HTML =============

function generateCollapsibleHTML(data: ProjectData, outputDir: string): void {
	const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${data.name} 代码地图</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      background: #f8f9fa;
      padding: 20px;
      line-height: 1.6;
    }
    .container { max-width: 1200px; margin: 0 auto; }
    header {
      background: white;
      padding: 30px;
      border-radius: 8px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.08);
      margin-bottom: 20px;
    }
    h1 { color: #333; font-size: 28px; margin-bottom: 10px; }
    .stats {
      display: flex;
      gap: 20px;
      color: #666;
      font-size: 14px;
      margin-top: 15px;
    }
    .search {
      margin-bottom: 20px;
      padding: 20px;
      background: white;
      border-radius: 8px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.08);
    }
    .search input {
      width: 100%;
      padding: 12px 16px;
      border: 1px solid #ddd;
      border-radius: 6px;
      font-size: 14px;
    }
    .search input:focus {
      outline: none;
      border-color: #4CAF50;
    }
    .module {
      background: white;
      border-radius: 8px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.08);
      margin-bottom: 20px;
      overflow: hidden;
    }
    .module-header {
      background: #4CAF50;
      color: white;
      padding: 20px;
      cursor: pointer;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .module-header:hover { background: #45a049; }
    .module-header h2 { font-size: 20px; }
    .module-content { padding: 20px; display: none; }
    .module.open .module-content { display: block; }
    .category {
      margin-bottom: 30px;
    }
    .category h3 {
      font-size: 16px;
      color: #4CAF50;
      margin-bottom: 15px;
      padding-bottom: 8px;
      border-bottom: 2px solid #4CAF50;
    }
    .file-tree {
      font-family: "Courier New", Consolas, monospace;
      font-size: 13px;
      line-height: 1.8;
    }
    .file-item { margin-bottom: 12px; }
    .file-name {
      color: #2196F3;
      font-weight: 600;
      cursor: pointer;
    }
    .file-name:hover { text-decoration: underline; }
    .file-desc { color: #666; margin-left: 20px; font-size: 12px; }
    .export-item {
      margin-left: 20px;
      color: #555;
      padding: 2px 0;
    }
    .type-label {
      display: inline-block;
      padding: 2px 6px;
      border-radius: 3px;
      font-size: 11px;
      font-weight: 600;
      margin-right: 6px;
    }
    .type-class { background: #e3f2fd; color: #1976d2; }
    .type-function { background: #e8f5e9; color: #388e3c; }
    .type-interface { background: #fff3e0; color: #f57c00; }
    .type-type { background: #f3e5f5; color: #7b1fa2; }
    .indent-1 { margin-left: 20px; }
    .indent-2 { margin-left: 40px; }
    .indent-3 { margin-left: 60px; }
    .indent-4 { margin-left: 80px; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>📚 ${data.name} 代码地图</h1>
      <p>生成时间：${new Date(data.generatedAt).toLocaleString("zh-CN")}</p>
      <div class="stats">
        <span>模块：${data.stats.moduleCount} 个</span>
        <span>文件：${data.stats.totalFiles} 个</span>
        <span>导出：${data.stats.totalExports} 个</span>
      </div>
    </header>

    <div class="search">
      <input type="text" id="searchBox" placeholder="搜索文件、函数、类...">
    </div>

    <div id="modules"></div>
  </div>

  <script>
    const data = ${JSON.stringify(data, null, 2)};

    function renderModules(searchTerm = '') {
      const container = document.getElementById('modules');
      container.innerHTML = '';

      data.modules.forEach(module => {
        const moduleEl = document.createElement('div');
        moduleEl.className = 'module open';

        let content = '<div class="module-header">';
        content += \`<h2>\${module.displayName}</h2>\`;
        content += '<span>▼</span>';
        content += '</div>';
        content += '<div class="module-content">';

        // 按类别分组
        const categories = {
          core: { title: '核心功能', files: [] },
          helper: { title: '辅助工具', files: [] },
          type: { title: '类型定义', files: [] }
        };

        module.files.forEach(file => {
          if (!searchTerm || matchesSearch(file, searchTerm)) {
            if (categories[file.category]) {
              categories[file.category].files.push(file);
            }
          }
        });

        Object.values(categories).forEach(cat => {
          if (cat.files.length > 0) {
            content += \`<div class="category"><h3>\${cat.title}</h3><div class="file-tree">\`;
            content += renderFiles(cat.files, module.name, searchTerm);
            content += '</div></div>';
          }
        });

        content += '</div>';
        moduleEl.innerHTML = content;

        moduleEl.querySelector('.module-header').onclick = function() {
          moduleEl.classList.toggle('open');
          this.querySelector('span').textContent = moduleEl.classList.contains('open') ? '▼' : '▶';
        };

        container.appendChild(moduleEl);
      });
    }

    function matchesSearch(file, term) {
      const t = term.toLowerCase();
      if (file.relativePath.toLowerCase().includes(t)) return true;
      if (file.description && file.description.toLowerCase().includes(t)) return true;
      return file.exports.some(e =>
        e.name.toLowerCase().includes(t) ||
        (e.description && e.description.toLowerCase().includes(t))
      );
    }

    function renderFiles(files, modulePrefix, searchTerm) {
      let html = '';
      const tree = buildTree(files, modulePrefix);
      html += renderTreeHTML(tree, 0, searchTerm);
      return html;
    }

    function buildTree(files, modulePrefix) {
      const root = { children: new Map() };
      files.forEach(file => {
        const path = file.relativePath.replace(modulePrefix + '/', '');
        const parts = path.split('/');
        let current = root;
        parts.forEach((part, i) => {
          if (!current.children.has(part)) {
            current.children.set(part, {
              name: part,
              isFile: i === parts.length - 1,
              file: i === parts.length - 1 ? file : null,
              children: new Map()
            });
          }
          current = current.children.get(part);
        });
      });
      return root;
    }

    function renderTreeHTML(node, depth, searchTerm) {
      let html = '';
      const indent = 'indent-' + Math.min(depth, 4);
      Array.from(node.children.entries()).sort().forEach(([name, child]) => {
        if (child.isFile && child.file) {
          const file = child.file;
          const highlight = searchTerm && name.toLowerCase().includes(searchTerm.toLowerCase());
          html += \`<div class="file-item \${indent}">\`;
          html += \`<div class="file-name" style="\${highlight ? 'background: yellow;' : ''}">\${name}</div>\`;
          if (file.description) {
            html += \`<div class="file-desc">\${file.description}</div>\`;
          }
          file.exports.slice(0, 3).forEach(exp => {
            const typeClass = 'type-' + exp.type;
            const typeLabel = {'class':'类','function':'函数','interface':'接口','type':'类型'}[exp.type];
            const params = exp.params && exp.params.length ? \`(\${exp.params.join(', ')})\` : '';
            const decorators = exp.decorators && exp.decorators.length ? \` @\${exp.decorators.join(' @')}\` : '';
            html += \`<div class="export-item"><span class="type-label \${typeClass}">\${typeLabel}</span>\${exp.name}\${params}\${decorators}\`;
            if (exp.description) html += \` - \${exp.description}\`;
            html += '</div>';
          });
          if (file.exports.length > 3) {
            html += \`<div class="export-item">... 还有 \${file.exports.length - 3} 个</div>\`;
          }
          html += '</div>';
        } else {
          html += \`<div class="\${indent}" style="color: #666; font-weight: 600;">\${name}/</div>\`;
          html += renderTreeHTML(child, depth + 1, searchTerm);
        }
      });
      return html;
    }

    renderModules();

    document.getElementById('searchBox').oninput = function(e) {
      renderModules(e.target.value);
    };
  </script>
</body>
</html>`;

	const filePath = path.join(outputDir, "index.html");
	fs.writeFileSync(filePath, html, "utf-8");
	console.log(
		`✅ index.html (${(fs.statSync(filePath).size / 1024).toFixed(1)} KB)`,
	);
}

// ============= 生成拆分 Markdown =============

function generateSplitMarkdown(data: ProjectData, outputDir: string): void {
	// 生成概览索引
	let indexMd = `# ${data.name} 代码地图 - 概览\n\n`;
	indexMd += `生成时间：${new Date(data.generatedAt).toLocaleString("zh-CN")}\n\n`;
	indexMd += `## 统计\n\n`;
	indexMd += `- 模块：${data.stats.moduleCount} 个\n`;
	indexMd += `- 文件：${data.stats.totalFiles} 个\n`;
	indexMd += `- 导出：${data.stats.totalExports} 个\n\n`;
	indexMd += `## 模块列表\n\n`;

	data.modules.forEach((module) => {
		const fileName = module.name.replace(/\//g, "-") + ".md";
		const coreCount = module.files.filter((f) => f.category === "core").length;
		const helperCount = module.files.filter(
			(f) => f.category === "helper",
		).length;
		const typeCount = module.files.filter((f) => f.category === "type").length;

		indexMd += `### [${module.displayName}](${fileName})\n\n`;
		indexMd += `${module.description}\n\n`;
		indexMd += `- 核心功能：${coreCount} 个文件\n`;
		indexMd += `- 辅助工具：${helperCount} 个文件\n`;
		indexMd += `- 类型定义：${typeCount} 个文件\n\n`;
	});

	fs.writeFileSync(path.join(outputDir, "index.md"), indexMd, "utf-8");
	console.log(`✅ index.md (概览)`);

	// 生成各模块详细文档
	data.modules.forEach((module) => {
		const fileName = module.name.replace(/\//g, "-") + ".md";
		let md = `# ${module.displayName}\n\n`;
		md += `${module.description}\n\n`;
		md += `[返回概览](index.md)\n\n`;
		md += `---\n\n`;

		const coreFiles = module.files.filter((f) => f.category === "core");
		const helperFiles = module.files.filter((f) => f.category === "helper");
		const typeFiles = module.files.filter((f) => f.category === "type");

		if (coreFiles.length > 0) {
			md += `## 核心功能\n\n`;
			md += renderFilesSimple(coreFiles, module.name);
		}

		if (helperFiles.length > 0) {
			md += `## 辅助工具\n\n`;
			md += renderFilesSimple(helperFiles, module.name);
		}

		if (typeFiles.length > 0) {
			md += `## 类型定义\n\n`;
			md += renderFilesSimple(typeFiles, module.name);
		}

		fs.writeFileSync(path.join(outputDir, fileName), md, "utf-8");
	});

	console.log(`✅ 拆分模块文档 (${data.stats.moduleCount} 个)`);
}

// ============= 生成嵌套 Treemap（真正的块状图）=============

function generateCSSTreemap(data: ProjectData, outputDir: string): void {
	const treeData = buildNestedTreemapData(data);

	const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${data.name} 代码地图 - Treemap</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #1a1a1a;
      color: white;
      overflow: hidden;
    }
    .header {
      padding: 20px;
      text-align: center;
      background: #2a2a2a;
    }
    h1 { font-size: 28px; margin-bottom: 15px; }
    .tabs {
      display: flex;
      justify-content: center;
      gap: 10px;
      margin-top: 15px;
    }
    .tab {
      padding: 12px 24px;
      background: #333;
      border-radius: 8px 8px 0 0;
      cursor: pointer;
      font-size: 16px;
      font-weight: 600;
      transition: all 0.3s;
    }
    .tab:hover { background: #444; }
    .tab.active {
      background: #667eea;
      transform: translateY(-2px);
    }
    .legend {
      display: flex;
      justify-content: center;
      gap: 20px;
      margin-top: 15px;
      font-size: 12px;
    }
    .legend-item {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .legend-color {
      width: 16px;
      height: 16px;
      border-radius: 3px;
    }
    .tab-content {
      display: none;
      width: 100%;
      height: calc(100vh - 220px);
      position: relative;
    }
    .tab-content.active {
      display: block;
    }
    .treemap-container {
      width: 100%;
      height: 100%;
      position: relative;
      padding: 20px;
    }
    .treemap-node {
      position: absolute;
      border: 1px solid rgba(255,255,255,0.15);
      overflow: hidden;
      cursor: default;
      transition: all 0.2s;
    }
    .treemap-node:hover {
      border-color: rgba(255,255,255,0.6);
      border-width: 2px;
      z-index: 100;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    }
    .node-label {
      position: absolute;
      top: 4px;
      left: 4px;
      right: 4px;
      font-size: 12px;
      font-weight: 600;
      text-shadow: 0 1px 3px rgba(0,0,0,0.9);
      pointer-events: none;
      line-height: 1.3;
      word-wrap: break-word;
      white-space: normal;
    }
    .tooltip {
      position: fixed;
      background: rgba(0,0,0,0.95);
      color: white;
      padding: 12px 16px;
      border-radius: 8px;
      font-size: 13px;
      pointer-events: none;
      z-index: 1000;
      display: none;
      max-width: 350px;
      line-height: 1.6;
      border: 1px solid rgba(255,255,255,0.2);
      box-shadow: 0 4px 12px rgba(0,0,0,0.5);
    }
    /* 颜色方案 */
    .color-category { background: rgba(156, 39, 176, 0.4); }
    .color-dir { background: rgba(0, 188, 212, 0.5); }
    .color-file { background: rgba(76, 175, 80, 0.65); }
    .color-class { background: rgba(255, 152, 0, 0.75); }
    .color-function { background: rgba(33, 150, 243, 0.75); }
    .color-interface { background: rgba(233, 30, 99, 0.7); }
    .color-type { background: rgba(156, 39, 176, 0.7); }
  </style>
</head>
<body>
  <div class="header">
    <h1>📊 ${data.name} 代码地图 - Treemap</h1>
    <div class="tabs" id="tabs"></div>
    <div class="legend">
      <div class="legend-item"><div class="legend-color color-category"></div>分类</div>
      <div class="legend-item"><div class="legend-color color-dir"></div>目录</div>
      <div class="legend-item"><div class="legend-color color-file"></div>文件</div>
      <div class="legend-item"><div class="legend-color color-function"></div>函数</div>
      <div class="legend-item"><div class="legend-color color-class"></div>类</div>
      <div class="legend-item"><div class="legend-color color-interface"></div>接口</div>
    </div>
  </div>

  <div id="tab-contents"></div>
  <div class="tooltip" id="tooltip"></div>

  <script>
    const data = ${JSON.stringify(treeData, null, 2)};
    let currentTab = 0;

    function init() {
      const tabsContainer = document.getElementById('tabs');
      const contentsContainer = document.getElementById('tab-contents');

      data.children.forEach((module, i) => {
        // 创建 Tab
        const tab = document.createElement('div');
        tab.className = 'tab' + (i === 0 ? ' active' : '');
        tab.textContent = module.name;
        tab.onclick = () => switchTab(i);
        tabsContainer.appendChild(tab);

        // 创建 Tab Content
        const content = document.createElement('div');
        content.className = 'tab-content' + (i === 0 ? ' active' : '');
        content.id = 'tab-' + i;
        content.innerHTML = '<div class="treemap-container" id="container-' + i + '"></div>';
        contentsContainer.appendChild(content);
      });

      // 渲染第一个模块
      renderModule(0);
    }

    function switchTab(index) {
      // 更新 Tab 样式
      document.querySelectorAll('.tab').forEach((tab, i) => {
        tab.classList.toggle('active', i === index);
      });

      // 更新内容显示
      document.querySelectorAll('.tab-content').forEach((content, i) => {
        content.classList.toggle('active', i === index);
      });

      // 渲染对应模块（如果还没渲染过）
      if (currentTab !== index) {
        currentTab = index;
        const container = document.getElementById('container-' + index);
        if (!container.hasChildNodes()) {
          renderModule(index);
        }
      }
    }

    function renderModule(index) {
      const module = data.children[index];
      const container = document.getElementById('container-' + index);
      const width = container.clientWidth;
      const height = container.clientHeight;

      renderTreemap(module, 0, 0, width, height, container);
    }

    function renderTreemap(node, x, y, width, height, container) {
      const div = document.createElement('div');
      div.className = 'treemap-node color-' + node.type;
      div.style.left = x + 'px';
      div.style.top = y + 'px';
      div.style.width = width + 'px';
      div.style.height = height + 'px';

      // 智能显示标签
      if (width > 30 && height > 15) {
        const label = document.createElement('div');
        label.className = 'node-label';

        let displayText = node.name;
        const area = width * height;

        if (area < 2000) {
          // 很小的块：只显示数字或简写
          if (node.value) {
            displayText = node.value.toString();
          } else if (node.name.length > 5) {
            displayText = node.name.substring(0, 4);
          }
        } else if (area < 8000) {
          // 小块：显示缩写
          if (node.name.length > 10) {
            displayText = node.name.substring(0, 8) + '..';
          }
          if (node.value && height > 30) {
            displayText += ' (' + node.value + ')';
          }
        } else if (area < 20000) {
          // 中块：显示较完整名称
          if (node.name.length > 20) {
            displayText = node.name.substring(0, 18) + '..';
          }
          if (node.value) {
            displayText += ' (' + node.value + ')';
          }
        } else {
          // 大块：完整显示
          if (node.value) {
            displayText += ' (' + node.value + ')';
          }
        }

        label.textContent = displayText;
        div.appendChild(label);
      }

      div.onmouseenter = (e) => {
        const tooltip = document.getElementById('tooltip');
        tooltip.style.display = 'block';
        tooltip.innerHTML = \`
          <strong>\${node.name}</strong><br>
          类型：\${getTypeLabel(node.type)}<br>
          \${node.description ? '说明：' + node.description + '<br>' : ''}
          \${node.value ? '大小：' + node.value : ''}
        \`;
      };

      div.onmousemove = (e) => {
        const tooltip = document.getElementById('tooltip');
        tooltip.style.left = e.pageX + 15 + 'px';
        tooltip.style.top = e.pageY + 15 + 'px';
      };

      div.onmouseleave = () => {
        document.getElementById('tooltip').style.display = 'none';
      };

      container.appendChild(div);

      // 递归渲染子节点
      if (node.children && node.children.length > 0) {
        const padding = Math.max(2, Math.min(width, height) * 0.015);
        const labelHeight = (width > 30 && height > 15) ? 20 : padding;
        const innerX = x + padding;
        const innerY = y + labelHeight;
        const innerWidth = width - padding * 2;
        const innerHeight = height - labelHeight - padding;

        if (innerWidth > 20 && innerHeight > 20) {
          squarify(node.children, innerX, innerY, innerWidth, innerHeight, container);
        }
      }
    }

    function squarify(children, x, y, width, height, container) {
      if (!children || children.length === 0) return;

      const total = children.reduce((sum, c) => sum + (c.value || 1), 0);
      let remaining = [...children].sort((a, b) => (b.value || 1) - (a.value || 1));

      let currentX = x;
      let currentY = y;
      let remainingWidth = width;
      let remainingHeight = height;

      while (remaining.length > 0) {
        const isHorizontal = remainingWidth >= remainingHeight;
        const dimension = isHorizontal ? remainingWidth : remainingHeight;

        let row = [remaining.shift()];
        let rowValue = row[0].value || 1;

        while (remaining.length > 0) {
          const next = remaining[0];
          const nextValue = next.value || 1;
          const newRowValue = rowValue + nextValue;

          const currentRatio = getWorstRatio(row, rowValue, dimension, total);
          const newRatio = getWorstRatio([...row, next], newRowValue, dimension, total);

          if (newRatio > currentRatio) break;

          row.push(remaining.shift());
          rowValue = newRowValue;
        }

        const rowThickness = (rowValue / total) * (isHorizontal ? remainingHeight : remainingWidth);

        let offset = 0;
        row.forEach(node => {
          const nodeValue = node.value || 1;
          const nodeLength = (nodeValue / rowValue) * dimension;

          if (isHorizontal) {
            renderTreemap(node, currentX + offset, currentY, nodeLength, rowThickness, container);
            offset += nodeLength;
          } else {
            renderTreemap(node, currentX, currentY + offset, rowThickness, nodeLength, container);
            offset += nodeLength;
          }
        });

        if (isHorizontal) {
          currentY += rowThickness;
          remainingHeight -= rowThickness;
        } else {
          currentX += rowThickness;
          remainingWidth -= rowThickness;
        }
      }
    }

    function getWorstRatio(row, rowValue, dimension, total) {
      const thickness = (rowValue / total) * dimension;
      let worst = 0;
      row.forEach(node => {
        const nodeValue = node.value || 1;
        const length = (nodeValue / rowValue) * dimension;
        const ratio = Math.max(length / thickness, thickness / length);
        worst = Math.max(worst, ratio);
      });
      return worst;
    }

    function getTypeLabel(type) {
      const labels = {
        module: '模块',
        category: '分类',
        dir: '目录',
        file: '文件',
        class: '类',
        function: '函数',
        interface: '接口',
        type: '类型'
      };
      return labels[type] || type;
    }

    init();
  </script>
</body>
</html>`;

	const filePath = path.join(outputDir, "treemap.html");
	fs.writeFileSync(filePath, html, "utf-8");
	console.log(
		`✅ treemap.html (${(fs.statSync(filePath).size / 1024).toFixed(1)} KB)`,
	);
}

function buildNestedTreemapData(data: ProjectData) {
	// 构建完整嵌套结构
	const children = data.modules.map((module) => ({
		name: module.displayName,
		type: "module",
		children: buildModuleChildren(module),
	}));

	return {
		name: data.name,
		type: "root",
		children,
	};
}

function buildModuleChildren(module: ModuleInfo) {
	const categories = [
		{
			name: "核心",
			type: "category",
			files: module.files.filter((f) => f.category === "core"),
		},
		{
			name: "辅助",
			type: "category",
			files: module.files.filter((f) => f.category === "helper"),
		},
		{
			name: "类型",
			type: "category",
			files: module.files.filter((f) => f.category === "type"),
		},
	].filter((cat) => cat.files.length > 0);

	return categories.map((cat) => ({
		name: cat.name,
		type: cat.type,
		children: buildFileNodes(cat.files, module.name),
	}));
}

function buildFileNodes(files: FileInfo[], _modulePrefix: string) {
	const result: any[] = [];

	files.forEach((file) => {
		const fileName = path.basename(file.relativePath);

		// 文件节点
		const fileNode: any = {
			name: fileName,
			type: "file",
			description: file.description,
			value: Math.max(1, file.exports.length * 2), // 文件基础大小
			children: [],
		};

		// 添加导出的符号作为子节点
		file.exports.forEach((exp) => {
			fileNode.children.push({
				name: exp.name,
				type: exp.type,
				description: exp.description,
				value: 1,
			});
		});

		result.push(fileNode);
	});

	return result;
}

// ============= 生成 Mermaid 块图 =============

function generateMermaidBlock(data: ProjectData, outputDir: string): void {
	let md = `# ${data.name} 项目结构图\n\n`;
	md += `> 生成于 ${new Date(data.generatedAt).toLocaleString("zh-CN")}\n\n`;
	md += `## 模块关系图\n\n`;
	md += `\`\`\`mermaid\ngraph TB\n`;
	md += `  FXPlanner-new[${data.name}项目]\n`;
	md += `  style FXPlanner-new fill:#667eea,stroke:#333,stroke-width:2px,color:#fff\n\n`;

	data.modules.forEach((module, i) => {
		const moduleId = `M${i}`;
		const coreCount = module.files.filter((f) => f.category === "core").length;
		const helperCount = module.files.filter(
			(f) => f.category === "helper",
		).length;
		const typeCount = module.files.filter((f) => f.category === "type").length;

		md += `  FXPlanner-new --> ${moduleId}["${module.displayName}<br/>${module.files.length}个文件"]\n`;

		if (coreCount > 0) {
			md += `  ${moduleId} --> ${moduleId}_core["核心功能<br/>${coreCount}个"]\n`;
			md += `  style ${moduleId}_core fill:#4caf50,stroke:#333,color:#fff\n`;
		}
		if (helperCount > 0) {
			md += `  ${moduleId} --> ${moduleId}_helper["辅助工具<br/>${helperCount}个"]\n`;
			md += `  style ${moduleId}_helper fill:#ffc107,stroke:#333,color:#fff\n`;
		}
		if (typeCount > 0) {
			md += `  ${moduleId} --> ${moduleId}_type["类型定义<br/>${typeCount}个"]\n`;
			md += `  style ${moduleId}_type fill:#2196f3,stroke:#333,color:#fff\n`;
		}

		const colors = ["#764ba2", "#f5576c", "#00f2fe"];
		md += `  style ${moduleId} fill:${colors[i]},stroke:#333,color:#fff\n`;
		md += `\n`;
	});

	md += `\`\`\`\n\n`;

	md += `## 图例\n\n`;
	md += `- 🟢 **核心功能**：主要业务逻辑、控制器、服务、页面组件\n`;
	md += `- 🟡 **辅助工具**：hooks、utils、helpers\n`;
	md += `- 🔵 **类型定义**：接口和类型\n`;

	const filePath = path.join(outputDir, "structure.md");
	fs.writeFileSync(filePath, md, "utf-8");
	console.log(
		`✅ structure.md (${(fs.statSync(filePath).size / 1024).toFixed(1)} KB)`,
	);
}

// ============= 生成 JSON =============

function generateJSON(data: ProjectData, outputDir: string): void {
	const filePath = path.join(outputDir, "data.json");
	fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
	console.log(
		`✅ data.json (${(fs.statSync(filePath).size / 1024).toFixed(1)} KB)`,
	);
}

// ============= 主函数 =============

async function main() {
	console.log("🚀 生成代码地图\n");

	const data = await analyzeProject();

	const projectRoot = path.resolve(__dirname, "..");
	const outputDir = path.join(projectRoot, ".claude/docs/code-map");

	if (fs.existsSync(outputDir)) {
		fs.readdirSync(outputDir).forEach((file) => {
			if (file !== "README.md") {
				fs.unlinkSync(path.join(outputDir, file));
			}
		});
	} else {
		fs.mkdirSync(outputDir, { recursive: true });
	}

	console.log("📝 生成文件\n");

	generateJSON(data, outputDir);
	generateSimpleTree(data, outputDir);
	generateCollapsibleHTML(data, outputDir);
	generateSplitMarkdown(data, outputDir);
	generateCSSTreemap(data, outputDir);
	generateMermaidBlock(data, outputDir);

	console.log("\n✅ 完成！\n");
	console.log("📂 输出目录：.claude/docs/code-map/\n");
	console.log("查看方式：");
	console.log("  - AI 阅读：tree.md（简洁树状）");
	console.log("  - 人类浏览：用浏览器打开 index.html");
	console.log("  - 可视化：用浏览器打开 treemap.html ⭐ 新增");
	console.log("  - 结构图：structure.md（Mermaid 块图）⭐ 新增");
	console.log("  - 分模块阅读：index.md + 各模块.md");
	console.log("  - 程序处理：data.json\n");
}

main().catch((error) => {
	console.error("❌ 失败：", error);
	process.exit(1);
});
