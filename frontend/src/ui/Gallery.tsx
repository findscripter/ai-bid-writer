/**
 * 组件陈列页：把基础组件和 MarkdownView 的各种状态摆在一页上，给人做视觉验收用。
 *
 * 没有接入路由。要看的话在入口临时渲染它即可，例如：
 *   import Gallery from './ui/Gallery';
 *   root.render(<Gallery />);
 * 自带 ToastProvider / ConfirmProvider，可以独立挂载。
 */
import {
  ArrowDownTrayIcon,
  ArrowPathIcon,
  ChevronRightIcon,
  Cog6ToothIcon,
  DocumentTextIcon,
  InboxIcon,
  PencilSquareIcon,
  PlayIcon,
  PlusIcon,
  StopIcon,
  TrashIcon,
} from '@heroicons/react/24/outline';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { MarkdownView } from '../lib/MarkdownView';
import { estimatePages, formatChars, formatDuration, formatRelativeTime } from '../lib/format';
import { Link, matchPath, useHashRoute } from '../lib/router';
import { Badge } from './Badge';
import { Button } from './Button';
import { Card } from './Card';
import { Checkbox } from './Checkbox';
import { ConfirmProvider, useConfirm } from './ConfirmDialog';
import { Drawer } from './Drawer';
import { EmptyState } from './EmptyState';
import { Field } from './Field';
import { IconButton } from './IconButton';
import { Input } from './Input';
import { Modal } from './Modal';
import { NumberInput } from './NumberInput';
import { ProgressBar } from './ProgressBar';
import { Select } from './Select';
import { Skeleton } from './Skeleton';
import { Spinner } from './Spinner';
import { STATUS_LABEL, StatusDot } from './StatusDot';
import type { DotStatus } from './StatusDot';
import { Switch } from './Switch';
import { Tabs } from './Tabs';
import { Textarea } from './Textarea';
import { ToastProvider, useToast } from './Toast';
import { Tooltip } from './Tooltip';

const SAMPLE_DOC = `# 第三章 技术方案

## 3.1 总体设计

**设计目标：**本方案以**统一平台**为核心，兼顾 \`可扩展性\` 与安全性，*分阶段*交付。整体遵循以下原则：
- 分层解耦：接入层、服务层、数据层各司其职
- 平滑演进：支持按模块灰度上线
  - 灰度范围可配置
  - 回滚时间不超过 5 分钟

实施步骤如下：
1. **需求确认：**与用户逐项核对
2. 环境准备

   续段落：环境包含测试与生产两套。

3. 上线割接

### 3.1.1 人员配置

| 序号 | 角色 | 人数 | 说明 |
|:---:|:---|---:|---|
| 1 | 项目经理 | 1 | **全程**驻场 |
| 2 | 开发工程师 | 6 | 含 \`前端\`、后端<br>与测试 |
| 3 | 实施顾问 | 2 | 负责培训，~~不含差旅~~ |

> 重要提示：割接窗口需提前 **3 个工作日** 报备。

部署命令示例：

\`\`\`bash
kubectl apply -f deploy.yaml
kubectl get pods
\`\`\`

---

本节给出了总体设计，详见[附录](https://example.com/appendix)。`;

const SAMPLE_COMPACT = `**本章要点**

1. 响应招标文件第 5.2 条对系统架构的要求
2. 突出 **国产化适配** 与等保三级

| 评分项 | 分值 |
|---|---:|
| 架构合理性 | 8 |
| 安全设计 | 6 |

> 待确认：是否需要给出部署拓扑图`;

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-[15px] font-semibold text-ink-900">{title}</h2>
        {hint ? <p className="mt-0.5 text-xs text-ink-500">{hint}</p> : null}
      </div>
      {children}
    </section>
  );
}

function Row({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      {label ? <span className="w-20 shrink-0 text-xs text-ink-500">{label}</span> : null}
      {children}
    </div>
  );
}

function Swatch({ className, name }: { className: string; name: string }) {
  return (
    <div className="w-[72px]">
      <div className={`h-9 rounded-md border border-line ${className}`} />
      <div className="mt-1 truncate text-2xs text-ink-500">{name}</div>
    </div>
  );
}

