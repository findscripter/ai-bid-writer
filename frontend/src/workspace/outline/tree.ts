/**
 * 目录树的纯函数：定位、统计，以及每种编辑操作对应的“新目录树”。
 *
 * 约定（与后端保存目录时的规则对应）：
 * - 已有节点原样保留——包括稳定标识和后端带来的其他字段，这样已写的正文和写作计划还能对上；
 * - 新节点不带稳定标识，由后端在保存时分配；
 * - 显示编号不用管，后端每次保存都会按位置重排。
 *
 * 所有“改目录”的函数都不修改入参，返回一棵新树；做不了（节点不存在、已经在最前面等）时返回 null。
 */
import type { OutlineNode } from '../../api/types';

/** 提交给后端的目录节点：新加的节点没有 uid */
export interface DraftNode extends Omit<OutlineNode, 'uid' | 'children'> {
  uid?: string;
  children?: DraftNode[];
}

export interface NodeLocation {
  node: OutlineNode;
  parent: OutlineNode | null;
  /** 所在的同级列表 */
  siblings: OutlineNode[];
  /** 在同级列表里的位置 */
  index: number;
  /** 层级：一级章节为 1 */
  level: number;
}

export function isLeaf(node: { children?: unknown[] }): boolean {
  return !node.children || node.children.length === 0;
}

/** 按稳定标识找到节点及其位置 */
export function locate(outline: OutlineNode[], uid: string): NodeLocation | null {
  const walk = (items: OutlineNode[], parent: OutlineNode | null, level: number): NodeLocation | null => {
    for (let i = 0; i < items.length; i++) {
      const node = items[i];
      if (node.uid === uid) return { node, parent, siblings: items, index: i, level };
      if (node.children && node.children.length > 0) {
        const found = walk(node.children, node, level + 1);
        if (found) return found;
      }
    }
    return null;
  };
  return walk(outline, null, 1);
}

/** 新建一个还没保存的节点 */
export function newNode(title: string, description: string): DraftNode {
  return { id: '', title, description };
}

function withChildren(node: DraftNode, children: DraftNode[]): DraftNode {
  const next: DraftNode = { ...node };
  if (children.length > 0) next.children = children;
  else delete next.children;
  return next;
}

/**
 * 找到 uid 所在的同级列表，用 transform 的结果替换它；沿途的祖先各复制一份，其余部分原样共用。
 * transform 返回 null 表示这次操作做不了。
 */
function rewriteSiblings(
  items: OutlineNode[],
  uid: string,
  transform: (siblings: OutlineNode[], index: number) => DraftNode[] | null
): DraftNode[] | null {
  for (let i = 0; i < items.length; i++) {
    if (items[i].uid === uid) return transform(items, i);
  }
  for (let i = 0; i < items.length; i++) {
    const children = items[i].children;
    if (!children || children.length === 0) continue;
    const next = rewriteSiblings(children, uid, transform);
    if (next) {
      const copy: DraftNode[] = items.slice();
      copy[i] = withChildren(items[i], next);
      return copy;
    }
  }
  return null;
}

/** 修改标题与说明 */
export function renameNode(outline: OutlineNode[], uid: string, title: string, description: string): DraftNode[] | null {
  return rewriteSiblings(outline, uid, (siblings, index) => {
    const copy: DraftNode[] = siblings.slice();
    copy[index] = { ...siblings[index], title, description };
    return copy;
  });
}

/** 在某个节点下面追加一个子章节（排在已有子章节之后） */
export function addChild(outline: OutlineNode[], parentUid: string, fresh: DraftNode): DraftNode[] | null {
  return rewriteSiblings(outline, parentUid, (siblings, index) => {
    const copy: DraftNode[] = siblings.slice();
    const existing: DraftNode[] = siblings[index].children || [];
    copy[index] = withChildren(siblings[index], existing.concat([fresh]));
    return copy;
  });
}

