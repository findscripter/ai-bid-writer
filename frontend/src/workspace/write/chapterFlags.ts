/**
 * 正文页对单章状态的几个补充判断（章节树、顶部统计、“重试失败章节”共用，说法保持一致）。
 */
import type { ChapterView } from '../../api/types';

/**
 * 重新生成没有成功、保留了原来正文的章节：落盘状态仍是“已完成”，只多了一条失败说明
 * （“重新生成没有成功，已保留原来的正文……”）。它算写完了，但“重试失败章节”要把它算进去再写一次，
 * 章节树上也要标出来，和任务结束时“有 N 章没有写成”的提示对得上。
 * 修订失败（“修订没有成功……”）不算：修订要按当时的修改要求重来，重写会把整章换掉。
 */
export function rewriteFailed(chapter: ChapterView | undefined): boolean {
  if (!chapter || chapter.status !== 'done' || chapter.chars <= 0 || !chapter.error) return false;
  if (chapter.error_kind) return chapter.error_kind === 'rewrite';
  // 旧数据没有 error_kind：按失败说明的开头区分
  return chapter.error.indexOf('修订没有成功') !== 0;
}

/** 写完了、但模型写到了输出上限，结尾可能缺了一截（仍算写完） */
export function endMaybeCut(chapter: ChapterView | undefined): boolean {
  return Boolean(chapter && chapter.status === 'done' && chapter.chars > 0 && chapter.truncated);
}