function Tokens() {
  return (
    <Section title="设计令牌" hint="浅冷灰画布上放白色的面，层次靠细边框；钴蓝只用于主操作和当前状态。">
      <Card>
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <Swatch className="bg-primary-50" name="primary-50" />
            <Swatch className="bg-primary-100" name="primary-100" />
            <Swatch className="bg-primary-200" name="primary-200" />
            <Swatch className="bg-primary-300" name="primary-300" />
            <Swatch className="bg-primary-400" name="primary-400" />
            <Swatch className="bg-primary-500" name="primary-500" />
            <Swatch className="bg-primary-600" name="primary-600" />
            <Swatch className="bg-primary-700" name="primary-700" />
            <Swatch className="bg-primary-800" name="primary-800" />
            <Swatch className="bg-primary-900" name="primary-900" />
          </div>
          <div className="flex flex-wrap gap-2">
            <Swatch className="bg-ink-900" name="ink-900" />
            <Swatch className="bg-ink-700" name="ink-700" />
            <Swatch className="bg-ink-600" name="ink-600" />
            <Swatch className="bg-ink-500" name="ink-500" />
            <Swatch className="bg-ink-400" name="ink-400" />
            <Swatch className="bg-ink-300" name="ink-300" />
            <Swatch className="bg-line-strong" name="line-strong" />
            <Swatch className="bg-line" name="line" />
            <Swatch className="bg-canvas" name="canvas" />
            <Swatch className="bg-subtle" name="subtle" />
          </div>
          <div className="flex flex-wrap gap-2">
            <Swatch className="bg-emerald-500" name="emerald 成功" />
            <Swatch className="bg-amber-500" name="amber 提醒" />
            <Swatch className="bg-rose-500" name="rose 失败" />
            <div className="ml-4 flex items-end gap-4">
              <div className="rounded-lg border border-line bg-white px-4 py-3 text-xs text-ink-600 shadow-card">shadow-card</div>
              <div className="rounded-lg border border-line bg-white px-4 py-3 text-xs text-ink-600 shadow-pop">shadow-pop</div>
            </div>
          </div>
          <div className="grid gap-1 text-ink-900">
            <div className="text-xs text-ink-500">text-xs 12px · 辅助说明</div>
            <div className="text-sm">text-sm 14px · 界面基准字号：项目列表、表单、按钮</div>
            <div className="text-doc">text-doc 15px / 1.9 · 文稿正文：本项目建设内容包括平台搭建、数据治理与运维保障。</div>
            <div className="font-mono text-xs text-ink-600">font-mono · chapter_03.md · 12,480</div>
          </div>
        </div>
      </Card>
    </Section>
  );
}

function Buttons() {
  const [loading, setLoading] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const run = () => {
    setLoading(true);
    timer.current = window.setTimeout(() => setLoading(false), 1800);
  };
  return (
    <Section title="Button / IconButton">
      <Card>
        <div className="space-y-3">
          <Row label="variant">
            <Button variant="primary" icon={<PlusIcon />}>
              新建项目
            </Button>
            <Button>次要操作</Button>
            <Button variant="subtle" icon={<PlayIcon />}>
              生成本章
            </Button>
            <Button variant="ghost">取消</Button>
            <Button variant="danger" icon={<TrashIcon />}>
              删除
            </Button>
          </Row>
          <Row label="size">
            <Button size="sm">小 sm</Button>
            <Button size="md">中 md</Button>
            <Button size="lg">大 lg</Button>
            <Button size="sm" variant="primary" iconRight={<ChevronRightIcon />}>
              下一步
            </Button>
            <Button size="lg" variant="primary" icon={<ArrowDownTrayIcon />}>
              导出 Word
            </Button>
          </Row>
          <Row label="状态">
            <Button variant="primary" loading={loading} onClick={run}>
              {loading ? '保存中' : '点我看 loading'}
            </Button>
            <Button loading>加载中</Button>
            <Button variant="primary" disabled>
              禁用
            </Button>
            <Button disabled>禁用</Button>
            <Button variant="ghost" disabled>
              禁用
            </Button>
          </Row>
          <Row label="block">
            <div className="w-64">
              <Button variant="primary" block>
                撑满容器
              </Button>
            </div>
          </Row>
          <Row label="IconButton">
            <IconButton label="重新生成" icon={<ArrowPathIcon />} />
            <IconButton label="编辑" icon={<PencilSquareIcon />} variant="secondary" />
            <IconButton label="删除" icon={<TrashIcon />} variant="danger" />
            <IconButton label="设置" icon={<Cog6ToothIcon />} size="sm" />
            <IconButton label="编辑" icon={<PencilSquareIcon />} size="sm" variant="secondary" />
            <IconButton label="禁用" icon={<TrashIcon />} disabled />
            <IconButton label="加载中" icon={<ArrowPathIcon />} loading />
          </Row>
        </div>
      </Card>
    </Section>
  );
}

