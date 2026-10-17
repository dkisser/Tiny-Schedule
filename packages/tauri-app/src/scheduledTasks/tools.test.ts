import { describe, expect, test } from 'bun:test';
import { type AppData, emptyAppData } from '@tiny-schedule/shared';
import { buildScheduledTools } from './tools';

/**
 * 这个文件只测一件事：**凭据不落库**。
 *
 * ADR-0008 的权限模型是全开，审计是这条路上唯一的追溯手段；而审计记录本身会
 * 被写进 data.json 以及每一份轮转备份。也就是说参数摘要一旦带上 token，那份
 * token 就比 prompt 活得更久——它进了备份，而备份不在删除任务的范围内。
 *
 * 模型调 `httpRequest` 时带 `Authorization` 头是常规操作，不是例外，所以这条
 * 性质必须由工具自己保证，不能指望"模型一般不会把密钥写在头里"。
 */

const TOKEN = 'sk-live-DO-NOT-LEAK-0123456789';

function tools() {
  return buildScheduledTools({
    workingDirectory: '/repo',
    context: { taskId: 't1', runId: 'r1' },
    invoke: async () => ({}),
    getData: (): AppData => emptyAppData(),
    today: () => '2026-10-17',
  });
}

function describeCall(name: string, params: unknown): string {
  const tool = tools().find((t) => t.tool.name === name);
  if (!tool) throw new Error(`no such tool: ${name}`);
  return tool.describe(params).argsSummary;
}

describe('审计摘要 — 凭据不落库', () => {
  test('http 的 Authorization 头被脱敏', () => {
    const summary = describeCall('httpRequest', {
      url: 'https://api.example.com/v1/x',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(summary).not.toContain(TOKEN);
    expect(summary).not.toContain('Bearer');
  });

  test('大小写不同的 authorization 与 x-api-key 同样被脱敏', () => {
    // 头名大小写不固定，模型和 SDK 都会自己拼，所以匹配必须忽略大小写。
    const summary = describeCall('httpRequest', {
      url: 'https://api.example.com/v1/x',
      headers: {
        AUTHORIZATION: `Bearer ${TOKEN}`,
        'X-Api-Key': TOKEN,
        Cookie: `session=${TOKEN}`,
      },
    });
    expect(summary).not.toContain(TOKEN);
  });

  test('名单之外的自造凭据头同样被脱敏', () => {
    // 白名单式的枚举漏得静默：SDK 自造的头名（x-company-session、x-hub-sig…）
    // 一个都不在名单里，而这恰恰是最容易漏出去的一类。
    const summary = describeCall('httpRequest', {
      url: 'https://api.example.com/v1/x',
      headers: {
        'X-Company-Session': TOKEN,
        'X-Hub-Sig': TOKEN,
        'X-CSRF-Token': TOKEN,
      },
    });
    expect(summary).not.toContain(TOKEN);
  });

  test('非敏感头照常记录，审计仍能看出这次请求带了什么', () => {
    // 全脱敏会让审计失去价值：分不清"没带 Content-Type"和"带了一个被抹掉的"。
    const summary = describeCall('httpRequest', {
      url: 'https://api.example.com/v1/x',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(summary).toContain('Content-Type');
    expect(summary).toContain('application/json');
  });

  test('URL 的 query 仍然被剥掉', () => {
    const summary = describeCall('httpRequest', {
      url: `https://api.example.com/v1/x?key=${TOKEN}`,
    });
    expect(summary).not.toContain(TOKEN);
    expect(summary).toContain('api.example.com');
  });

  test('写文件的内容只记长度', () => {
    const summary = describeCall('writeFile', {
      path: '/repo/notes.md',
      content: TOKEN.repeat(10),
    });
    expect(summary).not.toContain(TOKEN);
    expect(summary).toContain('chars');
    // 路径是审计要留的：写到了哪里。
    expect(summary).toContain('/repo/notes.md');
  });

  test('命令与参数照常记录', () => {
    const summary = describeCall('runCommand', { command: 'git', args: ['status'] });
    expect(summary).toContain('git');
    expect(summary).toContain('status');
  });
});
