/**
 * 技术评分要求的识别结果：从解析文本里认出来的评审项和采购人要求。
 * 写作计划按这些条目分工、审校按这些条目核对覆盖，所以要让使用者看清楚认出了哪些。
 */
import React, { memo, useMemo, useState } from 'react';
import { ChevronRightIcon, ExclamationTriangleIcon } from '@heroicons/react/20/solid';
import type { RequirementItem } from '../../api/types';
import { Badge, Button, Spinner, cx } from '../../ui';

interface RequirementListProps {
  items: RequirementItem[];
  /** 技术评分要求有没有文字内容 */
  hasText: boolean;
  /** 正在解析，或刚解析完、条目还没刷新出来 */
  settling: boolean;
  /** 现在不能重新解析的原因；可以时传空串 */
  reanalyzeBlocked: string;
  onReanalyze: () => void;
  onEdit: () => void;
}

const FORMAT_SAMPLE = `【评审项ID】：E1
【评审项名称】：项目理解与总体方案
【分值或权重】：25分
【评审标准】：对项目理解准确、方案完整合理得 20-25 分……

【要求ID】：R1
【要求名称】：系统性能指标
【关键约束/指标】：系统响应时间不超过 3 秒……
【必含关键词】：3 秒、99.9%`;

/** 每条评审项的分值都写成「N 分」时给出合计，否则返回 null（权重、区间等写法不硬算） */
function totalScore(items: RequirementItem[]): number | null {
  if (items.length === 0) return null;
  let total = 0;
  for (let i = 0; i < items.length; i++) {
    const match = /^\s*(\d+(?:\.\d+)?)\s*分/.exec(items[i].score);
    if (!match) return null;
    total += Number(match[1]);
  }
  return Math.round(total * 10) / 10;
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="w-[5.5rem] shrink-0 text-ink-400">{label}</dt>
      <dd className="min-w-0 flex-1 whitespace-pre-line break-words text-ink-700">{children}</dd>
    </div>
  );
}

function Row({ item }: { item: RequirementItem }) {
  const [open, setOpen] = useState(false);
  const scoring = item.kind === 'scoring';
  const hasDetail = Boolean(item.detail || item.keywords.length || item.location || item.suggestion);
  const side = scoring ? item.score : item.keywords.length > 0 ? `${item.keywords.length} 个必含词` : '';

  return (
    <li>
      <button
        type="button"
        aria-expanded={hasDetail ? open : undefined}
        disabled={!hasDetail}
        onClick={() => setOpen((value) => !value)}
        className={cx(
          'flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] leading-5 transition-colors',
          hasDetail ? 'hover:bg-subtle' : 'cursor-default'
        )}
      >
        <ChevronRightIcon
          className={cx('h-4 w-4 shrink-0 text-ink-300 transition-transform', open && 'rotate-90', !hasDetail && 'invisible')}
        />
        <span className="w-9 shrink-0 font-mono text-xs font-medium text-primary-700">{item.id}</span>
        <span className={cx('min-w-0 flex-1 truncate', item.name ? 'text-ink-900' : 'text-ink-400')} title={item.name}>
          {item.name || '没有写名称'}
        </span>
        {side ? (
          <span className="max-w-[9rem] shrink-0 truncate text-xs tabular-nums text-ink-500" title={side}>
            {side}
          </span>
        ) : null}
      </button>
      {open && hasDetail && (
        <dl className="space-y-1 border-t border-line bg-subtle py-2 pl-[3.25rem] pr-3 text-xs leading-5">
          {item.detail && <Detail label={scoring ? '评审标准' : '约束 / 指标'}>{item.detail}</Detail>}
          {item.keywords.length > 0 && (
            <Detail label="必含关键词">
              <span className="flex flex-wrap gap-1">
                {item.keywords.map((word) => (
                  <Badge key={word} size="sm">
                    {word}
                  </Badge>
                ))}
              </span>
            </Detail>
          )}
          {item.location && <Detail label="原文位置">{item.location}</Detail>}
          {item.suggestion && <Detail label="目录建议">{item.suggestion}</Detail>}
        </dl>
      )}
    </li>
  );
}