const DOT_STATUSES: DotStatus[] = ['empty', 'queued', 'writing', 'done', 'failed', 'cancelled', 'review'];

function Indicators() {
  const [progress, setProgress] = useState(36);
  return (
    <Section title="Badge / StatusDot / Spinner / ProgressBar / Skeleton / Tooltip">
      <Card>
        <div className="space-y-4">
          <Row label="Badge md">
            <Badge>草稿</Badge>
            <Badge tone="primary">进行中</Badge>
            <Badge tone="success" dot>
              已完成
            </Badge>
            <Badge tone="warning" dot>
              待审校
            </Badge>
            <Badge tone="danger" dot>
              失败
            </Badge>
          </Row>
          <Row label="Badge sm">
            <Badge size="sm">12</Badge>
            <Badge size="sm" tone="primary">
              新
            </Badge>
            <Badge size="sm" tone="success">
              通过
            </Badge>
            <Badge size="sm" tone="warning">
              3 个问题
            </Badge>
            <Badge size="sm" tone="danger" dot>
              超时
            </Badge>
          </Row>
          <Row label="StatusDot">
            {DOT_STATUSES.map((s) => (
              <span key={s} className="inline-flex items-center gap-1.5 text-xs text-ink-600">
                <StatusDot status={s} />
                {STATUS_LABEL[s]}
              </span>
            ))}
            <span className="inline-flex items-center gap-1.5 text-xs text-ink-600">
              <StatusDot status="queued" pulse />
              queued + pulse
            </span>
          </Row>
          <Row label="章节树示意">
            <div className="w-64 rounded-md border border-line bg-white py-1 text-[13px]">
              {(
                [
                  ['done', '1 项目理解', '2,140'],
                  ['writing', '2 总体方案', '860'],
                  ['review', '3 实施计划', '3,020'],
                  ['failed', '4 质量保障', '0'],
                  ['empty', '5 售后服务', '0'],
                ] as Array<[DotStatus, string, string]>
              ).map(([status, name, chars]) => (
                <div key={name} className="flex items-center gap-2 px-3 py-1.5 hover:bg-subtle">
                  <StatusDot status={status} />
                  <span className="min-w-0 flex-1 truncate text-ink-900">{name}</span>
                  <span className="tabular-nums text-xs text-ink-400">{chars}</span>
                </div>
              ))}
            </div>
          </Row>
          <Row label="Spinner">
            <Spinner size="sm" />
            <Spinner />
            <Spinner size="lg" />
            <Spinner tone="muted" />
            <span className="inline-flex items-center gap-1.5 text-xs text-ink-600">
              <Spinner size="sm" tone="current" /> 跟随文字色
            </span>
          </Row>
          <div className="grid max-w-xl gap-3">
            <ProgressBar value={progress} label="正文生成（点下面按钮改进度）" />
            <ProgressBar value={null} label="解析招标文件（不确定进度）" />
            <ProgressBar value={100} tone="success" size="sm" />
            <ProgressBar value={72} tone="warning" size="sm" />
            <ProgressBar value={18} tone="danger" size="sm" />
            <div className="flex gap-2">
              <Button size="sm" onClick={() => setProgress((p) => Math.max(0, p - 12))}>
                −12
              </Button>
              <Button size="sm" onClick={() => setProgress((p) => Math.min(100, p + 12))}>
                +12
              </Button>
            </div>
          </div>
          <Row label="Skeleton">
            <div className="w-72 space-y-2">
              <Skeleton className="w-40" />
              <Skeleton />
              <Skeleton className="w-5/6" />
              <Skeleton className="h-16 rounded-lg" />
            </div>
          </Row>
          <Row label="Tooltip">
            <Tooltip content="重新生成本章">
              <IconButton label="重新生成" icon={<ArrowPathIcon />} variant="secondary" />
            </Tooltip>
            <Tooltip content="下方提示" side="bottom">
              <Button size="sm">bottom</Button>
            </Tooltip>
            <Tooltip content="左侧" side="left">
              <Button size="sm">left</Button>
            </Tooltip>
            <Tooltip content="目标 3,000 字，已写 1,860 字" side="right">
              <span className="cursor-default text-xs text-ink-600 underline decoration-dotted underline-offset-4">62%（悬停）</span>
            </Tooltip>
          </Row>
        </div>
      </Card>
    </Section>
  );
}

