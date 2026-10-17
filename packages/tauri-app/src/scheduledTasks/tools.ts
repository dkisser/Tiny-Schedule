import type { AgentTool } from '@earendil-works/pi-agent-core';
import { type AppData } from '@tiny-schedule/shared';
import { type TSchema, Type } from 'typebox';
import { buildChatTools } from '@/ai/chatAgentTools';

/**
 * 定时任务的工具集：四个网关命令 + 三个应用内只读工具。
 *
 * ADR-0008 的落地在这里：runCommand / httpRequest / writeFile / readFile 是
 * capability 层仅有的四个越界开口，Agent 碰不到别的世界。每个都 invoke 对应的
 * Rust 命令，并**始终带上 taskId / runId**——不是"目前用不上但先传着"，而是收口
 * 边界唯一的执行依据：哪天权限收紧，"这个运行能不能跑这条命令"的答案需要调用者
 * 身份，而不是只有载荷。
 *
 * 执行目录（cwd）是运行级的，不交给模型：`runCommand` 的 cwd 恒为本次运行所属定
 * 时任务的执行目录。交给模型的话，审计记录里的 cwd 就不再是"这次运行在哪执行"，
 * 而变成"模型说了什么"，那是两个不同的问题。
 */

/**
 * The Tauri invoke seam; swapped for a stub in tests.
 *
 * Deliberately non-generic: every caller narrows the result itself, and a
 * generic one would only invite a stub that promises a shape the real host does
 * not guarantee.
 */
export type InvokeFn = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

/*
 * 命令名**不**做成常量表：每个工具在自己的 `call` 里写字面量，
 * `scripts/check-ipc-literals.ts` 才能把这一次调用与 `lib.rs` 的
 * `generate_handler!` 对上。常量表会把这个对照变成一次查表，而那份脚本存在的
 * 全部理由就是让"重命名了但两边都没发现"不可能发生。
 */

export interface GatewayContext {
  taskId: string;
  runId: string;
}

export interface ScheduledToolDeps {
  /** 执行目录；CONTEXT.md 叫"执行目录"，它不是权限边界（ADR-0008）。 */
  workingDirectory: string;
  /** The ids carried on every gateway request. */
  context: GatewayContext;
  /** Injectable so tests never reach a real host. */
  invoke: InvokeFn;
  /** For the three app-data tools; async because the webview store is. */
  getData: () => AppData | Promise<AppData>;
  today: () => string;
}

/**
 * 一个工具 + 它怎么进审计记录。
 *
 * 审计的三个字段（目标 / 参数摘要 / 结果摘要）必须由**工具自己**声明，而不是由
 * 拦截器去猜：猜一个未知工具的目标，只能靠工具名做字符串匹配，那正是 ADR-0008
 * 不接受的"绕过网关也无从察觉"的位置。声明和工具捆在一起，加一个工具就必然要
 * 说清它碰到什么。
 */
export interface AuditableTool {
  tool: AgentTool;
  /** 本次调用碰到的东西：执行目录、host 或文件路径。 */
  describe: (params: unknown) => { target: string; argsSummary: string };
  /**
   * 把工具结果压成一行放进审计记录。收**文本**而不是工具返回值：审计记录和模型
   * 读的是同一份文本，两者不可能对不上。
   */
  summarize: (resultText: string) => string;
}

interface TextToolResult {
  content: { type: 'text'; text: string }[];
  details: undefined;
}

function text(body: string): TextToolResult {
  return { content: [{ type: 'text', text: body }], details: undefined };
}

/**
 * 哪种结果形状 — 决定回给模型的 JSON 里有哪些键。
 *
 * 与命令名分开，是因为 invoke 的调用点必须写成 `ctx.invoke('scheduled_exec', …)`
 * 这样的字面量（见 {@link GatewayToolSpec.call}），字面量归 invoke、形状归这里，
 * 两件事不必共用一个值。
 */
type OutcomeShape = 'exec' | 'http' | 'file';

/** Turns whatever a gateway command resolved into the text the model reads. */
function outcomeToText(shape: OutcomeShape, result: unknown): TextToolResult {
  if (result === null || typeof result !== 'object') return text(String(result ?? ''));
  const r = result as Record<string, unknown>;
  switch (shape) {
    case 'exec':
      return text(
        JSON.stringify({
          exitCode: r.exitCode,
          signal: r.signal,
          stdout: r.stdout,
          stderr: r.stderr,
          stdoutTruncated: r.stdoutTruncated,
          stderrTruncated: r.stderrTruncated,
          timedOut: r.timedOut,
        }),
      );
    case 'http':
      return text(
        JSON.stringify({
          status: r.status,
          headers: r.headers,
          body: r.body,
          truncated: r.bodyTruncated,
        }),
      );
    default:
      return text(JSON.stringify(r));
  }
}

