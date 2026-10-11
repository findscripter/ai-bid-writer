/**
 * className 工具
 *
 * cx(...parts)：拼接 className，忽略 false / null / undefined / 空串。
 *   cx('px-2', active && 'bg-primary-50', className)
 *   只做拼接，不处理 Tailwind 类之间的冲突——互斥的类要在调用处二选一。
 *
 * mergeClass(base, override)：把调用方传入的 className 叠加到组件内部的类上，
 *   并让 override 里的「宽 / 高 / 内边距 / 间距」类替换掉 base 里的同类设置。
 *   mergeClass('h-8 w-full px-2.5', 'w-40')  →  'h-8 px-2.5 w-40'
 *   Tailwind 同一属性的两个类谁生效取决于生成顺序而不是书写顺序，所以这几类最常被外部
 *   调整的属性必须显式去掉旧值。其余属性（颜色、圆角、字号等）不做处理，原样追加。
 *   本目录的组件都用它合并外层 className。
 */
export function cx(...parts: Array<string | false | null | undefined>): string {
  let out = '';
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part) {
      out = out ? out + ' ' + part : part;
    }
  }
  return out;
}

// 只识别不带变体前缀的类（sm:w-40、hover:… 不参与替换，它们本来就排在后面生效）
const GROUP = /^(size|w|h|min-w|min-h|max-w|max-h|p|px|py|pt|pr|pb|pl|gap-x|gap-y|gap)-/;

// override 里出现某一组时，base 里要一并去掉的组
const SHADOWS: Record<string, string[]> = {
  size: ['size', 'w', 'h'],
  p: ['p', 'px', 'py', 'pt', 'pr', 'pb', 'pl'],
  px: ['px', 'pl', 'pr'],
  py: ['py', 'pt', 'pb'],
  gap: ['gap', 'gap-x', 'gap-y'],
};

function groupOf(token: string): string | null {
  const m = GROUP.exec(token);
  return m ? m[1] : null;
}

export function mergeClass(base: string, override?: string | false | null): string {
  if (!override) return base;
  const dropped: Record<string, true> = {};
  let any = false;
  const tokens = override.split(/\s+/);
  for (let i = 0; i < tokens.length; i++) {
    const group = groupOf(tokens[i]);
    if (!group) continue;
    const shadowed = SHADOWS[group] || [group];
    for (let j = 0; j < shadowed.length; j++) dropped[shadowed[j]] = true;
    any = true;
  }
  if (!any) return cx(base, override);
  const kept = base.split(/\s+/).filter((token) => {
    const group = groupOf(token);
    return !(group && dropped[group]);
  });
  return cx(kept.join(' '), override);
}