function Surfaces() {
  const [tab, setTab] = useState('plan');
  const [view, setView] = useState('doc');
  return (
    <Section title="Card / EmptyState / Tabs">
      <div className="grid gap-4 lg:grid-cols-2">
        <Card
          title="评分标准"
          description="来自招标文件第三章"
          actions={
            <>
              <Badge tone="primary">12 项</Badge>
              <Button size="sm" icon={<ArrowPathIcon />}>
                重新解析
              </Button>
            </>
          }
        >
          <p className="text-[13px] leading-6 text-ink-600">卡片正文区域。层次靠细边框和极轻的阴影，不堆叠大面积投影。</p>
        </Card>
        <Card title="不留内边距的卡片" padded={false}>
          <div className="divide-y divide-line text-[13px]">
            <div className="flex items-center justify-between px-4 py-2.5">
              <span>技术方案完整性</span>
              <span className="tabular-nums text-ink-500">15 分</span>
            </div>
            <div className="flex items-center justify-between px-4 py-2.5">
              <span>项目团队配置</span>
              <span className="tabular-nums text-ink-500">10 分</span>
            </div>
          </div>
        </Card>
        <Card>
          <EmptyState
            icon={<InboxIcon />}
            title="还没有项目"
            description="上传一份招标文件，开始第一份标书。"
            action={
              <Button variant="primary" icon={<PlusIcon />}>
                新建项目
              </Button>
            }
          />
        </Card>
        <Card padded={false}>
          <div className="px-4 pt-1">
            <Tabs
              value={tab}
              onChange={setTab}
              aria-label="本章信息"
              tabs={[
                { key: 'plan', label: '写作计划' },
                { key: 'issues', label: '问题', badge: 3 },
                { key: 'refs', label: '引用', disabled: true },
              ]}
            />
          </div>
          <div className="space-y-3 p-4">
            <p className="text-[13px] text-ink-600">当前：{tab}（方向键、Home、End 可切换）</p>
            <Row label="pill">
              <Tabs
                variant="pill"
                value={view}
                onChange={setView}
                tabs={[
                  { key: 'doc', label: '文稿' },
                  { key: 'outline', label: '大纲' },
                  { key: 'diff', label: '修订', badge: 2 },
                ]}
              />
            </Row>
            <Row label="pill sm">
              <Tabs
                variant="pill"
                size="sm"
                value={view}
                onChange={setView}
                tabs={[
                  { key: 'doc', label: '文稿' },
                  { key: 'outline', label: '大纲' },
                  { key: 'diff', label: '修订' },
                ]}
              />
            </Row>
            <Row label="line sm fill">
              <div className="w-64">
                <Tabs
                  size="sm"
                  fill
                  value={tab}
                  onChange={setTab}
                  tabs={[
                    { key: 'plan', label: '计划' },
                    { key: 'issues', label: '问题', badge: 3 },
                  ]}
                />
              </div>
            </Row>
          </div>
        </Card>
      </div>
    </Section>
  );
}