/** 在某个节点后面插入一个同级章节 */
export function addAfter(outline: OutlineNode[], uid: string, fresh: DraftNode): DraftNode[] | null {
  return rewriteSiblings(outline, uid, (siblings, index) => {
    const copy: DraftNode[] = siblings.slice();
    copy.splice(index + 1, 0, fresh);
    return copy;
  });
}

/** 在目录末尾追加一个一级章节 */
export function addRoot(outline: OutlineNode[], fresh: DraftNode): DraftNode[] {
  const copy: DraftNode[] = outline.slice();
  copy.push(fresh);
  return copy;
}

/** 在同级之间上移（-1）或下移（1）一位 */
export function moveNode(outline: OutlineNode[], uid: string, delta: -1 | 1): DraftNode[] | null {
  return rewriteSiblings(outline, uid, (siblings, index) => {
    const target = index + delta;
    if (target < 0 || target >= siblings.length) return null;
    const copy: DraftNode[] = siblings.slice();
    copy[index] = siblings[target];
    copy[target] = siblings[index];
    return copy;
  });
}

/** 删除节点（连同它下面的全部章节） */
export function removeNode(outline: OutlineNode[], uid: string): DraftNode[] | null {
  return rewriteSiblings(outline, uid, (siblings, index) => siblings.filter((_, i) => i !== index));
}

/** 某个节点下面需要撰写的章节（它自己就是最末一级时，只有它自己） */
export function leafUidsOf(node: OutlineNode): string[] {
  const result: string[] = [];
  const walk = (item: OutlineNode) => {
    if (isLeaf(item)) {
      result.push(item.uid);
      return;
    }
    (item.children || []).forEach(walk);
  };
  walk(node);
  return result;
}

/** 某个节点下面一共有多少个章节（各级都算，不含它自己） */
export function countDescendants(node: OutlineNode): number {
  let total = 0;
  (node.children || []).forEach((child) => {
    total += 1 + countDescendants(child);
  });
  return total;
}

/** 目录最深有几层（空目录为 0） */
export function treeDepth(outline: OutlineNode[]): number {
  let deepest = 0;
  const walk = (items: OutlineNode[], level: number) => {
    items.forEach((item) => {
      if (level > deepest) deepest = level;
      if (item.children && item.children.length > 0) walk(item.children, level + 1);
    });
  };
  walk(outline, 1);
  return deepest;
}

/** 全部节点的稳定标识（文档顺序） */
export function allUids(outline: OutlineNode[]): string[] {
  const result: string[] = [];
  const walk = (items: OutlineNode[]) => {
    items.forEach((item) => {
      result.push(item.uid);
      if (item.children && item.children.length > 0) walk(item.children);
    });
  };
  walk(outline);
  return result;
}

/** 下面还有子章节的节点（可以展开、收起的那些） */
export function groupUids(outline: OutlineNode[]): string[] {
  const result: string[] = [];
  const walk = (items: OutlineNode[]) => {
    items.forEach((item) => {
      if (item.children && item.children.length > 0) {
        result.push(item.uid);
        walk(item.children);
      }
    });
  };
  walk(outline);
  return result;
}

/** 目录里是否已经有响应表型章节 */
export function hasResponseChapters(outline: OutlineNode[]): boolean {
  const walk = (items: OutlineNode[]): boolean =>
    items.some((item) => Boolean(item.is_response_chapter) || (item.children ? walk(item.children) : false));
  return walk(outline);
}

/** 新节点保存之后会得到的编号（只用于表单里的预览） */
export function nextChildNumber(parent: OutlineNode): string {
  return `${parent.id}.${(parent.children ? parent.children.length : 0) + 1}`;
}

/** 在某个节点后面插入同级章节时，新章节会得到的编号 */
export function nextSiblingNumber(node: OutlineNode): string {
  const parts = node.id.split('.');
  const last = Number(parts[parts.length - 1]);
  if (!Number.isFinite(last)) return '';
  parts[parts.length - 1] = String(last + 1);
  return parts.join('.');
}
