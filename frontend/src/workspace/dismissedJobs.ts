/**
 * 使用者关掉过的“任务失败 / 被中断”提示：按项目记住最近关掉的那个任务。
 *
 * 阶段外壳（ProjectWorkspace）和写作计划页各自显示任务的结束提示，共用这一份记录：
 * 在一处关掉，另一处也不再出现；刷新页面后仍然有效。浏览器不让存时只保留到刷新为止。
 */
const KEY = 'ai-bid-writer:dismissed-interrupted-job:';

const memory: Record<string, string> = {};

export function readDismissedJob(projectId: string): string | null {
  try {
    return window.localStorage.getItem(KEY + projectId) || memory[projectId] || null;
  } catch {
    return memory[projectId] || null;
  }
}

export function writeDismissedJob(projectId: string, jobId: string): void {
  memory[projectId] = jobId;
  try {
    window.localStorage.setItem(KEY + projectId, jobId);
  } catch {
    // 浏览器不让存：关掉的状态只保留到刷新页面为止
  }
}
