/**
 * 评测集侧的数据结构：Dataset / Case / Resume / JD。
 *
 * 两个关键约束（策划书 3.2）：
 *  1. Resume 用「段 ID」而不是字符 offset——只把脱敏后的分段文本发给模型，
 *     模型回填段 ID 做锚点。既能追溯，又不把整份原文丢给第三方。
 *  2. Case 绑定到 dataset 的某个 version，而不是 dataset 本身——
 *     评测集改一条，历史所有 run 的结论就不可复现。
 */

export type JobCategory =
  /** AI 应用前端 */
  | 'app'
  /** AI 平台 / 基础设施前端 */
  | 'platform'
  /** 数据平台前端 */
  | 'data'
  /** 普通业务前端 */
  | 'business';

export const JOB_CATEGORIES: readonly JobCategory[] = ['app', 'platform', 'data', 'business'];

export const JOB_CATEGORY_LABEL: Record<JobCategory, string> = {
  app: 'AI 应用前端',
  platform: 'AI 平台前端',
  data: '数据平台',
  business: '普通业务前端',
};

/** 简历的"经历丰厚度"分层——切片下钻就是按它切。 */
export type ExperienceLevel = 'rich' | 'thin' | 'career_change' | 'incomplete';

export const EXPERIENCE_LABEL: Record<ExperienceLevel, string> = {
  rich: '经历丰富（2 段实习）',
  thin: '经历单薄（无实习）',
  career_change: '转行（专业不对口）',
  incomplete: '字段残缺（无竞赛无项目）',
};

export type JdLevel = 'intern' | 'junior' | 'senior';

export interface ResumeSegment {
  /** 段 ID，如 S03。这是锚点的唯一标识，必须稳定 */
  seg_id: string;
  /** 脱敏后的分段正文 */
  text: string;
}

export interface Resume {
  id: string;
  /** 脱敏后的匿名 id，展示用 */
  anon_id: string;
  headline: string;
  experience_level: ExperienceLevel;
  /** 专业是否对口——用于判定"转行"类硬门槛不匹配 */
  major_related: boolean;
  segments: ResumeSegment[];
  skills: string[];
  internships: string[];
  projects: string[];
}

export interface Jd {
  id: string;
  title: string;
  company_type: string;
  category: JobCategory;
  level: JdLevel;
  /** 原始 JD 文本（投递网站上抓下来的原文） */
  raw: string;
  /** 硬门槛词：学历 / 专业 / 必会技术栈。判定覆盖率就用它 */
  hard_req: string[];
  /** 软要求：加分项、业务方向 */
  soft_req: string[];
  /** 数据来源标记。placeholder = 待替换成真实抓取的 JD */
  source: 'synthetic' | 'real';
}

export interface Case {
  id: string;
  dataset_version: string;
  resume_id: string;
  jd_id: string;
  /** 分层标签，切片下钻和统计平衡都靠它 */
  tags: {
    category: JobCategory;
    experience_level: ExperienceLevel;
    level: JdLevel;
  };
  /** 难例：简历与岗位明显不匹配（命中数量奇低的那种） */
  is_hard_negative: boolean;
  /** 埋的标准答案 case，用于长期监控与抽检质检 */
  is_golden: boolean;
}

export interface Dataset {
  id: string;
  version: string;
  /** 抽样种子。写进 dataset，保证别人拿到同一版本能复现同一批 case */
  seed: number;
  created_at: string;
}

/* ------------------------------------------------------------------ */
/* Agent 输出侧                                                        */
/* ------------------------------------------------------------------ */

export type SuggestionKind = 'improve' | 'missing' | 'hit';

/** Agent 输出的一条建议。anchor_seg_id 为 null = 无出处，不计入覆盖率分子。 */
export interface Suggestion {
  id: string;
  case_id: string;
  run_id: string;
  run_index: number;
  kind: SuggestionKind;
  text: string;
  /** 绑定到的简历段 ID；null 表示这条建议没有出处 */
  anchor_seg_id: string | null;
}

/** 人工标注的标准答案（每组的"地面真值"）。 */
export interface GoldLabel {
  case_id: string;
  /** 人工判定：该组简历命中了哪些硬门槛 */
  covered_gates: string[];
  /** 人工判定：Agent 的每条建议是否可执行（1-3 分） */
  suggestion_scores: Record<string, number>;
  /** 人工判定：每条建议是否算"无源/编造" */
  unsourced_suggestion_ids: string[];
  annotator: string;
  notes?: string;
}
