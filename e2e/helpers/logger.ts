import type { Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';

export interface TestLog {
  timestamp: string;
  type: 'console' | 'network' | 'action';
  level: 'info' | 'warn' | 'error';
  message: string;
  details?: any;
}

/**
 * 日志收集器
 */
export class TestLogger {
  private logs: TestLog[] = [];
  private testName: string;

  constructor(testName: string) {
    this.testName = testName.replace(/[^a-z0-9]/gi, '-').toLowerCase();
  }

  /**
   * 设置页面监听
   */
  setupPageListeners(page: Page) {
    // 监听控制台
    page.on('console', msg => {
      const level = msg.type() === 'error' ? 'error'
                  : msg.type() === 'warning' ? 'warn'
                  : 'info';

      this.log('console', level, msg.text());
    });

    // 监听网络请求
    page.on('response', async response => {
      const url = response.url();

      // 只记录特定端点
      if (url.includes('/api/') || url.includes('/stream')) {
        const level = response.ok() ? 'info' : 'error';
        const body = await response.text().catch(() => '');

        this.log('network', level, `${response.status()} ${url}`, {
          status: response.status(),
          statusText: response.statusText(),
          url,
          body: body.substring(0, 500),
        });
      }
    });
  }

  /**
   * 记录日志
   */
  log(type: TestLog['type'], level: TestLog['level'], message: string, details?: any) {
    const log: TestLog = {
      timestamp: new Date().toISOString(),
      type,
      level,
      message,
      details,
    };

    this.logs.push(log);

    // 实时输出到控制台
    const prefix = level === 'error' ? '❌' : level === 'warn' ? '⚠️' : '✅';
    console.log(`${prefix} [${type}] ${message}`);
  }

  /**
   * 保存日志到文件
   */
  async saveToFile() {
    const outputDir = path.join('e2e', 'test-results', 'logs');
    await fs.promises.mkdir(outputDir, { recursive: true });

    const filePath = path.join(outputDir, `${this.testName}.json`);
    await fs.promises.writeFile(
      filePath,
      JSON.stringify(this.logs, null, 2)
    );

    console.log(`\n📄 日志已保存: ${filePath}`);
    return filePath;
  }

  /**
   * 获取错误摘要
   */
  getErrorSummary() {
    const errors = this.logs.filter(log => log.level === 'error');
    return {
      total: errors.length,
      console: errors.filter(e => e.type === 'console').length,
      network: errors.filter(e => e.type === 'network').length,
      errors,
    };
  }
}