/**
 * A one-line result summary for the run record — never the whole payload.
 *
 * Reads the JSON this module itself produced a few lines up, so the summary and
 * the text the model sees cannot disagree about what happened.
 */
function outcomeSummary(resultText: string): string {
  let r: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(resultText);
    if (parsed === null || typeof parsed !== 'object') return resultText;
    r = parsed as Record<string, unknown>;
  } catch {
    // Not one of ours (a plain string came back) — record it as it is.
    return resultText;
  }
  const parts: string[] = [];
  if (r.exitCode !== undefined) parts.push(`exit=${String(r.exitCode)}`);
  if (r.signal !== undefined && r.signal !== null) parts.push(`signal=${String(r.signal)}`);
  if (r.timedOut === true) parts.push('timedOut');
  if (r.status !== undefined) parts.push(`status=${String(r.status)}`);
  if (r.bytesWritten !== undefined) parts.push(`wrote=${String(r.bytesWritten)}B`);
  if (r.returnedBytes !== undefined) {
    parts.push(`read=${String(r.returnedBytes)}B/${String(r.totalBytes)}B`);
  }
  if (r.truncated === true) parts.push('truncated');
  // A failed command writes the reason to stderr, so an exit=0 summary with no
  // detail would hide exactly the case a reader opens the run record to see.
  //
  // The response **body** is deliberately not a detail source. Redacting request
  // headers while pasting the response body into the same record leaves the
  // credential half-defended: an API that echoes the Authorization back — a debug
  // endpoint, an error tracker — puts the token in data.json and in every rotated
  // backup. The size is recorded above, which is the part worth keeping.
  const detail = [r.stderr].find((v) => typeof v === 'string' && v.trim() !== '');
  if (parts.length === 0 && r.body !== undefined) {
    // No shape fields at all: still say something about the payload rather than
    // dumping a JSON blob that may contain a credential.
    return `body=<${String(r.body).length} chars>`;
  }
  return parts.length > 0
    ? `${parts.join(' ')} | ${String(detail ?? '').trim()}`
    : JSON.stringify(r);
}

/**
 * Header names whose values are credentials. Matched case-insensitively because
 * the name is the model's to spell: `Authorization` is as likely to arrive as
 * `authorization`, and a check that only matched one spelling would look like it
 * worked.
 *
 * A denylist, not an allowlist, on purpose: an allowlist has to enumerate every
 * header worth auditing (`Accept`, `If-Match`, …) and misses silently, whereas
 * this one misses loudly — an unlisted credential-bearing header is a leak
 * rather than a missing feature. The cost is that an exotic secret header goes
 * through, which is why `summarizeArgs` keeps the names.
 */
const CREDENTIAL_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api-key',
  'x-auth-token',
  'x-access-token',
  // Not exhaustive on purpose — the pattern below is what actually carries the
  // weight, and this list only short-circuits the ones that are always secret.
  'x-amz-security-token',
  'x-csrf-token',
  'x-goog-api-key',
  'x-rapidapi-key',
]);

/**
 * Header names that are credential-bearing without being on the list.
 *
 * The listed names are a starting set, not the rule: SDKs and gateways mint
 * their own (`x-company-session`, `x-hub-sig`, `x-csrf`, …) and a name the list
 * has never heard of is exactly the one that leaks. A substring test catches the
 * whole family, so an unknown spelling fails closed rather than open.
 */
const CREDENTIAL_NAME_PATTERN =
  /(auth|token|secret|password|passwd|api[-_]?key|apikey|session|credential|signature|sig\b)/i;

/** Whether one header's value is a credential worth replacing with its size. */
function isCredentialHeader(name: string): boolean {
  return CREDENTIAL_HEADERS.has(name.toLowerCase()) || CREDENTIAL_NAME_PATTERN.test(name);
}

/** The header map with credential values replaced by their length. */
function redactHeaders(headers: unknown): Record<string, unknown> {
  if (!isRecord(headers)) return {};
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = isCredentialHeader(name) ? `<${String(value).length} chars>` : value;
  }
  return out;
}

