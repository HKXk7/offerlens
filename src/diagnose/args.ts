/**
 * `npm run diagnose` 的参数解析 —— 单独放在 src 下而不是塞进 scripts，是为了能单测。
 *
 * 参数解析是最容易「看起来对、跑起来悄悄用错默认值」的地方：
 * 比如 `--runs 0` 会让诊断一次都不跑、`--category 前端` 这种拼错的值会让切片标签
 * 变成脏数据。所以这里一律**校验失败就报错**，不做"猜你想填什么"。
 */

import {
  JOB_CATEGORIES,
  EXPERIENCE_LABEL,
  type ExperienceLevel,
  type JobCategory,
  type JdLevel,
} from '../schema/case.js';

export const JD_LEVELS: readonly JdLevel[] = ['intern', 'junior', 'senior'];
export const EXPERIENCE_LEVELS = Object.keys(EXPERIENCE_LABEL) as ExperienceLevel[];

export interface DiagnoseArgs {
  resumePath: string;
  jdPath: string;
  /**
   * JD 库里的 id（与 jdPath 二选一）。
   *
   * 有它之后就不用每次把 JD 存成文件再喂进来 —— 更重要的是：库里那条 JD 带着
   * 人工标注的 hard_req 与采集来源，诊断报告可以据此说明"门槛覆盖"是对着
   * 标注算的，还是只对着模型当场抽取的结果做交叉校验。这两种口径不能混为一谈。
   */
  jdId: string | null;
  /** 档位 run_id（模型 × prompt）；null = 用当前 key 下的默认档位 */
  profile: string | null;
  /** JD 标题；null = 取 JD 首行 */
  title: string | null;
  company: string;
  category: JobCategory;
  level: JdLevel;
  experience: ExperienceLevel;
  /** 重复次数：>1 才能看出「同一份简历两次诊断是否自相矛盾」 */
  runs: number;
  /** 只做切分与 prompt 预检，不调模型、不花钱 */
  dryRun: boolean;
  /** 只输出 JSON（给脚本用） */
  json: boolean;
  listProfiles: boolean;
  help: boolean;
}

export const DIAGNOSE_USAGE = `用法：
  npm run diagnose -- --resume 简历.md --jd 岗位.txt [选项]
  npm run diagnose -- --resume 简历.md --jd-id jd-real-app-01 [选项]

必填：
  --resume <path>        简历文件（.md / .txt，纯文本）
  --jd <path>            岗位 JD 文件（.md / .txt）
  --jd-id <id>           从 JD 库直接选一条（与 --jd 二选一，用 npm run jd:coverage 查 id）

常用选项：
  --dry-run              只做分段与 prompt 预检，不调用模型、不花钱
  --runs <n>             重复诊断 n 次（默认 1）。>1 可看同一份简历的结论稳不稳
  --profile <run_id>     指定档位，如 sf-dsv4flash__p2-strict（--list-profiles 可查）
  --title <文本>         JD 标题（默认取 JD 首行）
  --list-profiles        列出当前 key 可用的档位
  --json                 以 JSON 输出结果（不打印人读版报告）
  -h, --help             显示本帮助

标签类选项（只影响落盘/切片的归类，不影响诊断本身）：
  --category <${JOB_CATEGORIES.join('|')}>
  --level <${JD_LEVELS.join('|')}>            默认 junior
  --experience <${EXPERIENCE_LEVELS.join('|')}>
  --company <文本>       公司类型描述，默认「未标注」

产出：
  终端报告 + reports/diagnose-<时间戳>.md + data/live/ 下的原始记录（可复算）`;

class ArgsError extends Error {}

/** 校验枚举值，错误信息里带上"合法值有哪些"，别让人去翻源码 */
function pickEnum<T extends string>(value: string, allowed: readonly T[], flag: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new ArgsError(`${flag} 只接受 ${allowed.join(' | ')}，收到「${value}」`);
  }
  return value as T;
}

export function parseDiagnoseArgs(argv: readonly string[]): DiagnoseArgs {
  const get = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    if (i < 0) return null;
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) {
      throw new ArgsError(`${flag} 后面缺少值`);
    }
    return v;
  };

  const help = argv.includes('-h') || argv.includes('--help');
  const listProfiles = argv.includes('--list-profiles');

  const runsRaw = get('--runs');
  let runs = 1;
  if (runsRaw !== null) {
    runs = Number(runsRaw);
    // 0 次 = 什么都不干却退出码 0，是最坑的"假成功"，直接拦住
    if (!Number.isInteger(runs) || runs < 1 || runs > 10) {
      throw new ArgsError(`--runs 需要 1~10 的整数，收到「${runsRaw}」`);
    }
  }

  const resumePath = get('--resume');
  const jdPath = get('--jd');
  const jdId = get('--jd-id');
  if (!help && !listProfiles) {
    if (resumePath === null) throw new ArgsError('缺少 --resume（简历文件路径）');
    if (jdPath === null && jdId === null) {
      throw new ArgsError('缺少 --jd（JD 文件）或 --jd-id（JD 库里的 id），二选一');
    }
    // 两个都传时静默选一个是最坏的处理：用户会以为自己选的是另一个
    if (jdPath !== null && jdId !== null) {
      throw new ArgsError('--jd 与 --jd-id 只能用一个：前者读文件，后者从 JD 库取');
    }
  }

  return {
    resumePath: resumePath ?? '',
    jdPath: jdPath ?? '',
    jdId,
    profile: get('--profile'),
    title: get('--title'),
    company: get('--company') ?? '未标注',
    category: pickEnum(get('--category') ?? 'platform', JOB_CATEGORIES, '--category'),
    level: pickEnum(get('--level') ?? 'junior', JD_LEVELS, '--level'),
    experience: pickEnum(get('--experience') ?? 'rich', EXPERIENCE_LEVELS, '--experience'),
    runs,
    dryRun: argv.includes('--dry-run'),
    json: argv.includes('--json'),
    listProfiles,
    help,
  };
}

export { ArgsError };