function Forms() {
  const [name, setName] = useState('');
  const [model, setModel] = useState('');
  const [words, setWords] = useState(3000);
  const [temperature, setTemperature] = useState(0.7);
  const [notes, setNotes] = useState('突出本单位在同类项目中的实施经验。\n避免空泛的口号式表述。');
  const [auto, setAuto] = useState(true);
  const [web, setWeb] = useState(false);
  const [picked, setPicked] = useState<string[]>(['1']);
  const chapters = ['1', '2', '3'];
  const all = picked.length === chapters.length;
  return (
    <Section title="Field / Input / Textarea / Select / Checkbox / Switch / NumberInput">
      <Card>
        <div className="grid gap-x-6 gap-y-4 md:grid-cols-2">
          <Field label="项目名称" required error={name.trim() === '' ? '项目名称不能为空' : undefined}>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：智慧园区综合管理平台" />
          </Field>
          <Field label="写作模型" hint="不同模型的速度和文风有差异">
            <Select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="请选择模型"
              options={[
                { value: 'a', label: '模型 A（均衡）' },
                { value: 'b', label: '模型 B（长文更稳）' },
                { value: 'c', label: '模型 C（暂不可用）', disabled: true },
              ]}
            />
          </Field>
          <Field label="每章目标字数" hint={`约 ${estimatePages(words)} 页 · 失焦后钳制到 500 – 20,000`}>
            <NumberInput value={words} onChange={setWords} min={500} max={20000} step={500} suffix="字" />
          </Field>
          <Field label="温度" hint="上下方向键按 0.1 调整">
            <NumberInput value={temperature} onChange={setTemperature} min={0} max={2} step={0.1} className="w-28" />
          </Field>
          <Field label="写作要求（autoResize）" className="md:col-span-2">
            <Textarea autoResize className="max-h-48" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
          <Field label="禁用 / 只读">
            <div className="space-y-2">
              <Input disabled value="禁用的输入框" readOnly />
              <Select disabled defaultValue="x">
                <option value="x">禁用的下拉</option>
              </Select>
              <NumberInput value={12} onChange={() => {}} disabled suffix="页" />
            </div>
          </Field>
          <Field label="错误态（手传 invalid）">
            <div className="space-y-2">
              <Input invalid defaultValue="格式不对的内容" />
              <Textarea invalid rows={2} defaultValue="多行错误态" />
            </div>
          </Field>
          <div className="space-y-2">
            <Checkbox
              label="全选章节"
              checked={all}
              indeterminate={picked.length > 0 && !all}
              onChange={(e) => setPicked(e.target.checked ? chapters : [])}
            />
            <div className="ml-6 space-y-1.5">
              {chapters.map((c) => (
                <div key={c}>
                  <Checkbox
                    label={`第 ${c} 章`}
                    checked={picked.indexOf(c) >= 0}
                    onChange={(e) => setPicked(e.target.checked ? picked.concat(c) : picked.filter((x) => x !== c))}
                  />
                </div>
              ))}
            </div>
            <Checkbox label="禁用的选项" disabled />
          </div>
          <div className="space-y-2.5">
            <div>
              <Switch checked={auto} onChange={setAuto} label="生成后自动审校" />
            </div>
            <div>
              <Switch checked={web} onChange={setWeb} label="联网检索（小号）" size="sm" />
            </div>
            <div>
              <Switch checked onChange={() => {}} label="禁用" disabled />
            </div>
          </div>
        </div>
      </Card>
    </Section>
  );
}

