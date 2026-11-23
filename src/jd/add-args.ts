/**
 * `npm run jd:add` 的参数解析。
 *
 * 与 diagnose 同一条原则：**拼错就报错，不猜你想填什么**。
 * 但这里多一条：`source=real` 时 provenance 与 url 是必填的 ——
 * 少了它们，"真实"就只是一句无法核验的自我声明。
 */

import {
  JOB_CATEGORIES,
  type JobCategory,
  type JdLevel,
} from '../schema/case.js';
import { JD_LEVELS } from './store.js';

export type Provenance = 'manual-paste' | 'search-curated';
export const PROVENANCES: readonly Provenance[] = ['manual-paste', 'search-curated'];

export interface JdAddArgs {
  file: string | null;
  title: string | null;
  companyType: string;
  category: JobCategory;
  level: JdLevel;
  source: 'synthetic' | 'real';
  provenance: Provenance | null;
  url: string | null;
  collectedAt: string | null;
  hardReq: string[];
  softReq: string[];
  /** 显式声明"这条 JD 没有可判定的硬门槛"，避免漏传被当成忘了传 */
  noHardReq: boolean;
  id: string | null;
  dryRun: boolean;
  force: boolean;
  help: boolean;
}

export const JD_ADD_USAGE = `用法：
  npm run jd:add -- --file 岗位.txt --title "岗位名" [选项]

必填：
  --file <path>            JD 原文（.txt / .md，纯文本）
  --title <文本>           岗位名称

归类（影响覆盖度矩阵与切片）：
  --category <${JOB_CATEGORIES.join('|')}>        默认 app
  --level <${JD_LEVELS.join('|')}>               默认 junior
  --company-type <文本>    公司类型（大厂 / 创业公司 / 国企…），默认「未标注」

来源标注（--source real 时 provenance 与 --url 必填）：
  --source <real|synthetic>                       默认 real
  --provenance <${PROVENANCES.join('|')}>
                           manual-paste = 从招聘页复制并人工删无关内容
                           search-curated = 据公开检索结果整理（有删节）
  --url <链接>             原始发布页
  --collected-at <ISO8601> 采集时间，默认当前时间

内容：
  --hard-req <a,b,c>       硬门槛词（学历/专业/必会技术栈），逗号分隔
  --soft-req <a,b,c>       软要求（加分项/业务方向）
  --no-hard-req            显式声明这条 JD 没有可判定的硬门槛

其他：
  --id <jd-xxx-NN>         自定义 id，默认自动生成（jd-real-<category>-NN）
  --dry-run                只校验与预览，不写文件
  --force                  允许覆盖同 id 的已有条目
  -h, --help               显示本帮助`;

export class JdArgsError extends Error {}

function pickEnum<T extends string>(value: string, allowed: readonly T[], flag: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new JdArgsError(`${flag} 只接受 ${allowed.join(' | ')}，收到「${value}」`);
  }
  return value as T;
}

function splitList(raw: string | null): string[] {
  if (raw === null) return [];
  return raw
    .split(/[,，、]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function parseJdAddArgs(argv: readonly string[]): JdAddArgs {
  const get = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    if (i < 0) return null;
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) {
      throw new JdArgsError(`${flag} 后面缺少值`);
    }
    return v;
  };

  const help = argv.includes('-h') || argv.includes('--help');
  const noHardReq = argv.includes('--no-hard-req');
  const hardReq = splitList(get('--hard-req'));

  if (noHardReq && hardReq.length > 0) {
    throw new JdArgsError('--hard-req 与 --no-hard-req 不能同时用（一个是"有门槛"，一个是"没有"）');
  }
  // hard_req 为空会让 gate 指标恒为 0，看起来"模型很差"，其实是没标注。必须显式二选一。
  if (!help && hardReq.length === 0 && !noHardReq) {
    throw new JdArgsError(
      '缺少 --hard-req。这条 JD 的硬门槛是什么？' +
        '用 --hard-req "本科,3年以上,TypeScript" 填；确实没有可判定的门槛就用 --no-hard-req 显式声明',
    );
  }

  const source = pickEnum(get('--source') ?? 'real', ['real', 'synthetic'] as const, '--source');
  const provenanceRaw = get('--provenance');
  const url = get('--url');
  const collectedAt = get('--collected-at');

  if (source === 'real') {
    if (provenanceRaw === null) {
      throw new JdArgsError(
        `--source real 时必须指定 --provenance（${PROVENANCES.join(' | ')}）：` +
          '这条 JD 是你自己粘的，还是据检索结果整理的？',
      );
    }
    if (url === null) {
      throw new JdArgsError('--source real 时必须指定 --url（原始发布页），否则来源无法被第三方核验');
    }
  }
  if (collectedAt !== null && !/^\d{4}-\d{2}-\d{2}T/.test(collectedAt)) {
    throw new JdArgsError(
      `--collected-at 需要 ISO 8601 格式（如 2026-11-23T03:00:00Z），收到「${collectedAt}」`,
    );
  }

  return {
    file: get('--file'),
    title: get('--title'),
    companyType: get('--company-type') ?? '未标注',
    category: pickEnum(get('--category') ?? 'app', JOB_CATEGORIES, '--category'),
    level: pickEnum(get('--level') ?? 'junior', JD_LEVELS, '--level'),
    source,
    provenance: provenanceRaw === null ? null : pickEnum(provenanceRaw, PROVENANCES, '--provenance'),
    url,
    collectedAt,
    hardReq,
    softReq: splitList(get('--soft-req')),
    noHardReq,
    id: get('--id'),
    dryRun: argv.includes('--dry-run'),
    force: argv.includes('--force'),
    help,
  };
}