/** `{...}` with values that are long or sensitive reduced to their size. */
function summarizeArgs(params: Record<string, unknown>): string {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    // File content and request bodies are exactly what must not land in a run
    // record verbatim: one is arbitrarily large, and either can carry a
    // credential the model typed. Their size is the useful part.
    if (key === 'content' || key === 'body') {
      redacted[key] = `<${String(value).length} chars>`;
    } else if (key === 'headers') {
      // The header *names* stay — they are what makes the record readable —
      // but a token rides in the value, so only the length is kept.
      redacted[key] = redactHeaders(value);
    } else {
      redacted[key] = value;
    }
  }
  return JSON.stringify(redacted);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const runCommandParams = Type.Object({
  command: Type.String({ description: '程序名，通过 PATH 解析，不是 shell 字符串' }),
  args: Type.Optional(Type.Array(Type.String(), { description: '参数，逐个原样传入' })),
  timeoutMs: Type.Optional(Type.Number({ description: '超时毫秒数' })),
});

const httpRequestParams = Type.Object({
  method: Type.Optional(Type.String({ description: 'HTTP 方法，缺省 GET' })),
  url: Type.String({ description: '完整 URL' }),
  headers: Type.Optional(Type.Record(Type.String(), Type.String())),
  body: Type.Optional(Type.String()),
  timeoutMs: Type.Optional(Type.Number()),
});

const writeFileParams = Type.Object({
  path: Type.String({ description: '写入路径，相对路径相对于执行目录' }),
  content: Type.String({ description: '写入内容' }),
});

const readFileParams = Type.Object({
  path: Type.String({ description: '读取路径，相对路径相对于执行目录' }),
  offset: Type.Optional(Type.Number({ description: '起始字节偏移' })),
  limit: Type.Optional(Type.Number({ description: '最多返回的字节数' })),
});

interface GatewayToolSpec {
  name: string;
  /** 结果的形状，见 {@link OutcomeShape}. */
  shape: OutcomeShape;
  /**
   * 真正调 Rust 的那一步。
   *
   * 每个工具在这里**写字面量命令名**，而不是从一张表里查：`scripts/check-ipc-
   * literals.ts` 靠匹配"以字符串字面量为参数的那种 invoke"这一段源码，把前端的
   * 调用与 `lib.rs` 的 `generate_handler!` 对齐；命令名一旦经过变量，那次比对就
   * 静默失效了——重命名一个命令照样编译、照样打包、照样在运行时才炸，正是那个
   * 脚本要消灭的失败模式。
   */
  call: (request: Record<string, unknown>) => Promise<unknown>;
  params: TSchema;
  description: string;
  /** 本次调用碰到的东西：执行目录、host 或文件路径。 */
  target: (params: Record<string, unknown>) => string;
  /** 发给 Rust 的请求体；调用者身份由本函数统一补上。 */
  build: (params: Record<string, unknown>) => Record<string, unknown>;
  /** 落进审计记录前对参数做的加工，默认原样（长文本已由 summarizeArgs 处理）。 */
  redact?: (params: Record<string, unknown>) => Record<string, unknown>;
}

/**
 * Builds one gateway tool plus its audit metadata.
 *
 * The audit record is built here, at the same moment the request is built, so
 * the recorded target is the *resolved* one (the run's working directory, the
 * parsed host) rather than whatever the model happened to type.
 */
function gatewayTool(ctx: ScheduledToolDeps, spec: GatewayToolSpec): AuditableTool {
  const { name, shape, call, params, description, target, build } = spec;
  const tool: AgentTool = {
    name,
    label: name,
    description,
    parameters: params,
    execute: async (_toolCallId, raw) => {
      const result = await call({
        taskId: ctx.context.taskId,
        runId: ctx.context.runId,
        ...build(raw as Record<string, unknown>),
      });
      return outcomeToText(shape, result) as never;
    },
  };
  return {
    tool,
    describe: (raw) => {
      const p = isRecord(raw) ? raw : {};
      const recorded = spec.redact ? spec.redact(p) : p;
      return { target: target(p), argsSummary: summarizeArgs(recorded) };
    },
    summarize: outcomeSummary,
  };
}

/** 去掉 URL 的 query：审计要记"去了哪个 host、哪条路径"，凭据在 query 里。 */
function withoutQuery(url: unknown): string {
  const raw = String(url ?? '');
  try {
    const parsed = new URL(raw);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return raw;
  }
}

