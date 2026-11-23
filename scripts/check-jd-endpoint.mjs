#!/usr/bin/env node
/**
 * `/api/jds` 的冒烟检查。
 *
 * 为什么单独一个脚本，而不是只写单测：
 *  `buildJdView()` 的单测证明「给定数据能算出对的视图」，
 *  但证明不了「路由挂对了、JSON 真的能到浏览器」。这两件事失败时的表现完全不同 ——
 *  前者页面数据是错的（很难发现），后者页面整块空白（一眼可见，但要等用户来告诉你）。
 *
 * 它同时能指向线上地址用：
 *   node scripts/check-jd-endpoint.mjs http://127.0.0.1:8787
 *   node scripts/check-jd-endpoint.mjs https://offerlens-eval.app.workbuddy.host XD4PMDP2MG
 *
 * 线上地址要带分享码：托管平台的分享门禁会把不带 sharecode 的请求挡成 403，
 * 而那看起来和「接口挂了」几乎一样 —— 不写清楚，下次自己也会被误导。
 *
 * 退出码：0 通过 / 1 失败。失败时打印实际拿到的内容前 200 字，便于判断是 404、500 还是渲染错误。
 */

const base = (process.argv[2] ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
const sharecode = process.argv[3] ?? '';
const url = `${base}/api/jds${sharecode ? `?sharecode=${encodeURIComponent(sharecode)}` : ''}`;

const fail = (msg, extra) => {
  console.error(`❌ ${msg}`);
  if (extra !== undefined) console.error(String(extra).slice(0, 200));
  process.exit(1);
};

let raw;
try {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  raw = await res.text();
  if (!res.ok) fail(`${url} 返回 HTTP ${res.status}`, raw);
} catch (e) {
  fail(`请求 ${url} 失败（服务没起，或地址不对）`, e instanceof Error ? e.message : e);
}

let data;
try {
  data = JSON.parse(raw);
} catch {
  fail(`${url} 返回的不是 JSON（多半被静态兜底成了 index.html）`, raw);
}

const problems = [];
if (typeof data.total !== 'number') problems.push('缺少 total');
if (!Array.isArray(data.items)) problems.push('items 不是数组');
else if (data.items.length !== data.total) {
  problems.push(`total(${data.total}) 与 items 条数(${data.items.length}) 不一致`);
}
if (!data.coverage?.bySource?.synthetic || !data.coverage?.bySource?.real) {
  problems.push('缺少 bySource.synthetic / bySource.real（页面靠它区分合成与真实）');
}
if (!data.labels?.categoryOrder || !data.labels?.levelOrder) {
  problems.push('缺少行列顺序标签（前端按它渲染矩阵）');
}
// 真实 JD 必须带来源链接：没有链接的"真实"只是一句自我声明
const realMissingUrl = (data.items ?? []).filter((x) => x.source === 'real' && !x.source_url);
if (realMissingUrl.length > 0) {
  problems.push(`${realMissingUrl.length} 条真实 JD 缺 source_url`);
}

if (problems.length > 0) fail(`${url} 数据不完整：${problems.join('；')}`, JSON.stringify(data).slice(0, 200));

const { synthetic, real } = data.coverage.bySource;
console.log(
  `✅ ${url} 正常：共 ${data.total} 条（合成 ${synthetic.count} · 真实 ${real.count}）` +
    `，缺口 ${data.coverage.gaps.length} 格，原文均长 ${synthetic.avgRawLength} / ${real.avgRawLength} 字`,
);
