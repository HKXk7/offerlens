/**
 * OfferLens Web 控制台的 HTTP 服务层。
 *
 * 刻意用 Node 内置的 `node:http`，零第三方依赖 —— 与项目「零原生依赖、装上就能跑」的
 * 一贯取舍一致，也便于面试时讲清楚「HTTP 里发生了什么」（路由、CORS、静态托管、流式读取）。
 *
 * 提供的接口：
 *   GET /api/health          存活探针
 *   GET /api/meta            档位列表 + 裁判信息 + 评测集规模
 *   GET /api/leaderboard     榜单（每个档位的聚合指标）
 *   GET /api/jds             JD 库：覆盖矩阵 + 数据质量 + 逐条来源（样本够不够）
 *   GET /api/compare?base=&cand=   对比矩阵 + 切片下钻
 *   GET /api/cases           评测集所有 case（供详情页选择）
 *   GET /api/case?run_id=&case_id= case 详情 + trace 瀑布图数据
 *
 * 生产模式下（web/dist 存在）同时托管前端静态文件。
 *
 * 用法：
 *   npx tsx src/server/server.ts            # 默认端口 8787
 *   npx tsx src/server/server.ts --port 9000
 *   PORT=9000 npx tsx src/server/server.ts
 */

import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze, caseDetail, compare, listCases } from './analyze.js';
import { buildJdView } from './jdView.js';
import { loadJds } from '../jd/store.js';
import { currentJob, jobHistory, startEval, subscribeEval } from './evalJobs.js';
import type { EvalOptions } from '../eval/runner.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB_DIST = resolve(ROOT, 'web', 'dist');

const DEFAULT_PORT = 8787;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function sendJsonError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

/** 读请求体（本服务目前只有 GET，保留这个函数以备后续 POST 用） */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf8');
      if (data.length > 1e7) reject(new Error('请求体过大'));
    });
    req.on('end', () => resolvePromise(data));
    req.on('error', reject);
  });
}

function urlOf(req: IncomingMessage): URL {
  return new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
}

/** 静态托管：把 web/dist 里的文件发给浏览器（生产模式） */
function serveStatic(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
  if (!existsSync(WEB_DIST)) return false;

  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';

  // 防止目录穿越
  const target = resolve(join(WEB_DIST, pathname));
  if (!target.startsWith(WEB_DIST)) {
    sendJsonError(res, 403, 'forbidden');
    return true;
  }

  let filePath = target;
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    filePath = resolve(WEB_DIST, 'index.html'); // SPA 回退
  }
  if (!existsSync(filePath)) {
    sendJsonError(res, 404, 'not found');
    return true;
  }

  const ext = extname(filePath).toLowerCase();
  const contentType = MIME[ext] ?? 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
  });
  createReadStream(filePath).pipe(res);
  return true;
}

/**
 * `web/dist` 不存在时给浏览器的引导页。
 *
 * 为什么需要：`web/dist` 是构建产物，不进仓库（.gitignore 里排除了 dist/）。
 * 所以「clone → npm install → npm run serve → 打开 8787」这条最自然的路径，
 * 在新机器上会看到一个 404 或一段裸 JSON —— 用户根本不知道是自己少跑了一步。
 * 这里返回一张能直接照着做的页面，把「构建前端」这步显式讲出来。
 */