function Overlays() {
  const toast = useToast();
  const confirm = useConfirm();
  const [modal, setModal] = useState<null | 'md' | 'xl' | 'locked'>(null);
  const [drawer, setDrawer] = useState<null | 'right' | 'left'>(null);
  const [answer, setAnswer] = useState('（还没问过）');

  const askDelete = async () => {
    const ok = await confirm({
      title: '删除这一章？',
      description: '已生成的正文会一并删除，无法恢复。',
      confirmText: '删除',
      tone: 'danger',
    });
    setAnswer(ok ? '确认删除' : '取消了');
    if (ok) toast.success('已删除第 3 章');
  };
  const askPlain = async () => {
    const ok = await confirm({ title: '用新目录覆盖当前目录？', description: '已写好的章节会按标题自动对应。' });
    setAnswer(ok ? '确认覆盖' : '取消了');
  };

  return (
    <Section title="Modal / Drawer / Toast / ConfirmDialog">
      <Card>
        <div className="space-y-3">
          <Row label="Modal">
            <Button onClick={() => setModal('md')}>普通对话框</Button>
            <Button onClick={() => setModal('xl')}>超大 + 长内容</Button>
            <Button onClick={() => setModal('locked')}>不可关闭（dismissible=false）</Button>
          </Row>
          <Row label="Drawer">
            <Button onClick={() => setDrawer('right')}>右侧抽屉</Button>
            <Button onClick={() => setDrawer('left')}>左侧抽屉</Button>
          </Row>
          <Row label="Toast">
            <Button onClick={() => toast.success('已保存')}>成功</Button>
            <Button onClick={() => toast.info('已加入生成队列，前面还有 2 章', { title: '第 4 章' })}>信息 + 标题</Button>
            <Button onClick={() => toast.error('生成失败：模型响应超时，请稍后重试。错误提示默认停留 8 秒。')}>错误</Button>
            <Button onClick={() => toast.info('这条不会自动消失', { duration: 0 })}>不自动消失</Button>
            <Button variant="ghost" onClick={() => toast.dismiss()}>
              全部关闭
            </Button>
          </Row>
          <Row label="Confirm">
            <Button onClick={askPlain}>普通确认</Button>
            <Button variant="danger" onClick={askDelete}>
              危险确认
            </Button>
            <span className="text-xs text-ink-500">结果：{answer}</span>
          </Row>
        </div>
      </Card>

      <Modal
        open={modal === 'md'}
        onClose={() => setModal(null)}
        title="新建项目"
        description="上传招标文件后开始解析"
        footer={
          <>
            <Button onClick={() => setModal(null)}>取消</Button>
            <Button variant="primary" onClick={() => setModal(null)}>
              创建
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="项目名称" required>
            <Input autoFocus placeholder="打开时这里自动获得焦点" />
          </Field>
          <Field label="备注">
            <Textarea rows={2} />
          </Field>
          <Button size="sm" onClick={askPlain}>
            在对话框上再弹一个确认
          </Button>
        </div>
      </Modal>

      <Modal
        open={modal === 'xl'}
        onClose={() => setModal(null)}
        size="xl"
        title="章节预览"
        footer={<Button onClick={() => setModal(null)}>关闭</Button>}
      >
        <MarkdownView content={SAMPLE_DOC + '\n\n' + SAMPLE_DOC.replace('# 第三章 技术方案', '# 第四章 实施方案')} />
      </Modal>

      <Modal
        open={modal === 'locked'}
        onClose={() => setModal(null)}
        dismissible={false}
        size="sm"
        title="正在导出"
        footer={
          <Button variant="primary" onClick={() => setModal(null)}>
            我知道了
          </Button>
        }
      >
        <div className="space-y-3">
          <p className="text-[13px] text-ink-600">点遮罩、按 Esc 都不会关闭，只能点下面的按钮。</p>
          <ProgressBar value={null} />
        </div>
      </Modal>

      <Drawer
        open={drawer != null}
        side={drawer === 'left' ? 'left' : 'right'}
        onClose={() => setDrawer(null)}
        title="本章写作计划"
        description="生成正文前可以先调整"
        width={drawer === 'left' ? 360 : 480}
        footer={
          <>
            <Button onClick={() => setDrawer(null)}>取消</Button>
            <Button variant="primary" onClick={() => setDrawer(null)}>
              保存
            </Button>
          </>
        }
      >
        <MarkdownView variant="compact" content={SAMPLE_COMPACT} />
      </Drawer>
    </Section>
  );
}

function StreamingDemo() {
  const [text, setText] = useState('');
  const [running, setRunning] = useState(false);
  const pos = useRef(0);

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => {
      // 模拟 token 流：每 40ms 追加 1–6 个字符
      pos.current = Math.min(SAMPLE_DOC.length, pos.current + 1 + Math.floor(Math.random() * 6));
      setText(SAMPLE_DOC.slice(0, pos.current));
      if (pos.current >= SAMPLE_DOC.length) setRunning(false);
    }, 40);
    return () => window.clearInterval(timer);
  }, [running]);

  const start = () => {
    pos.current = 0;
    setText('');
    setRunning(true);
  };

  return (
    <Card
      title="流式输出"
      description="表格、代码围栏、加粗在没写完时不应闪出原始符号；光标跟在最后一个字后面"
      actions={
        running ? (
          <Button size="sm" icon={<StopIcon />} onClick={() => setRunning(false)}>
            停止
          </Button>
        ) : (
          <Button size="sm" variant="primary" icon={<PlayIcon />} onClick={start}>
            开始
          </Button>
        )
      }
    >
      <div className="min-h-[160px]">
        {text === '' && !running ? (
          <EmptyState icon={<DocumentTextIcon />} title="点「开始」模拟一次流式生成" className="py-6" />
        ) : (
          <MarkdownView content={text} streaming={running} />
        )}
      </div>
      <div className="mt-3 border-t border-line pt-2 text-xs text-ink-500">
        {formatChars(text.length)} · 约 {estimatePages(text.length)} 页
      </div>
    </Card>
  );
}

