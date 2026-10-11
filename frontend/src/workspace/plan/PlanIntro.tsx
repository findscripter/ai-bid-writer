/**
 * 还没有写作计划时的页面：讲清楚它是什么、为什么值得做、点了之后会发生什么。
 */
import React from 'react';
import { ArrowRightIcon, SparklesIcon } from '@heroicons/react/24/outline';
import { Button } from '../../ui';
import { Notice } from './Notice';

interface PlanIntroProps {
  /** 目录里的叶子章节数 */
  leafCount: number;
  /** 招标解读里识别出的评分项与采购人要求条数 */
  requirementCount: number;
  /** 招标解读里是否已经有“技术评分要求”的文本 */
  hasRequirementsText: boolean;
  /** 模型服务确定还没配置好 */
  modelNeedsSetup: boolean;
  /** 有别的后台任务在跑时，它的中文名；没有则为 null */
  busyLabel: string | null;
  starting: boolean;
  onGenerate: () => void;
  onSkip: () => void;
  onOpenSettings: () => void;
  onGoTender: () => void;
}

function Step({ index, title, children }: { index: number; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span
        className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary-50 text-xs font-semibold text-primary-700"
        aria-hidden="true"
      >
        {index}
      </span>
      <div className="min-w-0">
        <p className="text-sm font-medium leading-6 text-ink-900">{title}</p>
        <p className="mt-0.5 text-[13px] leading-6 text-ink-600">{children}</p>
      </div>
    </li>
  );
}

export function PlanIntro({
  leafCount,
  requirementCount,
  hasRequirementsText,
  modelNeedsSetup,
  busyLabel,
  starting,
  onGenerate,
  onSkip,
  onOpenSettings,
  onGoTender,
}: PlanIntroProps) {
  return (
    <section className="mx-auto max-w-3xl rounded-lg border border-line bg-white shadow-card">
      <div className="px-8 pb-6 pt-7">
        <h1 className="text-xl font-semibold leading-8 text-ink-900">先定写作计划，再动笔</h1>
        <div className="mt-3 space-y-3 text-sm leading-7 text-ink-700">
          <p>
            技术标往往有几十上百个章节，是一章一章分头写出来的。如果每一章只知道自己的标题，同一个工期、同一项指标很容易前后写得不一样，相邻章节互相重复，有的评分项还没有哪一章去响应。
          </p>
          <p>
            写作计划把这些提前定下来：全书共用一份“统一口径”，每一章有自己必须写到的要点、负责响应的评分项和篇幅。之后每一章都照着它写，重点章节多写，说明性的章节少写。
          </p>
        </div>
      </div>

      <div className="border-t border-line px-8 py-6">
        <h2 className="text-[13px] font-medium leading-5 text-ink-500">点“生成写作计划”之后</h2>
        <ol className="mt-3 space-y-4">
          <Step index={1} title="归纳统一口径">
            从招标解读的结果里提取工期、地点、数量、指标这些写死的约束，定下本方案的总体设定和统一术语，并列出需要你补充的企业信息（业绩、人员、资质等）。
          </Step>
          <Step index={2} title="分批给各章定要点">
            按一级章节分批，给全部 {leafCount} 个章节定必须写到的要点、负责响应的评分项、不在本章展开的内容和篇幅权重。没有章节负责的评分项会单独列出来，避免漏项。
          </Step>
        </ol>
        <p className="mt-4 text-[13px] leading-6 text-ink-500">生成的结果都可以再改。章节越多用时越长，期间可以去做别的。</p>
      </div>

      <div className="space-y-4 rounded-b-lg border-t border-line bg-subtle px-8 py-5">
        {busyLabel && (
          <Notice tone="info">正在{busyLabel}，结束后才能生成写作计划。想现在就生成，可以先在右上角停止它。</Notice>
        )}
        {modelNeedsSetup && (
          <Notice
            tone="warning"
            title="还没有配置模型服务"
            actions={
              <Button size="sm" onClick={onOpenSettings}>
                去配置
              </Button>
            }
          >
            生成写作计划要调用模型。先填好 API Key、接口地址和模型，再回到这里生成。
          </Notice>
        )}
        {requirementCount === 0 && (
          <Notice
            tone="info"
            title={hasRequirementsText ? '没有识别出评分项' : '还没有解析技术评分要求'}
            actions={
              <Button size="sm" onClick={onGoTender}>
                去招标解读
              </Button>
            }
          >
            {hasRequirementsText
              ? '招标解读里的“技术评分要求”不是标准的条目格式。计划照样能生成，但没法指定每一章负责响应哪些评分项，之后也没法核对有没有漏项。建议先到招标解读里重新解析。'
              : '没有它也能生成计划，但没法指定每一章负责响应哪些评分项，之后也没法核对有没有漏项。建议先到招标解读里完成解析。'}
          </Notice>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="primary"
            size="lg"
            icon={<SparklesIcon />}
            loading={starting}
            disabled={busyLabel !== null}
            onClick={onGenerate}
          >
            生成写作计划
          </Button>
          <Button variant="ghost" size="lg" iconRight={<ArrowRightIcon />} onClick={onSkip}>
            跳过，直接写正文
          </Button>
          {requirementCount > 0 && (
            <span className="text-xs leading-5 text-ink-500">
              将为 {leafCount} 个章节制定计划，对照 {requirementCount} 条评分项与采购人要求
            </span>
          )}
        </div>
        <p className="text-xs leading-5 text-ink-500">
          跳过也能写，但各章不共享统一口径，容易前后不一、内容重复；评分项也没有章节负责响应，审校时没法核对有没有漏项。之后随时可以回来补做。
        </p>
      </div>
    </section>
  );
}
