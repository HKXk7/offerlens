# OfferLens

![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-339933?logo=nodedotjs&logoColor=white)
![React](https://img.shields.io/badge/React-61DAFB?logo=react&logoColor=black)
![Vite](https://img.shields.io/badge/Vite-646CFF?logo=vite&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-003B57?logo=sqlite&logoColor=white)
![Vitest](https://img.shields.io/badge/Vitest-6E9F18?logo=vitest&logoColor=white)

[![CI](https://github.com/HKXk7/offerlens/actions/workflows/ci.yml/badge.svg)](https://github.com/HKXk7/offerlens/actions/workflows/ci.yml)
[![在线 Demo](https://img.shields.io/badge/Demo-在线演示-2ea44f)](https://offerlens-eval.app.workbuddy.host/?sharecode=XD4PMDP2MG)

**把「换了模型 / 改了 prompt 之后，效果到底有没有变好」变成可复现、可统计检验的结论。**

一份简历 × 一份 JD 进去，Agent 产出改进建议；平台负责回答一个更难的问题：
**这次改动是真的变好了，还是只是看起来变好了？**

仓库里是三层东西：

| 层 | 是什么 | 位置 |
| --- | --- | --- |
| **内层 · 被测对象** | 求职诊断 Agent：4 步，读 JD → 在简历里找证据 → 归一匹配 → 产出**带出处**的建议 | `src/agent/` |
| **外层 · 评测平台** | 造评测集、算指标、判显著、落库、出报告 | `src/metrics/` `src/stats/` `scripts/` |
| **展示层 · Web 控制台** | 榜单 / 对比矩阵 / 切片下钻 / case 详情 + trace 瀑布图，可交互可视化 | `web/` `src/server/` |

技术栈一句话：**React 18 + Vite + TanStack Table 前端 → 零依赖 Node HTTP API → 复用同一套指标/统计纯函数 → SQLite/JSONL**，前后端分离。

要解决的**不是**「怎么调大模型」——那是件容易的事。难的是**「怎么证明一次改动真的有用」**：
LLM 输出没有标准答案，24 组样本里的「2.31 → 2.34」大概率只是噪声。
这个仓库就是那套证明流程的完整实现：数据怎么造、指标怎么算、差异怎么判显著、结果怎么落库、报告怎么出。

> **不需要 API key、不需要数据库、不需要 Docker。**
> `npm run demo` 五秒跑通全流程，离线、零成本。

---

## 目录

- [快速开始](#快速开始)
- [诊断你自己的一份简历](#诊断你自己的一份简历单条)
- [JD 库：评测集的输入从哪来](#jd-库评测集的输入从哪来)
- [接入真实模型](#接入真实模型)
- [指标体系：没有标准答案时怎么评测](#指标体系没有标准答案时怎么评测)
- [它跑出来长什么样](#它跑出来长什么样)
- [Web 控制台（可视化）](#web-控制台可视化)
- [命令速查](#命令速查)
- [项目结构](#项目结构)
- [设计取舍](#设计取舍)
- [接入新模型时的注意事项](#接入新模型时的注意事项)
- [把平台用在你自己的 Agent 上](#把平台用在你自己的-agent-上)
- [常见问题](#常见问题)
- [License](#license)

---

## 快速开始

### 环境要求

- **Node.js ≥ 22.5.0**（用到内置的 `node:sqlite`，无任何原生依赖；开发环境为 22.22，版本号也写在 `.nvmrc` 里）
- 没了。不需要装数据库、不需要 Docker

### 跑通（约 1 分钟，不花钱）

```bash
git clone https://github.com/HKXk7/offerlens.git
cd offerlens

npm install
npm run db:init       # 建库：9 张表 + 索引
npm run cases:build   # 生成 24 组评测集（固定种子，结果可复现）
npm run demo          # 端到端：造数据 → 算指标 → 判显著 → 落库 → 出报告
```

`npm run demo` 用**合成数据**在几秒内跑完全链路，输出四段：指标口径校验 / 载荷稳定性 / 对比矩阵 / 落库结果。

> ⚠️ demo 的数据是脚本用固定种子生成的，**只能证明管线连通，不能当任何结论使用**。

### 跑测试

```bash
npm test          # 213 个单测（统计手算值、指标口径、抽样确定性、接入层断链检测、运行器前置校验、落库外键顺序、入口守卫、简历切分与诊断参数、JD 库指纹与覆盖度、JD 视图层不合并统计）
npm run typecheck # tsc --noEmit
```

### CI 在守什么

每次 push / PR 触发三个 job，全部**不花一分钱、不需要 API Key**：

| Job | 步骤 | 守的是什么 |
| --- | --- | --- |
| `test` | `tsc --noEmit` + 213 个单测 | 指标口径改一个符号，结论就会系统性偏，必须有回归保护 |
| `pipeline` | `db:init → cases:build → demo → seed:demo` | 「fork 下来不填 key 也能跑通」是 README 的承诺，这条在守承诺本身 |
| `pipeline` | 同一份数据重算两次，`diff` 必须为空 | 「可复现」的最小可验证形式；种子或排序一乱，两次跑出的报告就不可比 |
| `pipeline` | `diagnose --dry-run examples/*` | 单条诊断的切分链路还能不能跑通（不调模型、不花钱） |
| `pipeline` | `jd:coverage` | JD 库自洽：指纹与正文一致、无重复导入、真实样本都标了来源 |
| `pipeline` | `diagnose --jd-id jd-real-platform-01 --dry-run` | 从 JD 库取岗位这条入口没断（依赖 jds.json 里那条 id 真实存在） |
| `web` | `tsc + vite build`，并确认 `dist/index.html` 产出 | 前端类型错不该等到部署才发现 |

其中**「重算两次 diff 为空」这一条，是这个仓库里最像它自己的东西**：
一个号称「可复现」的评测平台，如果连自己的报告都不能逐字复现，那所有显著性结论都是空的。

> Actions 页里那条**红色**的历史运行是留着的证据，不是没修好的故障：
> [run #45030665168](https://github.com/HKXk7/offerlens/actions/runs/45030665168) 挂在 `离线端到端 demo`，
> 正是下面第 1 个 bug；修复后同一条管线全绿。想验证「这套检查真的会挂」，点进去看那一步的日志即可。

> **CI 上线当天就抓到两个真 bug，都是「只在新机器上出现」的那类：**
>
> 1. **全新的库上 `npm run demo` 直接崩**：`result.case_id` 对 `eval_case` 有外键约束，
>    而 `npm run cases:build`（不带 `--db`）并不写库 → 往空表插 result → `FOREIGN KEY constraint failed`。
>    在开发机上永远复现不了，因为本地库里早就有历史数据。
> 2. **`npm run cases:build` 在某些机器上静默空跑**：入口守卫比的是
>    `resolve(argv[1]) === fileURLToPath(import.meta.url)`，而工作目录被 junction / 符号链接过时
>    这两条路径字面值永不相等 → `main()` 从不被调用，不报错、退出码 0、什么都不打印。
>
> 两条都补了回归测试（`tests/db.test.ts` / `tests/entry.test.ts`），
> 后者用符号链接构造出那个「字面值不等但其实是同一个文件」的场景。

---

## 诊断你自己的一份简历（单条）

前面的命令都是「造评测集、跑批量」。如果你只想知道**自己这份简历投这个岗位该怎么改**，
用 `diagnose`：一份简历 + 一份 JD，一次调用，出**带出处**的建议。

```bash
cp examples/sample-resume.md my-resume.md        # 换成你自己的简历
npm run diagnose -- --resume my-resume.md --jd examples/sample-jd.txt --dry-run   # 先看切分对不对，不花钱
npm run diagnose -- --resume my-resume.md --jd examples/sample-jd.txt             # 真跑一次
npm run diagnose -- --resume my-resume.md --jd examples/sample-jd.txt --runs 3    # 跑三次看结论稳不稳
```

一次约 **¥0.015**（2295 in / 935 out / 19s，实测数据）。

输出四段：**硬门槛逐条核对**（命中 / 部分 / 缺失 + 证据段）→ **建议**（每条对应到简历的具体某一段）
→ **口径自检**（带锚点覆盖率、无源实体率、假锚点数）→ **成本与耗时**。

同时落三份东西，全部在 `.gitignore` 里：

| 产物 | 路径 | 用途 |
| --- | --- | --- |
| Markdown 报告 | `reports/diagnose-<时间戳>.md` | 可以发给别人看的那份 |
| 运行记录 | `data/live/runs-<时间戳>.jsonl` | 与批量评测同格式，可复算 |
| 输入快照 | `data/live/inputs/<case>.json` | 事后核对「锚点是不是指对了段」 |

**它和批量评测的区别，是刻意分开的：**

| | `npm run eval` | `npm run diagnose` |
| --- | --- | --- |
| 输入 | 24 组人工拆好的评测集 | 你的纯文本简历 + 真实 JD |
| 回答 | 模型 / prompt 改得好不好 | 我这份简历该怎么改 |
| 统计 | 多次重复 + 显著性检验 | 单次（`--runs 3` 才看稳定性） |
| 落盘 | `data/real/`，进报告、进榜单 | `data/live/`，**不进评测集** |

为什么不让诊断进评测集：`data/cases/` 是 24 组固定评测集，混进一条真实简历会破坏
「换台机器能复现同一批 case」这个前提，排名和显著性就都不能再比了。所以诊断走独立目录。

> ⚠️ **简历和 JD 会被发给模型厂商。** `data/live/` 与 `reports/diagnose-*.md` 都在 `.gitignore` 里、不会被提交，
> 但**脱敏是你自己的责任**：手机号、身份证号、公司内部项目名，发出去之前先删掉。

切分的三条硬要求（也是 `src/lib/resume-text.ts` 的设计目标）：**确定性**（同一份文本切两次完全一样）、
**自描述**（段文本带上小节名，如 `教育背景：…`，锚点单独摘出来也读得懂）、**不吞内容**（超长段按句读切，不截断）。

纯文本简历怎么整理才好切：**一段一行**，小节名用 `## 教育背景` / `## 项目经历` 这类能识别的词。
双栏排版导出的 txt 会把两栏串成一行，锚点会指错段 —— 这种情况先手工整理一遍，工具的 `--dry-run` 就是给这一步用的。

---

## JD 库：评测集的输入从哪来

评测平台最容易被攻击的一点不是指标算错，而是**样本是编的**：

> "你的 24 组 case 都是合成数据，结论有什么意义？"

一开始 JD 库只有 12 条 `source: synthetic`——按岗位画像手写，措辞刻意写得更规整（为了评测集可控）。这在早期是对的，但它有个副作用：**合成 JD 的硬门槛太干净，门槛命中率天然偏乐观**。

所以补了 JD 库和导入入口。

### 两个命令

```bash
# 导入一条真实岗位
npm run jd:add -- --file 岗位.txt --title "大模型评测研发工程师" \
  --category platform --level senior --company-type "大厂" \
  --source real --provenance manual-paste --url https://example.com/job/1 \
  --hard-req "本科及以上,3年以上平台研发经验,Python,Linux"

# 看覆盖矩阵、缺口与数据质量
npm run jd:coverage
```

`--source real` 时 `--provenance` 与 `--url` 是**必填**的。少了它们，"真实"就只是一句无法核验的自我声明。

导入时会算 `content_hash`（`raw` 的 sha256 前 12 位，基于规范化后的文本）：同一份 JD 换个换行方式复制两次，指纹相同，会被判为重复而不是两条。重复条目会让覆盖度统计虚高。

### 现在的实际数字

| | 合成 | 真实 |
| --- | --- | --- |
| 条数 | 12 | 11 |
| 原文平均字数 | 188.9 | **673.9（3.57×）** |
| 硬门槛平均条数 | 5.3 | 6.0 |
| 覆盖矩阵 | 3 类 × 3 档 | 补上了原缺口 `business/senior` |

原文长度差 3.57 倍不是"真实 JD 更详细"这么简单。多出来的部分是：福利条款、公司介绍、软性套话、以及**与岗位名不符的要求**。

两个真实例子，合成数据不会出现：

- **标题与要求脱节**：某条岗位叫「前端开发工程师（AI 应用）」，任职要求里却一个前端技术都没提，全是 Python / PyTorch / LangChain。合成 JD 是按岗位画像反推的，不会犯这种错。
- **劝退条款**：真实 JD 会写「乙方公司有驻点、外派要求，如有顾虑请谨慎投递」「长期驻场，介意勿投」。

### 为什么不写爬虫

我明确没有做自动抓取。这不是技术上做不到，而是三件事同时发生：

1. **页面内容被插了反爬水印。** 真实抓下来的正文长这样：

   ```
   职BOSS直聘位描述          → 职位描述
   计boss算机/软件工程相关专业  → 计算机/软件工程相关专业
   前端开来自BOSS直聘发        → 前端开发
   ```

   这些字符插在词中间，会打断 `TypeScript`、`Docker` 这类硬门槛词的匹配。自动抽取必须先做水印清洗，而清洗规则随平台改版随时失效。

2. **合规风险与项目主线无关。** 反爬对抗是另一个工程领域，跟"评测做得对不对"没有关系，写进简历只会招来"你怎么处理用户协议"的反问。

3. **会破坏刚建立的可复现前提。** 爬一次就是一份新数据，而 `data/cases/` 的立身之本是"同一版本、换台机器、结论一致"。

所以入口刻意是**半自动**的：人负责获取和判断（这份 JD 是不是真的、字段归类对不对），工具负责校验、去重、算指纹、保证格式一致。这也正是数据标注该有的分工。

`data/jd/incoming/` 里留着导入用的源文件，每条都在 `jds.json` 里有 `source_url` 指向原始发布页，可以逐条核验。

### 它和评测集的关系

真实 JD 默认**不进入**固定评测集。要纳进来必须显式开关：

```bash
npm run cases:build -- --include-real   # 版本号会变成 ds-v1-real-seed<seed>
```

原因在「设计取舍」里也写过：`data/cases/` 是 24 组固定 case，历史 run 的结论能互相比较，全靠这个固定性。真实 JD 会过期、会新增，混进来就等于让评测集随时间漂移。开关开着时版本号会自动变，避免"同一个版本号对应两份不同内容"。

实测：开启后 23 条 JD 的池子里抽 24 组，其中 **8/24 组用到了真实 JD**。

---

## 接入真实模型

### 1. 配置 key

```bash
cp .env.example .env
```

**只改 `.env`，一行代码都不用动。** 评测矩阵和裁判模型会按你手上有的 key 自动切换。

| `.env` 键 | 用途 | 拿到它的成本 |
| --- | --- | --- |
| `SILICONFLOW_API_KEY` | **推荐**：跨厂商生成矩阵 + 跨族裁判（一个 key 同时解决两侧） | 充值。实测全矩阵 288 次 ≈ **¥2.3** |
| `ZHIPU_API_KEY` | 生成侧（GLM-4.5/4.7-Flash） | **永久免费**，注册即用 |
| `DEEPSEEK_API_KEY` | 生成侧对照组 | 充值，约 ¥0.01–0.05 / 次 |
| （不填） | Ollama 本地模型，`--profile` 指向即可 | ¥0 |

矩阵会自动切换：有硅基流动 key → 跨厂商 4 档位；只有 DeepSeek → DeepSeek 单变量对照；都没有 → 智谱免费档兜底。

### 2. 按顺序跑（别一上来就跑全量）

```bash
npm run eval:dry     # ① 只打印将要发出的 prompt，不发请求 —— 花钱前先看
npm run eval:smoke   # ② 冒烟：4 组 case × 1 次
npm run eval         # ③ 全量：24 组 × 矩阵全部档位 × 3 次重复
npm run eval:report  # ④ 只按已落盘数据重出报告，不重跑、不花钱
```

断了直接重跑即可：已完成的 `(run_id, case_id, run_index)` 会被跳过。

### 3. 常用参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--limit N` | 全部 | 只跑前 N 组 case（冒烟用） |
| `--runs N` | 3 | 每组的重复次数（`pass^k` 需要 ≥ 2） |
| `--profile a,b` | 全部 | 只跑指定档位，如 `--profile sf-qwen35-122b__p2-strict` |
| `--no-judge` | 关 | 跳过裁判（省一半钱，但拿不到可执行性得分） |
| `--budget N` | 100 | **硬上限**（元）。超线立刻停止派发新任务，在飞的请求跑完、已完成结果保留 |
| `--concurrency N` | 4 | 并发数 |
| `--report-only` | — | 不生成、只汇总（等价 `npm run eval:report`） |
| `--dry-run` | — | 只打印 prompt |

### 4. 支持的平台与模型

矩阵按 key 自动选，价格写在 `src/agent/catalog.ts`。接新平台只需在 `PROVIDERS` 里加一条（OpenAI 兼容接口）。

| 平台 | 生成侧 | 裁判侧 |
| --- | --- | --- |
| 硅基流动（中国站） | DeepSeek-V4-Flash / Qwen3.5-122B-A10B / Qwen3.5-27B / GLM-4.5-Air | 腾讯 Hunyuan-A13B-Instruct |
| DeepSeek 官方 | deepseek-flash（V4.1-Flash） | deepseek-v4-pro |
| 智谱 | GLM-4.5-Flash / 4.7-Flash | — |
| Ollama（本地） | 任意模型 | 任意另一个模型 |

---

## 指标体系：没有标准答案时怎么评测

**「简历诊断没有标准答案，你怎么知道建议是对的？」** —— 这是整个项目的地基，
答不上来，前面所有数字都会被当成自嗨。

所以这里所有指标都是**代理指标（proxy metric）**，每一个都写清三件事：
**测什么、怎么抽、已知误报来源**。地面真值只有一个：**人工标注**（其余全是代理）。

| 指标 | 它实际在测什么 | 已知误报来源 / 怎么校准 |
| --- | --- | --- |
| **无源实体率** | 建议里出现的实体（技术名词 / 数字 / 项目名），有多少在**简历 + JD 原文**里找不到出处 | 词典外的新技术会误判；用「白名单 + 归一化 + 豁免规则」压制，并要求报 P/R/F1 而不是一个裸百分比 |
| **硬门槛覆盖率** | JD 的硬性要求里，建议覆盖了几条 | 靠关键词命中会虚高 → 必须带**真实存在的段 ID 锚点**才算数，抄 JD 原文拿不到分 |
| **建议可执行性（1–3）** | 这条建议「能不能照着做」 | LLM-as-judge 会自证 → judge 与生成侧**必须换族**，并用人工标注算 Cohen's κ 校准 |
| **pass^k** | 同一配置重复跑 k 次、**每次都过**的 case 比例 | 只看单次成功率会掩盖「时好时坏」；pass^k 就是用来暴露这一档的 |
| **步骤级指标** | 步数、token、耗时、重试、死循环 | 非确定轨迹不能按 step 序号做跨版本 diff（见[设计取舍](#设计取舍)） |

两个刻意的口径设计：

- **无源实体率报两个数**。严口径把「填写示例里的实体」也算无源；另一种口径只统计对简历的**断言**。
  例：建议写「例如：每 15s 发心跳 ping」——`15s` 不在简历里，规则判它无源没错，但它是**模板**不是事实断言。
  两个数都印在报告里，因为**哪个更对取决于想问什么**，不该由代码单方面决定。
- **资源类差异会被折叠**。一个模型整体贵 0.03 元，会在 6 个切片上复读 6 条「成本显著更差」，
  把真正的质量退化挤到看不见。`partitionFindings` 只保留能力类差异，资源类单独汇总。

---

## 它跑出来长什么样

跨厂商实测（硅基流动中国站，4 档位 × 24 组 case × 3 次重复 = 288 次真实运行，跨族裁判）：

| 档位 | 模型 | 产出率 | 无源实体率 | 达标率 | pass³ | 单次成本 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| `sf-qwen35-122b` | Qwen3.5-122B-A10B | 1.000 | **0.087** | **0.653** | **0.500** | ¥0.0072 |
| `sf-dsv4flash` | DeepSeek-V4-Flash | 1.000 | 0.109 | 0.625 | 0.375 | ¥0.0125 |
| `sf-qwen35-27b` | Qwen3.5-27B | 1.000 | 0.103 | 0.597 | 0.417 | **¥0.0049** |
| `sf-glm45-air` | GLM-4.5-Air | **0.583** | 0.057 | 0.431 | 0.167 | ¥0.0038 |

三个只有跑过才看得出来的点：

1. **「产出率」必须放在第一列。** GLM-4.5-Air 有 42% 的运行根本产不出合法 JSON
   （它会在 JSON 字符串里写未转义的中文引号）。把这 30 次混进质量均值，
   无源实体率会被算成 0.033 —— **「什么都产不出来」被记成了「最干净」**。
2. **pass³ 最高只有 0.500**，全部档位的不稳定率在 29%–54%。
   这批数据不支持「接一个模型上线就完事」，得配回归监控。
3. **榜单看不出工程可用性。** 同批实跑筛掉了 4 个候选：输出被服务端默认上限截断的、
   关不掉思考链导致成本不可控的、正文返回空内容的、单步 90 秒超时的。

完整报告生成在 `reports/real-*.md`（含显著性检验、切片下钻、诚实说明）。

---

## Web 控制台（可视化）

除了 Markdown 报告，还带一个**可视化控制台**：把「榜单 / 对比矩阵 / 切片下钻 / case 详情 + trace 瀑布图」
做成可交互界面，并且能**直接在 Web 端触发一次评测跑批**（前后端完整闭环，不再是只读看板）。

**架构**：`React 18 + Vite + TanStack Table 前端 → 零依赖 Node HTTP API（`node:http`）→ 复用同一套指标/统计纯函数 → SQLite/JSONL`。
前后端分离；读接口只读、只算（秒开），写接口（触发评测）走后台 job + SSE 实时推送，不阻塞 HTTP。

### 在线 Demo（零安装，直接点开）

已部署在线版本，任何人点开就能看：

> **https://offerlens-eval.app.workbuddy.host/?sharecode=XD4PMDP2MG**

线上为**只读演示**（无 API Key）：榜单 / 对比矩阵 / case 详情 + trace 瀑布图都能交互查看，
「运行评测」页可预览 prompt（dry-run，不发请求不花钱），完整跑批需本地运行。

### 启动（不花一分钱，零 API key）

```bash
npm run seed:demo     # ① 生成合成演示数据（data/real 为空时控制台会自动回退到它）
npm run web:build     # ② 构建前端（web/dist 是产物、不进仓库，只需跑这一次）
npm run serve         # ③ 启动 API + 静态托管，浏览器打开 http://localhost:8787
```

> 漏掉第 ② 步也不会白屏或看到裸 JSON —— 后端会返回一张引导页，直接告诉你缺哪条命令、
> 并给出在线 Demo 的入口。这种「一步之差」是最容易被放弃的位置，值得专门处理。

clone 下来没跑过真实评测时，控制台会自动展示**合成演示数据**（页面顶部有黄条标注），
保证「clone → serve → 看到有数据的榜单」三步走通。接入真实模型后跑一次 `npm run eval`，
控制台会自动切到真实结果。

### 开发模式（前端热更新）

```bash
npm run serve        # 后端（8787）
npm run web:dev      # 前端 Vite 开发服务器（5173，自动代理 /api → 8787）
```

### 五个视图 + 一个入口

| 视图 | 回答什么 | 关键点 |
| --- | --- | --- |
| **模型榜单** | 哪个模型 × prompt 最好 | 可排序；「达标率 / pass³ / 锚点覆盖」越高越好，带 ↓ 的越低越好 |
| **对比矩阵** | 这次改动到底有没有变好 | 每个格子带「显著更好 / 显著更差 / 不显著」角标 + McNemar p 值或 95% CI |
| **切片下钻** | 哪个子集偷偷退化了 | 能力类指标全保留，资源类（成本/延迟）折叠 |
| **Case 详情** | 单条 case 模型读到了什么、产出了什么 | 脱敏简历 + JD 硬门槛 + 三次重复建议 + trace 瀑布图 |
| **JD 库** | 我的样本够不够、来自哪里 | 覆盖矩阵（0 条的格子标红，区分「0 分」与「没测过」）+ 合成/真实分开统计 + 逐条来源可回溯 |
| **运行评测** | 在 Web 端触发一次真实评测 | 选档位/规模/预算 → 后台跑批 → 实时进度 + 日志 → 完成自动刷新榜单 |

「JD 库」是唯一不以跑分为主的视图，存在的理由很直接：**榜单上每个数字的适用范围都由样本决定**。
`business/senior` 一格 0 条却和 `app/junior` 并列展示时，读者会以为「各档位都有结论」——
实际上那一档什么都没测过。所以缺口必须标红，合成与真实必须分两行统计。

「运行评测」把原来的 CLI 跑批搬进了 Web：`POST /api/eval` 启动后台 job，前端用 SSE
（`/api/eval/stream`）实时接收进度与日志（SSE 不可用时自动降级轮询），完成即失效分析缓存、
榜单自动刷新。核心逻辑与 CLI 共用同一个 `src/eval/runner.ts` 的 `runEval()`
（`scripts/run-eval.ts` 只是它的终端封装，参数解析 + 把事件渲染成终端输出）。

前端在 `web/`（独立 npm 工程），后端在 `src/server/`（复用 `src/metrics/` 与 `src/stats/` 的纯函数，
**一行指标逻辑都没重复实现**）。

---

## 命令速查

```bash
# 数据与管线
npm run db:init        # 建库
npm run cases:build    # 生成 24 组评测集（固定种子）
npm run demo           # 离线端到端演示（零成本）
npm run diagnose -- --resume 简历.md --jd 岗位.txt   # 单条诊断（你的真实简历）
npm run diagnose -- --resume 简历.md --jd-id jd-real-platform-01   # 从 JD 库按 id 选岗位

# JD 库
npm run jd:add -- --file 岗位.txt --title "岗位名" --category app --level senior \
  --source real --provenance manual-paste --url https://... --hard-req "本科,TypeScript"
npm run jd:coverage    # 覆盖矩阵 + 缺口 + 数据质量（--json 可机读）

# 真实模型
npm run eval:dry       # 只打印 prompt
npm run eval:smoke     # 冒烟：4 组 × 1 次
npm run eval           # 全量
npm run eval:report    # 只重出报告

# 质量
npm test
npm run typecheck

# Web 控制台
npm run seed:demo       # 生成合成演示数据（零 key）
npm run serve           # 启动 API + 托管前端（http://localhost:8787）
npm run web:dev         # 前端开发服务器（热更新）
npm run web:build       # 构建前端到 web/dist
```

---

## 项目结构

```
offerlens/
├── .github/workflows/ci.yml   # CI：类型 + 单测 + 零成本管线 + 可复现性 + 前端构建
├── schema/schema.sql          # 9 张表 + 索引 + schema_version
├── src/
│   ├── agent/                 # 被测对象 + 模型接入
│   │   ├── llm.ts             # 零依赖 OpenAI 兼容客户端（重试/超时/JSON 抽取/记账/降级）
│   │   ├── catalog.ts         # 平台、模型价格、输出上限、评测矩阵、跨族裁判选择
│   │   ├── prompts.ts         # 两版 prompt（p1-baseline / p2-strict）+ 裁判 prompt
│   │   ├── offerAgent.ts      # 内层 Agent：4 步 + 锚点存在性校验
│   │   └── llmJudge.ts        # 裁判：正反序去偏 + 位置/长度偏见量化
│   ├── metrics/
│   │   ├── entities.ts        # 实体抽取 / 归一化 / 豁免（最容易被追问的一块）
│   │   ├── unsourced.ts       # 无源实体率（双口径）+ 检测器 P/R/F1
│   │   ├── anchor.ts          # 带锚点的硬门槛覆盖率
│   │   ├── judge.ts           # 可执行性打分 + 与人工标注的一致率（κ）
│   │   ├── passk.ts           # pass^k + 稳定性分档
│   │   └── steps.ts           # 步骤级指标 + 死循环检测
│   ├── stats/                 # 纯函数统计，全部有单测
│   │   ├── distributions.ts   # erf / normalCdf / chi2(df=1)
│   │   ├── mcnemar.ts         # 配对二元检验（连续性校正 + 精确检验）
│   │   ├── bootstrap.ts       # 配对 bootstrap 置信区间（固定种子）
│   │   ├── kappa.ts           # Cohen's κ
│   │   ├── rank.ts            # mean / percentiles / 秩相关（null-safe）
│   │   └── compare.ts         # 对比矩阵 + 切片下钻 + Markdown 导出
│   ├── schema/                # Case / Resume / Jd / Suggestion / StepSpan
│   ├── db/init.ts             # node:sqlite（零原生依赖）+ WAL
│   ├── server/                # Web 控制台后端
│   │   ├── analyze.ts         # 聚合层：读 data/real，复用 metrics/stats 算榜单与对比
│   │   ├── evalJobs.ts        # 评测 job 管理：后台跑批 + 进度/日志 + 前置检查（key/档位）
│   │   ├── jdView.ts          # /api/jds 视图层（纯函数：裁剪 + 排序，不做任何统计合并）
│   │   └── server.ts          # 零依赖 node:http API + 静态托管 web/dist
│   ├── eval/runner.ts         # runEval()：评测核心，CLI 与 Web 共用同一份
│   ├── diagnose/              # 单条诊断：args（参数校验） / report（终端 + Markdown 渲染）
│   ├── jd/                    # JD 库：store（规范化/指纹/去重） / coverage（覆盖度） / add-args
│   └── lib/                   # prng（可复现）/ jsonl / budget / env / resume-text（简历切分）
├── data/
│   ├── jd/jds.json            # JD 库：12 条合成 + 11 条真实（4 类岗位 × 3 档）
│   ├── jd/incoming/           # 真实 JD 的导入源文件（逐条对应 jds.json 里的 source_url）
│   ├── resumes/resumes.json   # 4 份合成简历（丰富/单薄/转行/残缺）
│   ├── cases/                 # 24 组评测集（脚本生成）
│   └── demo/                  # 合成演示数据（无 key 时控制台的回退来源，随仓库分发）
│       └── traces/            #   预生成的 trace，供 case 详情瀑布图直接可用
├── web/                       # 前端：React 18 + Vite + TanStack Table（独立 npm 工程）
│   └── src/                   #   App / Leaderboard / CompareView / CaseDetail / JdLibrary / RunEval
├── scripts/
│   ├── init-db.ts
│   ├── build-cases.ts         # 固定种子分层抽样 → 24 组
│   ├── demo.ts                # 离线端到端
│   ├── diagnose.ts            # 单条诊断 CLI（真实简历 × 真实 JD）
│   ├── jd-add.ts              # 导入一条真实 JD（校验 / 去重 / 算指纹）
│   ├── jd-coverage.ts         # 覆盖矩阵 + 缺口 + 数据质量
│   ├── seed-demo-runs.ts      # 生成合成演示数据
│   └── run-eval.ts            # 评测 CLI（薄封装，核心在 src/eval/runner.ts）
├── examples/                  # 可直接跑的样例简历与 JD
├── tests/                     # 213 个单测
└── reports/                   # 生成的对比报告
```

---

## 设计取舍

**1. 不做跨版本轨迹 diff。**
Agent 是非确定的，同一输入跑两次 step 序列可能完全不同。按 step 序号 + 工具名做 LCS 对齐会产出大量碎片和假分叉点。改用 **task 级翻转列表**：只问「这组 case 的通过状态翻了吗」，不问「第几步开始不一样」。

**2. 不做 Elo / pairwise 排名。**
样本量小时 Elo 置信区间宽到没有结论。同样的数据改成 **40 条建议人工盲抽检**，用途成立得多。

**3. 检测器必须独立于生成器。**
judge 模型 ≠ 被测模型。否则「自证」会让所有指标失去意义。裁判的选择顺序写死在 `catalog.ts`，同族时会明确打警告。

**4. 「不显著」是个结论，不是「没结果」。**
报告里每个格子都必须带显著/不显著。24 组样本下，「2.31 → 2.34」大概率只是几条 case 的波动。

**5. 幂等性落在主键上。**
`result` 表主键是 `(run_id, case_id, run_index)`，重跑不会重复计数；断点续跑以 runs JSONL 为唯一事实来源。

**6. 预算按「峰时价高估」。**
价格表用峰时价（峰时 = 谷时 2 倍），报告里的成本刻意高估。宁可估高提前停，不能估低跑超。

---

## 接入新模型时的注意事项

这几条是实测踩出来的，不是从文档抄的。**接任何新模型都建议先过一遍**：

- **先确认「关思考」参数能不能生效。** 不同厂商写法不同（`enable_thinking: false` / `thinking: {type: 'disabled'}`），
  有的模型**根本关不掉**。开着思考跑评测，输出 token 会放大一个量级，成本不可控。
  **必须逐个模型实测**，不能按厂商推断。
- **声明了不等于生效。** 参数写在模型配置里、客户端也实现了消费逻辑，中间仍可能断链。
  唯一可靠的验证方式是**拦截真实请求体**做断言（见 `tests/siliconflow-wiring.test.ts`），测函数返回值测不出来。
- **`response_format` 不是所有模型都支持**，有的会直接返回 400。客户端需要能降级重试。
- **一定要显式传 `max_tokens`**。不传就等于把上限交给服务端默认值（常见 4096），
  JSON 会被截断且永远解析不出来。它同时是一道成本护栏。
- **换平台会让历史数据不可比**。第三方转发站与原厂的后端、量化都不同，
  同一批结论必须在同一个平台上跑完，**不能混进同一张表**。
- **模型 ID 以 `/models` 接口为准**，不要信第三方博客：
  ```bash
  curl -H "Authorization: Bearer $API_KEY" https://api.siliconflow.cn/v1/models
  ```

---

## 把平台用在你自己的 Agent 上

外层平台与「求职诊断」这个具体场景是解耦的。要换成你自己的 Agent，只需要改两处：

| 要改的 | 文件 | 做什么 |
| --- | --- | --- |
| 被测对象 | `src/agent/offerAgent.ts` + `prompts.ts` | 实现你的 Agent，产出一个 `Suggestion[]`（每条可带 `anchor_seg_id` 出处） |
| 评测集 | `data/jd` `data/resumes` → 换成你的输入类型 | 或者直接替换 `data/cases/cases.jsonl` |

**不用改的**：`src/metrics/`（指标）、`src/stats/`（统计）、`schema.sql`、落库逻辑、报告生成 —— 这些都与领域无关。

指标本身也能按需裁剪：如果你的场景没有「出处」这个概念，去掉 `anchor.ts` 即可，
其余指标照常工作。

---

## 常见问题

**Q：为什么不用 better-sqlite3？**
它在 Windows 上需要本机编译，是常见的翻车点。`node:sqlite` 是 Node 内置的，零原生依赖，装上就能跑。

**Q：没有 API key 能跑吗？**
能。`npm run demo` 全离线、零成本，`npm run eval:dry` 也能看到将要发出的 prompt。要跑真实评测必须有一个 key。

**Q：跑一次全量要多少钱？**
用硅基流动的 4 档位矩阵，288 次生成 + 裁判约 **¥2.3**。用智谱免费档则是 **¥0**。`--budget` 是硬上限。

**Q：为什么报告里的成本比实际账单高？**
价格按峰时价记账，而峰时是谷时的 2 倍；并且缓存命中的输入 token 会按更低单价单独计价。刻意高估。

**Q：judge 的打分能直接信吗？**
不能。LLM-as-judge 有自证倾向和位置偏见，项目会量化这两者（正反序不一致率、长度-得分的秩相关）并在报告里打警告。
**如果你能给出人工标注（`data/gold/labels.jsonl`），运行时会自动算 judge 与人的一致率和 κ。没有这个文件时，报告会明确写「judge 打分只能当参考」。**

**Q：可以只跑某个模型吗？**
可以。`npm run eval -- --profile sf-qwen35-122b__p2-strict --limit 4`。

**Q：`npm run serve` 打开是 404 / 一片空白？**前端没构建。`web/dist` 是构建产物、不进仓库，先跑一次 `npm run web:build` 再刷新（不用重启后端）。
现在漏了这步会看到一张引导页而不是白屏，照着上面那条命令做即可。

**Q：`npm run diagnose` 会不会把我的简历提交到仓库？**
不会。记录写在 `data/live/`、报告写到 `reports/diagnose-*.md`，两者都在 `.gitignore` 里。
但要清楚**它会被发给模型厂商**（否则没法诊断），所以脱敏仍然是你自己的事。

**Q：诊断结果能不能跟评测报告里的数字放一起比？**
不能。评测集的 `hard_req` 是人工标注的，诊断时的门槛是模型**当场抽**的；前者固定、后者每次可能不同，口径不同不可相加。

---

## License

MIT —— 见 [LICENSE](LICENSE)。可以自由用于学习与二次开发。
