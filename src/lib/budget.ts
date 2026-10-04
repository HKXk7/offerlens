/**
 * 预算追踪 —— 学生项目最容易死在这里。
 *
 * 为什么必须有硬上限而不是"跑完再看花了多少"：
 *   评测跑批是**循环调用**。一个 bug 让重试逻辑失控、
 *   或者某个模型价格看错一位，等你发现时已经烧掉几百块。
 *   所以要在每次调用后立刻累加，一旦越线就停止派发新任务。
 *
 * 注意这里是"软停止"：已经在飞的那几个请求会跑完（否则会浪费已经产生的 token），
 * 但不会再派发新的。已完成的结果全部保留。
 */

export class BudgetTracker {
  private spent = 0;
  private exceeded = false;
  private readonly limit: number;

  constructor(limitCny: number) {
    if (!Number.isFinite(limitCny) || limitCny < 0) {
      throw new Error(`预算上限必须是非负数，收到 ${limitCny}`);
    }
    this.limit = limitCny;
  }

  /** 累加一次调用的成本。免费模型传 0 也不会出错 */
  add(costCny: number): void {
    if (!Number.isFinite(costCny) || costCny < 0) return;
    this.spent += costCny;
    if (this.spent > this.limit) this.exceeded = true;
  }

  get spentCny(): number {
    return this.spent;
  }

  get limitCny(): number {
    return this.limit;
  }

  remainingCny(): number {
    return Math.max(0, this.limit - this.spent);
  }

  get isExceeded(): boolean {
    return this.exceeded;
  }
}

/** 供池子里每个任务开头检查用 —— 读的是最新状态，不是创建时的快照 */
export function budgetExceeded(tracker: BudgetTracker): boolean {
  return tracker.isExceeded;
}