function Group({ title, extra, items, emptyHint }: { title: string; extra?: string; items: RequirementItem[]; emptyHint: string }) {
  return (
    <div className="min-w-0 overflow-hidden rounded-md border border-line bg-white">
      <div className="flex items-baseline gap-2 border-b border-line bg-subtle px-3 py-1.5">
        <h4 className="text-xs font-semibold text-ink-700">{title}</h4>
        <span className="text-xs tabular-nums text-ink-500">{items.length} 条</span>
        {extra ? <span className="ml-auto text-xs tabular-nums text-ink-500">{extra}</span> : null}
      </div>
      {items.length === 0 ? (
        <p className="px-3 py-3 text-xs leading-5 text-amber-700">{emptyHint}</p>
      ) : (
        <ul className="max-h-72 divide-y divide-line overflow-y-auto">
          {items.map((item) => (
            <Row key={item.id} item={item} />
          ))}
        </ul>
      )}
    </div>
  );
}

function RequirementListImpl({ items, hasText, settling, reanalyzeBlocked, onReanalyze, onEdit }: RequirementListProps) {
  const scoring = useMemo(() => items.filter((item) => item.kind === 'scoring'), [items]);
  const requirement = useMemo(() => items.filter((item) => item.kind !== 'scoring'), [items]);
  const total = useMemo(() => totalScore(scoring), [scoring]);

  if (settling) {
    return (
      <div className="flex items-center gap-2 border-t border-line bg-subtle px-4 py-3 text-xs text-ink-500">
        <Spinner size="sm" tone="muted" label="正在识别条目" />
        解析完成后会在这里列出识别到的评审项和采购人要求。
      </div>
    );
  }
  if (!hasText) return null;

  if (items.length === 0) {
    return (
      <div className="border-t border-amber-200 bg-amber-50 px-4 py-3 text-[13px] leading-6 text-amber-900">
        <div className="flex items-start gap-2">
          <ExclamationTriangleIcon className="mt-1 h-4 w-4 shrink-0 text-amber-500" />
          <div className="min-w-0 flex-1">
            <p className="font-medium">没有识别出标准的条目格式</p>
            <p>
              上面有内容，但找不到带编号的评审项或采购人要求。这样一来，写作计划没法把评分项分配到章节，后面的评分点覆盖核对也将不可用。
              可以重新解析，或者把内容手动整理成下面这样的格式：
            </p>
            <pre className="mt-2 overflow-x-auto rounded-md border border-amber-200 bg-white/70 px-3 py-2 font-mono text-xs leading-5 text-ink-700">
              {FORMAT_SAMPLE}
            </pre>
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              <Button size="sm" disabled={Boolean(reanalyzeBlocked)} title={reanalyzeBlocked || undefined} onClick={onReanalyze}>
                重新解析
              </Button>
              <Button size="sm" onClick={onEdit}>
                手动整理
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="border-t border-line bg-subtle px-4 py-3">
      <p className="text-[13px] leading-6 text-ink-700">
        已识别 <strong className="font-semibold text-ink-900">{scoring.length}</strong> 条评审项、
        <strong className="font-semibold text-ink-900">{requirement.length}</strong> 条采购人要求
        <span className="text-ink-500">
          ——写作计划会把每一条分配到章节，审校时逐条核对有没有响应到。和招标文件对一下，看有没有漏掉的。
        </span>
      </p>
      <div className="mt-2.5 grid gap-3 md:grid-cols-2">
        <Group
          title="评审项"
          extra={total !== null ? `合计 ${total} 分` : undefined}
          items={scoring}
          emptyHint="没有识别出评审项。评分办法一般都有分项，请对照招标文件确认，必要时重新解析或手动补上。"
        />
        <Group
          title="采购人要求"
          items={requirement}
          emptyHint="没有识别出采购人要求。如果招标文件里有技术规格或服务要求，请重新解析或手动补上。"
        />
      </div>
    </div>
  );
}

export const RequirementList = memo(RequirementListImpl);