function serveBuildGuide(res: ServerResponse): void {
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>OfferLens · 前端尚未构建</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 32px;
         font: 15px/1.7 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
         background: #f6f7f9; color: #1f2328; }
  main { width: 100%; max-width: 680px; background: #fff; border: 1px solid #e4e7ec;
         border-radius: 14px; padding: 32px 34px; box-shadow: 0 2px 12px rgba(16,24,40,.05); }
  .tag { display: inline-block; font-size: 12px; letter-spacing: .04em; color: #8a6d1f;
         background: #fdf5d8; border: 1px solid #f0e0a8; border-radius: 999px; padding: 2px 10px; }
  h1 { font-size: 21px; margin: 14px 0 6px; font-weight: 650; }
  p { margin: 10px 0; color: #444b53; }
  code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 13px;
         background: #f1f3f5; border-radius: 5px; padding: 1px 5px; }
  pre { margin: 12px 0; background: #0f172a; color: #e6edf3; border-radius: 10px;
        padding: 14px 16px; overflow-x: auto; font-size: 13px; line-height: 1.65; }
  pre .c { color: #8b98a9; }
  ol { padding-left: 20px; margin: 10px 0; }
  li { margin: 8px 0; color: #444b53; }
  .alt { margin-top: 22px; padding-top: 18px; border-top: 1px dashed #e4e7ec; font-size: 14px; }
  a { color: #0969da; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .muted { color: #6b7280; font-size: 13px; }
</style></head>
<body><main>
  <span class="tag">API 已启动 · 前端未构建</span>
  <h1>差一步就能看到控制台</h1>
  <p>后端接口全部可用，但 <code>web/dist</code> 是构建产物，不随仓库分发。
     跑一条命令构建前端，然后刷新本页即可。</p>
  <pre><span class="c"># 在仓库根目录执行（只需一次）</span>
npm run web:build</pre>
  <ol>
    <li>构建完成后<strong>刷新本页</strong>（无需重启后端，静态文件是每次请求现读的）；</li>
    <li>想改前端代码用热更新：另开终端跑 <code>npm run web:dev</code>，访问 5173 端口。</li>
  </ol>
  <div class="alt">
    <p>只想看看界面长什么样？<a href="https://offerlens-eval.app.workbuddy.host/?sharecode=XD4PMDP2MG" target="_blank" rel="noreferrer">打开在线 Demo →</a></p>
    <p class="muted">接口探针：<code>/api/health</code> · <code>/api/meta</code> · <code>/api/leaderboard</code></p>
  </div>
</main></body></html>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(html);
}

function withCors(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

const server = createServer(async (req, res) => {
  withCors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = urlOf(req);
  const path = url.pathname;

  /* ---------- API ---------- */
  if (path.startsWith('/api/')) {
    /* POST /api/eval —— 启动评测（后台 job，唯一写接口） */
    if (path === '/api/eval' && req.method === 'POST') {
      let body: Record<string, unknown>;
      try {
        const raw = await readBody(req);
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch {
        sendJsonError(res, 400, '请求体不是合法 JSON');
        return;
      }

      const opts: EvalOptions = {};

      if (body.profiles !== undefined && body.profiles !== null) {
        if (!Array.isArray(body.profiles) || body.profiles.some((x) => typeof x !== 'string')) {
          sendJsonError(res, 400, 'profiles 需为字符串数组');
          return;
        }
        opts.profiles = body.profiles as string[];
      }
      if (body.limit !== undefined) {
        if (body.limit !== null && (typeof body.limit !== 'number' || !Number.isFinite(body.limit))) {
          sendJsonError(res, 400, 'limit 需为数字或 null');
          return;
        }
        opts.limit = body.limit as number | null;
      }
      if (body.runs !== undefined) {
        if (typeof body.runs !== 'number' || !Number.isFinite(body.runs)) {
          sendJsonError(res, 400, 'runs 需为数字');
          return;
        }
        opts.runs = body.runs;
      }
      if (body.budget !== undefined) {
        if (typeof body.budget !== 'number' || !Number.isFinite(body.budget)) {
          sendJsonError(res, 400, 'budget 需为数字');
          return;
        }
        opts.budget = body.budget;
      }
      if (body.concurrency !== undefined) {
        if (typeof body.concurrency !== 'number' || !Number.isFinite(body.concurrency)) {
          sendJsonError(res, 400, 'concurrency 需为数字');
          return;
        }
        opts.concurrency = body.concurrency;
      }
      if (body.judge !== undefined) {
        if (typeof body.judge !== 'boolean') {
          sendJsonError(res, 400, 'judge 需为布尔值');
          return;
        }
        opts.judge = body.judge;
      }
      if (body.dryRun !== undefined) {
        if (typeof body.dryRun !== 'boolean') {
          sendJsonError(res, 400, 'dryRun 需为布尔值');
          return;
        }
        opts.dryRun = body.dryRun;
      }

      // 线上部署环境无 .env：只允许 dry-run（仅预览 prompt，不发请求、不花钱、不需 key）。
      // 真实跑批需要本地 API Key，线上拦截以免误触发付费调用。
      if (!existsSync(resolve(ROOT, '.env')) && !opts.dryRun) {
        sendJson(res, 403, {
          error: '线上为只读演示，仅支持 prompt 预览（dry-run）；真实跑批请在本地运行（需要 API Key）。',
          code: 'readonly',
        });
        return;
      }

      const result = startEval(opts);
      if (!result.ok) {
        sendJson(res, result.code === 'already_running' ? 409 : 400, { error: result.error, code: result.code });
        return;
      }
      sendJson(res, 202, { job: result.job });
      return;
    }

    if (req.method !== 'GET') {
      sendJsonError(res, 405, 'method not allowed');
      return;
    }

    if (path === '/api/health') {
      sendJson(res, 200, { ok: true, time: new Date().toISOString() });
      return;
    }

    if (path === '/api/eval/stream') {
      // SSE：实时推送评测进度 / 日志 / 终态。连接即推一个 snapshot 供页面刷新后恢复状态。
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      const send = (event: string, data: unknown): void => {
        if (res.writableEnded) return;
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      send('snapshot', { job: currentJob() });
      const unsub = subscribeEval((e) => {
        if (e.type === 'log') send('log', { line: e.line });
        else if (e.type === 'progress') send('progress', { progress: e.progress });
        else if (e.type === 'done') send('done', { summary: e.summary });
        else send('failed', { error: e.error, errorCode: e.errorCode });
      });
      req.on('close', () => unsub());
      return;
    }

    if (path === '/api/eval/status') {
      sendJson(res, 200, { job: currentJob() });
      return;
    }

    if (path === '/api/eval/jobs') {
      sendJson(res, 200, { jobs: jobHistory() });
      return;
    }

    if (path === '/api/meta') {
      const { result } = analyze();
      sendJson(res, 200, {
        profiles: result.profiles,
        judge: result.judge,
        caseCount: result.caseCount,
        dataset: result.dataset,
        generatedAt: result.generatedAt,
        dataSource: result.dataSource,
        // 无 .env 时为只读演示（线上部署）：真实跑批被禁用，仅 dry-run 可跑
        readonly: !existsSync(resolve(ROOT, '.env')),
      });
      return;
    }

    if (path === '/api/jds') {
      // JD 库是评测集的输入侧：样本够不够、真实样本占多少，决定了所有结论的适用范围。
      // 读失败不能 500 装死 —— 页面会白屏，读者以为是站点挂了。
      try {
        sendJson(res, 200, buildJdView(loadJds()));
      } catch (e) {
        sendJsonError(res, 500, `JD 库读取失败：${e instanceof Error ? e.message : String(e)}`);
      }
      return;
    }

    if (path === '/api/leaderboard') {
      const { result } = analyze();
      sendJson(res, 200, {
        leaderboard: result.leaderboard,
        judge: result.judge,
        generatedAt: result.generatedAt,
        dataSource: result.dataSource,
      });
      return;
    }

    if (path === '/api/compare') {
      const base = url.searchParams.get('base') ?? '';
      const cand = url.searchParams.get('cand') ?? '';
      if (!base || !cand) {
        sendJsonError(res, 400, '缺少 base 或 cand 参数');
        return;
      }
      const out = compare(base, cand);
      if ('error' in out) {
        sendJsonError(res, 404, out.error);
        return;
      }
      sendJson(res, 200, out);
      return;
    }

    if (path === '/api/cases') {
      sendJson(res, 200, { cases: listCases() });
      return;
    }

    if (path === '/api/case') {
      const runId = url.searchParams.get('run_id') ?? '';
      const caseId = url.searchParams.get('case_id') ?? '';
      if (!runId || !caseId) {
        sendJsonError(res, 400, '缺少 run_id 或 case_id 参数');
        return;
      }
      const out = caseDetail(runId, caseId);
      if ('error' in out) {
        sendJsonError(res, 404, out.error);
        return;
      }
      sendJson(res, 200, out);
      return;
    }

    sendJsonError(res, 404, `未知接口 ${path}`);
    return;
  }

  /* ---------- 静态托管 ---------- */
  if (!serveStatic(req, res, url)) {
    // 浏览器直接访问页面路由：给能照着操作的引导页，而不是一段裸 JSON。
    // 接口路径（/api/*）已在上面各自返回，走不到这里。
    const accept = req.headers.accept ?? '';
    if (accept.includes('text/html')) {
      serveBuildGuide(res);
      return;
    }
    sendJson(res, 200, {
      service: 'OfferLens Web API',
      hint: '前端尚未构建。请先 `npm run web:build`，或用 `npm run web:dev` 启动 Vite 开发服务器。',
      endpoints: ['/api/health', '/api/meta', '/api/leaderboard', '/api/compare?base=&cand=', '/api/cases', '/api/case?run_id=&case_id='],
    });
  }
});

function parsePort(argv: readonly string[]): number {
  const idx = argv.indexOf('--port');
  if (idx >= 0 && idx + 1 < argv.length) {
    const n = Number(argv[idx + 1]);
    if (Number.isInteger(n) && n > 0 && n < 65536) return n;
  }
  const env = Number(process.env.PORT);
  if (Number.isInteger(env) && env > 0 && env < 65536) return env;
  return DEFAULT_PORT;
}

const port = parsePort(process.argv.slice(2));
// 本地默认只监听回环地址；部署环境（工具注入 PORT）需监听 0.0.0.0 供反向代理接入。
const host = process.env.PORT ? '0.0.0.0' : '127.0.0.1';
server.listen(port, host, () => {
  console.log(`OfferLens Web API 已启动：http://localhost:${port}`);
  console.log(`  榜单      GET http://localhost:${port}/api/leaderboard`);
  console.log(`  对比矩阵  GET http://localhost:${port}/api/compare?base=sf-dsv4flash__p2-strict&cand=sf-qwen35-122b__p2-strict`);
  if (existsSync(WEB_DIST)) {
    console.log(`  前端已构建，直接访问 http://localhost:${port}/ 即可`);
  } else {
    console.log(`  前端尚未构建：另开终端跑 npm run web:dev，或 npm run web:build 后直接访问本端口`);
  }
});