function Markdown() {
  return (
    <Section title="MarkdownView" hint="variant=doc 用于文稿（15px / 1.9），compact 用于侧栏（13px）。">
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <Card title="doc">
          <MarkdownView content={SAMPLE_DOC} />
        </Card>
        <div className="space-y-4">
          <Card title="compact">
            <MarkdownView variant="compact" content={SAMPLE_COMPACT} />
          </Card>
          <Card title="不渲染 HTML">
            <MarkdownView
              variant="compact"
              content={'<script>alert(1)</script>\n\n行内 <b>标签</b> 原样显示，<br> 当作换行。\n\n![架构图](a.png) [危险链接](javascript:alert(1))'}
            />
          </Card>
        </div>
      </div>
      <StreamingDemo />
    </Section>
  );
}

function RouterAndFormat() {
  const route = useHashRoute();
  const match = matchPath('/projects/:id/:stage?', route.path);
  const now = Date.now();
  return (
    <Section title="lib/router · lib/format">
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="hash 路由">
          <div className="space-y-2 text-[13px]">
            <div className="flex flex-wrap gap-3">
              <Link className="text-primary-600 hover:underline" to="/">
                /
              </Link>
              <Link className="text-primary-600 hover:underline" to="/projects/demo">
                /projects/demo
              </Link>
              <Link className="text-primary-600 hover:underline" to="/projects/demo/write?tab=plan">
                /projects/demo/write?tab=plan
              </Link>
              <Button size="sm" onClick={() => route.navigate('/projects/demo/export', { replace: true })}>
                navigate(replace)
              </Button>
            </div>
            <div className="rounded-md bg-subtle p-3 font-mono text-xs leading-6 text-ink-700">
              <div>path: {route.path}</div>
              <div>segments: {JSON.stringify(route.segments)}</div>
              <div>query.tab: {String(route.query.get('tab'))}</div>
              <div>matchPath('/projects/:id/:stage?'): {JSON.stringify(match)}</div>
            </div>
          </div>
        </Card>
        <Card title="格式化">
          <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[13px]">
            <span className="text-ink-500">formatChars(12480)</span>
            <span>{formatChars(12480)}</span>
            <span className="text-ink-500">estimatePages(12480)</span>
            <span>{estimatePages(12480)}</span>
            <span className="text-ink-500">30 秒前</span>
            <span>{formatRelativeTime(new Date(now - 30 * 1000).toISOString())}</span>
            <span className="text-ink-500">5 分钟前</span>
            <span>{formatRelativeTime(new Date(now - 5 * 60 * 1000).toISOString())}</span>
            <span className="text-ink-500">26 小时前</span>
            <span>{formatRelativeTime(new Date(now - 26 * 3600 * 1000).toISOString())}</span>
            <span className="text-ink-500">10 天前</span>
            <span>{formatRelativeTime(new Date(now - 10 * 86400 * 1000).toISOString())}</span>
            <span className="text-ink-500">formatDuration(192000)</span>
            <span>{formatDuration(192000)}</span>
            <span className="text-ink-500">formatDuration(5400000)</span>
            <span>{formatDuration(5400000)}</span>
          </div>
        </Card>
      </div>
    </Section>
  );
}

export default function Gallery() {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <div className="min-h-screen bg-canvas">
          <div className="mx-auto max-w-6xl space-y-8 px-6 py-8">
            <header>
              <h1 className="text-xl font-semibold text-ink-900">组件陈列</h1>
              <p className="mt-1 text-[13px] text-ink-500">
                基础组件与 Markdown 渲染的全部状态。键盘 Tab 走一遍可以检查焦点样式。
              </p>
            </header>
            <Tokens />
            <Buttons />
            <Indicators />
            <Surfaces />
            <Forms />
            <Overlays />
            <Markdown />
            <RouterAndFormat />
          </div>
        </div>
      </ConfirmProvider>
    </ToastProvider>
  );
}