export function buildGatewayTools(ctx: ScheduledToolDeps): AuditableTool[] {
  return [
    gatewayTool(ctx, {
      name: 'runCommand',
      shape: 'exec',
      call: (request) => ctx.invoke('scheduled_exec', { request }),
      params: runCommandParams,
      description:
        '在定时任务的执行目录里运行一个程序。command 是程序名不是 shell 字符串，参数用 args 数组逐个传入；不要用 "sh -c" 拼接。',
      // The run's directory, not the model's — see the module docs.
      target: () => ctx.workingDirectory,
      build: (p) => ({
        command: String(p.command ?? ''),
        args: (p.args as string[] | undefined) ?? [],
        cwd: ctx.workingDirectory,
        ...(p.timeoutMs !== undefined ? { timeoutMs: Number(p.timeoutMs) } : {}),
      }),
    }),
    gatewayTool(ctx, {
      name: 'httpRequest',
      shape: 'http',
      call: (request) => ctx.invoke('scheduled_http_request', { request }),
      params: httpRequestParams,
      description: '发起一次 HTTP 请求，返回状态码、响应头与响应体。',
      // The host, not the full URL: a run record lists where it reached, and a
      // query string is routinely a credential.
      target: (p) => {
        try {
          return new URL(String(p.url ?? '')).host;
        } catch {
          return String(p.url ?? '');
        }
      },
      redact: (p) => ({ ...p, url: withoutQuery(p.url) }),
      build: (p) => ({
        url: String(p.url ?? ''),
        ...(p.method !== undefined ? { method: String(p.method) } : {}),
        ...(p.headers !== undefined ? { headers: p.headers } : {}),
        ...(p.body !== undefined ? { body: String(p.body) } : {}),
        ...(p.timeoutMs !== undefined ? { timeoutMs: Number(p.timeoutMs) } : {}),
      }),
    }),
    gatewayTool(ctx, {
      name: 'writeFile',
      shape: 'file',
      call: (request) => ctx.invoke('scheduled_write_file', { request }),
      params: writeFileParams,
      description: '写入一个文件，返回写入字节数。相对路径相对于执行目录。',
      target: (p) => String(p.path ?? ''),
      build: (p) => ({
        path: String(p.path ?? ''),
        cwd: ctx.workingDirectory,
        content: String(p.content ?? ''),
      }),
    }),
    gatewayTool(ctx, {
      name: 'readFile',
      shape: 'file',
      call: (request) => ctx.invoke('scheduled_read_file', { request }),
      params: readFileParams,
      description: '读取一个文件的内容，返回内容与总字节数。相对路径相对于执行目录。',
      target: (p) => String(p.path ?? ''),
      build: (p) => ({
        path: String(p.path ?? ''),
        cwd: ctx.workingDirectory,
        ...(p.offset !== undefined ? { offset: Number(p.offset) } : {}),
        ...(p.limit !== undefined ? { limit: Number(p.limit) } : {}),
      }),
    }),
  ];
}

/**
 * 把三个应用内只读工具包成同样形状。
 *
 * 复用 chatTools 的实现而不是重写：它们读的是同一个 AppData，行为必须一致，否则
 * 同一个问题在聊天里和在定时任务里会得到两个答案。
 *
 * 它们的 target 是 `app:data` —— 不碰执行目录，也不出网，审计记的是"读了应用数据"。
 */
/**
 * 定时运行可以调用的应用内工具名。
 *
 * **一个显式名单，而不是"chat 有的都算"。** 聊天是有人盯着的：工具失败会有人
 * 补救，写操作有人确认。定时任务是在**网关凭据全开**的上下文里无人值守地跑，
 * 两者不是同一个风险等级。
 *
 * 继承 `buildChatTools` 的全部意味着：将来有人给聊天加一个写工具（`updateTask`
 * 之类），它会**静默地**出现在定时运行的工具集里——没有编译错误，没有测试失败，
 * 没有 ADR 复核。而无人值守的执行会把这次写入照做。
 *
 * 名单变短是刻意的：少一个工具，代价是一个定时 prompt 写不了某件事；多一个，
 * 代价是一整类操作在无人值守下变得可达，且没人会发现。
 */
const SCHEDULED_APP_TOOLS = new Set(['queryTasks', 'getSummary', 'listProjects']);

export function buildAppDataTools(
  ctx: Pick<ScheduledToolDeps, 'getData' | 'today'>,
): AuditableTool[] {
  const asAuditable = (tool: AgentTool): AuditableTool => ({
    tool,
    describe: (raw) => ({
      target: 'app:data',
      argsSummary: summarizeArgs(isRecord(raw) ? raw : {}),
    }),
    // These results are whole datasets; the run record wants to know the shape
    // of what was read, and the interceptor truncates whatever comes back.
    summarize: (resultText) => (resultText !== '' ? resultText : 'ok'),
  });
  return buildChatTools(ctx.getData, ctx.today)
    .filter((tool) => SCHEDULED_APP_TOOLS.has(tool.name))
    .map(asAuditable);
}

/** Everything a scheduled run's agent can call. Nothing else is reachable. */
export function buildScheduledTools(deps: ScheduledToolDeps): AuditableTool[] {
  return [...buildGatewayTools(deps), ...buildAppDataTools(deps)];
}
