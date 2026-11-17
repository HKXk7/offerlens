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
import { currentJob, jobHistory, startEval } from './evalJobs.js';
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
      });
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
// 只监听本机回环地址：这是本地开发/演示工具，不该暴露到局域网。
server.listen(port, '127.0.0.1', () => {
  console.log(`OfferLens Web API 已启动：http://localhost:${port}`);
  console.log(`  榜单      GET http://localhost:${port}/api/leaderboard`);
  console.log(`  对比矩阵  GET http://localhost:${port}/api/compare?base=sf-dsv4flash__p2-strict&cand=sf-qwen35-122b__p2-strict`);
  if (existsSync(WEB_DIST)) {
    console.log(`  前端已构建，直接访问 http://localhost:${port}/ 即可`);
  } else {
    console.log(`  前端尚未构建：另开终端跑 npm run web:dev，或 npm run web:build 后直接访问本端口`);
  }
});
