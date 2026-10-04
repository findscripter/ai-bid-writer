/**
 * 企业资料：撰写正文时唯一可以引用的企业事实来源。
 */
import React, { memo, useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../../api/client';
import { formatChars } from '../../lib/format';
import { Badge, Button, Textarea, useToast } from '../../ui';
import { useWorkspace } from '../WorkspaceContext';

/** 撰写时带入企业资料的字数上限（与后端 writing/prompts.py 的截取长度一致） */
const PROFILE_LIMIT = 4000;

const PLACEHOLDER = `按实际情况填写，写多少用多少。例如：

公司名称、成立时间、注册资本、主营业务
资质证书：证书名称、编号、有效期
同类项目业绩：项目名称、采购人、合同金额、完成时间
拟派项目经理和核心人员：姓名、职称、证书、从业年限
自有产品、专利和软件著作权
服务网点与售后团队`;

interface CompanyProfileCardProps {
  onDirtyChange: (key: string, dirty: boolean) => void;
}

function countChars(text: string): number {
  return text.replace(/\s/g, '').length;
}

function CompanyProfileCardImpl({ onDirtyChange }: CompanyProfileCardProps) {
  const ws = useWorkspace();
  const toast = useToast();
  const saved = ws.data.project.company_profile;
  const [draft, setDraft] = useState(saved);
  const [saving, setSaving] = useState(false);

  // 项目数据刷新时，没有未保存的修改就跟上最新内容
  const savedRef = useRef(saved);
  useEffect(() => {
    const previous = savedRef.current;
    savedRef.current = saved;
    setDraft((current) => (current === previous ? saved : current));
  }, [saved]);

  const dirty = draft !== saved;
  useEffect(() => {
    onDirtyChange('company', dirty);
  }, [dirty, onDirtyChange]);

  const save = async () => {
    setSaving(true);
    try {
      const value = draft.replace(/\s+$/, '');
      ws.apply(await api.patchProject(ws.projectId, { company_profile: value }));
      setDraft(value);
      toast.success(ws.running ? '企业资料已保存，下一次撰写时生效' : '企业资料已保存');
    } catch (error) {
      toast.error(errorMessage(error, '保存失败，请重试'));
    } finally {
      setSaving(false);
    }
  };

  const chars = countChars(draft);
  const tooLong = draft.trim().length > PROFILE_LIMIT;

  return (
    <section className="flex h-full flex-col overflow-hidden rounded-lg border border-line bg-white shadow-card">
      <header className="border-b border-line px-4 py-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold leading-6 text-ink-900">
          企业资料
          {saved.trim() ? (
            <span className="text-xs font-normal tabular-nums text-ink-400">{formatChars(countChars(saved))}</span>
          ) : (
            <Badge tone="warning" size="sm">
              还没有填写
            </Badge>
          )}
        </h3>
      </header>
      <div className="flex flex-1 flex-col px-4 pb-3 pt-3">
        <p className="text-[13px] leading-6 text-ink-600">
          这是撰写正文时<strong className="font-semibold text-ink-900">唯一可以引用的企业事实来源</strong>
          ：公司名称、资质、业绩、人员等。这里没有的企业信息，正文里会写成
          <span className="mx-0.5 whitespace-nowrap rounded bg-amber-50 px-1 py-0.5 text-xs text-amber-800">【待补充：……】</span>
          让你自己填，模型不会替你编。
        </p>
        <Textarea
          rows={11}
          value={draft}
          disabled={saving}
          placeholder={PLACEHOLDER}
          onChange={(event) => setDraft(event.target.value)}
          className="mt-3 min-h-[12rem] flex-1 text-[13px] leading-6"
          aria-label="企业资料"
        />
        {tooLong && (
          <p className="mt-2 rounded-md bg-amber-50 px-3 py-1.5 text-xs leading-5 text-amber-800">
            已经超过 {PROFILE_LIMIT.toLocaleString('en-US')} 字：撰写时只会带上前 {PROFILE_LIMIT.toLocaleString('en-US')}{' '}
            字。这里只留关键事实，完整的企业介绍、旧方案请放到参考资料里。
          </p>
        )}
      </div>
      <div className="flex items-center gap-2 border-t border-line bg-subtle px-4 py-2.5">
        <span className="mr-auto text-xs tabular-nums text-ink-500">
          {formatChars(chars)}
          {dirty ? <span className="ml-2 text-amber-700">有修改还没保存</span> : null}
        </span>
        {dirty && (
          <Button variant="ghost" disabled={saving} onClick={() => setDraft(saved)}>
            撤销修改
          </Button>
        )}
        <Button variant="primary" loading={saving} disabled={!dirty} onClick={() => void save()}>
          保存
        </Button>
      </div>
    </section>
  );
}

export const CompanyProfileCard = memo(CompanyProfileCardImpl);
