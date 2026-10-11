/**
 * 模型服务设置：API Key、接口地址、模型名称。
 *
 * - 每次打开都用已保存的设置重置表单；密钥不回显，留空表示不修改。
 * - “获取模型列表”“测试连接”用的是表单里当前填写的值，不会保存。
 * - 保存成功后把最新设置交给 onSaved，然后关闭。
 */
import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { CheckCircleIcon, ExclamationCircleIcon } from '@heroicons/react/20/solid';
import { EyeIcon, EyeSlashIcon, InformationCircleIcon } from '@heroicons/react/24/outline';
import { api, errorMessage } from '../api/client';
import type { AppSettings } from '../api/types';
import { Button, Drawer, Field, Input, Skeleton, cx, useConfirm, useToast } from '../ui';

export interface SettingsDrawerProps {
  open: boolean;
  onClose: () => void;
  /** 当前设置；加载完成前为 null */
  settings: AppSettings | null;
  /** 保存成功后回调最新的设置 */
  onSaved: (settings: AppSettings) => void;
  /** 外面还没读到设置、抽屉自己读到了：交回给外面，别的页面也就知道模型服务配好了没有 */
  onLoaded?: (settings: AppSettings) => void;
}

/** 常用服务商：点一下只填接口地址，模型名称仍由使用者自己定 */
const PROVIDERS: Array<{ name: string; url: string }> = [
  { name: 'DeepSeek', url: 'https://api.deepseek.com/v1' },
  { name: 'OpenAI', url: 'https://api.openai.com/v1' },
  { name: '通义千问', url: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { name: '智谱', url: 'https://open.bigmodel.cn/api/paas/v4' },
  { name: 'Moonshot', url: 'https://api.moonshot.cn/v1' },
  { name: '硅基流动', url: 'https://api.siliconflow.cn/v1' },
];

/** 后端在从没配置过时给出的缺省模型名 */
const BUILTIN_MODEL = 'gpt-3.5-turbo';

interface FormErrors {
  key?: string;
  url?: string;
  model?: string;
}

interface TestOutcome {
  ok: boolean;
  message: string;
  latencyMs: number;
}

function sameUrl(a: string, b: string): boolean {
  const clean = (text: string) => text.trim().replace(/\/+$/, '').toLowerCase();
  return clean(a) === clean(b);
}

function validUrl(url: string): boolean {
  return /^https?:\/\/\S+$/i.test(url);
}

/** 从没配置过时，后端返回的模型名只是它的缺省值，不当成使用者的选择填进表单 */
function savedModel(source: AppSettings): string {
  const untouched = !source.api_key_set && !source.base_url && source.model_name === BUILTIN_MODEL;
  return untouched ? '' : source.model_name;
}

function formatLatency(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} 毫秒` : `${(ms / 1000).toFixed(1)} 秒`;
}

export default function SettingsDrawer({ open, onClose, settings, onSaved, onLoaded }: SettingsDrawerProps) {
  const toast = useToast();
  const confirm = useConfirm();
  const modelListId = useId();

  // 外面还没读到设置（例如刚打开页面、或本机服务当时没起来）时，抽屉自己读一次
  const [fetched, setFetched] = useState<AppSettings | null>(null);
  const [fetchError, setFetchError] = useState('');
  const [fetchRound, setFetchRound] = useState(0);
  const current = settings || fetched;

  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [baseUrl, setBaseUrl] = useState('');
  const [modelName, setModelName] = useState('');
  /** 表单打开时的值，用来判断有没有改动 */
  const [initial, setInitial] = useState({ baseUrl: '', modelName: '' });
  const [errors, setErrors] = useState<FormErrors>({});

  const [models, setModels] = useState<string[] | null>(null);
  const [modelsError, setModelsError] = useState('');
  const [loadingModels, setLoadingModels] = useState(false);
  const [testing, setTesting] = useState(false);
  const [outcome, setOutcome] = useState<TestOutcome | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  const keyRef = useRef<HTMLInputElement>(null);
  const urlRef = useRef<HTMLInputElement>(null);
  const modelRef = useRef<HTMLInputElement>(null);
  /** “获取模型列表”“测试连接”各自的请求序号：填写的内容一变，还没回来的结果就作废 */
  const probeRef = useRef({ models: 0, test: 0 });
  const askingRef = useRef(false);

  // 每次打开都用已保存的设置重置表单（在渲染阶段同步，抽屉一出现就是对的值）
  const [wasOpen, setWasOpen] = useState(false);
  const [seeded, setSeeded] = useState(false);
  const seed = (source: AppSettings | null) => {
    const url = source ? source.base_url : '';
    const model = source ? savedModel(source) : '';
    setApiKey('');
    setShowKey(false);
    setBaseUrl(url);
    setModelName(model);
    setInitial({ baseUrl: url, modelName: model });
    setErrors({});
    setModels(null);
    setModelsError('');
    setLoadingModels(false);
    setTesting(false);
    setOutcome(null);
    setSaveError('');
    setSeeded(source !== null);
  };
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) seed(current);
  } else if (open && !seeded && current) {
    seed(current);
  }

  useLayoutEffect(() => {
    // 抽屉开关时，上一轮还没回来的请求一律作废
    probeRef.current.models += 1;
    probeRef.current.test += 1;
  }, [open]);

  const onLoadedRef = useRef(onLoaded);
  onLoadedRef.current = onLoaded;
  useEffect(() => {
    if (!open || settings) return undefined;
    let cancelled = false;
    setFetchError('');
    api
      .getSettings()
      .then((value) => {
        if (cancelled) return;
        setFetched(value);
        if (onLoadedRef.current) onLoadedRef.current(value);
      })
      .catch((error) => {
        if (!cancelled) setFetchError(errorMessage(error, '读取不到已保存的设置，请重试'));
      });
    return () => {
      cancelled = true;
    };
  }, [open, settings, fetchRound]);

  const demo = Boolean(current && current.demo);
  const hasSavedKey = Boolean(current && current.api_key_set);
  const keyMissing = !apiKey.trim() && !hasSavedKey;
  const dirty =
    apiKey !== '' || baseUrl.trim() !== initial.baseUrl.trim() || modelName.trim() !== initial.modelName.trim();

  /** 填写的内容变了：之前的测试结果不再算数；密钥或地址变了，模型列表也要重新获取 */
  const invalidate = (connectionChanged: boolean) => {
    probeRef.current.test += 1;
    setTesting(false);
    setOutcome(null);
    setSaveError('');
    if (connectionChanged) {
      probeRef.current.models += 1;
      setLoadingModels(false);
      setModels(null);
      setModelsError('');
    }
  };

  const changeKey = (value: string) => {
    setApiKey(value);
    if (errors.key) setErrors((prev) => ({ ...prev, key: undefined }));
    invalidate(true);
  };

  const changeUrl = (value: string) => {
    setBaseUrl(value);
    if (errors.url) setErrors((prev) => ({ ...prev, url: undefined }));
    invalidate(true);
  };

  const changeModel = (value: string) => {
    setModelName(value);
    if (errors.model) setErrors((prev) => ({ ...prev, model: undefined }));
    invalidate(false);
  };

  /** 检查表单；有问题就标在对应的输入框上并把光标放过去 */
  const check = (need: { key: boolean; model: boolean }): boolean => {
    const next: FormErrors = {};
    const url = baseUrl.trim();
    if (need.key && keyMissing) next.key = '请先填写 API Key';
    if (url && !validUrl(url)) next.url = '接口地址要以 http:// 或 https:// 开头，中间不能有空格';
    if (need.model && !modelName.trim()) next.model = '请先填写模型名称';
    setErrors(next);
    const target = next.key ? keyRef.current : next.url ? urlRef.current : next.model ? modelRef.current : null;
    if (target) target.focus();
    return !next.key && !next.url && !next.model;
  };

  const fetchModels = async () => {
    // 演示模式不连真实服务，没有密钥也能看到演示用的模型
    if (!check({ key: !demo, model: false })) return;
    probeRef.current.models += 1;
    const ticket = probeRef.current.models;
    setLoadingModels(true);
    setModelsError('');
    try {
      const result = await api.listModels({ api_key: apiKey.trim() || null, base_url: baseUrl.trim() });
      if (ticket !== probeRef.current.models) return;
      setModels(Array.isArray(result.models) ? result.models : []);
    } catch (error) {
      if (ticket !== probeRef.current.models) return;
      setModels(null);
      setModelsError(errorMessage(error, '没有拿到模型列表'));
    } finally {
      if (ticket === probeRef.current.models) setLoadingModels(false);
    }
  };

  const test = async () => {
    if (!check({ key: !demo, model: !demo })) return;
    probeRef.current.test += 1;
    const ticket = probeRef.current.test;
    setTesting(true);
    setOutcome(null);
    try {
      const result = await api.testSettings({
        api_key: apiKey.trim() || null,
        base_url: baseUrl.trim(),
        model_name: modelName.trim(),
      });
      if (ticket !== probeRef.current.test) return;
      setOutcome({
        ok: Boolean(result.ok),
        message: result.message || (result.ok ? '连接正常' : '连接失败'),
        latencyMs: Number(result.latency_ms) || 0,
      });
    } catch (error) {
      if (ticket !== probeRef.current.test) return;
      setOutcome({ ok: false, message: errorMessage(error, '测试没有完成，请重试'), latencyMs: 0 });
    } finally {
      if (ticket === probeRef.current.test) setTesting(false);
    }
  };

  const save = async () => {
    if (saving || keyMissing) return;
    if (!check({ key: true, model: true })) return;
    setSaving(true);
    setSaveError('');
    try {
      const next = await api.saveSettings({
        api_key: apiKey.trim() || null,
        base_url: baseUrl.trim(),
        model_name: modelName.trim(),
      });
      onSaved(next);
      toast.success(next.demo ? '设置已保存，退出演示模式后生效' : '模型服务设置已保存');
      onClose();
    } catch (error) {
      setSaveError(errorMessage(error, '设置保存失败，请重试'));
    } finally {
      setSaving(false);
    }
  };

  /** 关闭前：填了还没保存的内容要先问一句 */
  const requestClose = async () => {
    if (saving || askingRef.current) return;
    if (dirty) {
      askingRef.current = true;
      const ok = await confirm({
        title: '放弃还没保存的修改？',
        description: '刚才填写的内容还没有保存，关闭后需要重新填写。',
        confirmText: '放弃修改',
        cancelText: '继续填写',
        tone: 'danger',
      });
      askingRef.current = false;
      if (!ok) return;
    }
    onClose();
  };

  let modelHint: React.ReactNode;
  if (modelsError) {
    modelHint = (
      <span className="text-rose-600">
        没有拿到模型列表：{modelsError}
        <span className="mt-0.5 block text-ink-500">不影响使用，直接填写模型名称也可以。</span>
      </span>
    );
  } else if (models && models.length > 0) {
    modelHint = (
      <span>
        已获取 <span className="font-medium tabular-nums text-ink-700">{models.length}</span>{' '}
        个模型。点一下输入框，从下拉里选；输入几个字符可以筛选，清空输入框能看到全部。
      </span>
    );
  } else if (models) {
    modelHint = '服务商没有返回任何模型，请直接填写模型名称。';
  } else {
    modelHint = '可以直接填写；也可以先点“获取模型列表”，再从下拉里选。';
  }

  return (
    <Drawer
      open={open}
      onClose={() => void requestClose()}
      width={480}
      title="模型服务设置"
      description="任意兼容 OpenAI 接口的服务都可以用。"
      footer={
        current ? (
          <>
            {keyMissing && <span className="mr-auto text-xs leading-5 text-ink-500">填写 API Key 之后才能保存</span>}
            <Button variant="ghost" disabled={saving} onClick={() => void requestClose()}>
              取消
            </Button>
            <Button variant="primary" loading={saving} disabled={keyMissing} onClick={() => void save()}>
              保存
            </Button>
          </>
        ) : undefined
      }
    >
      {!current && fetchError ? (
        <div className="flex gap-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2.5 text-[13px] leading-5 text-rose-700">
          <ExclamationCircleIcon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="break-words">读取不到已保存的设置：{fetchError}</p>
            <Button size="sm" className="mt-2" onClick={() => setFetchRound((round) => round + 1)}>
              重试
            </Button>
          </div>
        </div>
      ) : !current ? (
        <div className="space-y-6" aria-busy="true" aria-label="正在读取已保存的设置">
          {[0, 1, 2].map((index) => (
            <div key={index}>
              <Skeleton className="h-3.5 w-20" />
              <Skeleton className="mt-2.5 h-8 w-full rounded-md" />
              <Skeleton className="mt-2.5 h-3 w-3/4" />
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-5">
          {demo && (
            <div className="flex gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-[13px] leading-5 text-amber-900">
              <InformationCircleIcon className="mt-px h-[18px] w-[18px] shrink-0 text-amber-600" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="font-medium">当前是演示模式，不调用真实模型，不需要配置。</p>
                <p className="mt-0.5 text-amber-800">下面的表单仍然可以填写和保存，退出演示模式后生效。</p>
              </div>
            </div>
          )}

          <Field
            label="API Key"
            required={!hasSavedKey}
            error={errors.key}
            hint={
              <>
                密钥只保存在本机的用户目录（
                <code className="break-all text-[11px] text-ink-600">~/.ai_write_helper/user_config.json</code>
                ），页面不会回显。
              </>
            }
          >
            <div className="relative">
              <Input
                ref={keyRef}
                type={showKey ? 'text' : 'password'}
                name="model-service-api-key"
                autoComplete="off"
                spellCheck={false}
                data-autofocus={hasSavedKey ? undefined : true}
                value={apiKey}
                placeholder={
                  hasSavedKey
                    ? `已保存（${current.api_key_hint || '已设置'}），留空表示不修改`
                    : '粘贴服务商提供的 API Key'
                }
                className="pr-9"
                onChange={(event) => changeKey(event.target.value)}
              />
              <button
                type="button"
                aria-label={showKey ? '隐藏密钥' : '显示密钥'}
                title={showKey ? '隐藏密钥' : '显示密钥'}
                aria-pressed={showKey}
                className="absolute inset-y-0 right-0 flex w-8 items-center justify-center rounded-r-md text-ink-400 hover:text-ink-700"
                onClick={() => setShowKey((value) => !value)}
              >
                {showKey ? <EyeSlashIcon className="h-4 w-4" /> : <EyeIcon className="h-4 w-4" />}
              </button>
            </div>
          </Field>

          <Field
            label="接口地址（Base URL）"
            error={errors.url}
            hint="点服务商的名字可以直接填入它的地址；留空则使用 OpenAI 官方地址。"
          >
            <Input
              ref={urlRef}
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              value={baseUrl}
              placeholder="https://api.deepseek.com/v1"
              onChange={(event) => changeUrl(event.target.value)}
            />
            <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label="常用服务商">
              {PROVIDERS.map((provider) => {
                const active = sameUrl(baseUrl, provider.url);
                return (
                  <button
                    key={provider.name}
                    type="button"
                    aria-pressed={active}
                    title={provider.url}
                    onClick={() => {
                      if (!active) changeUrl(provider.url);
                    }}
                    className={cx(
                      'rounded-full border px-2 py-0.5 text-xs leading-5 transition-colors',
                      active
                        ? 'border-primary-300 bg-primary-50 font-medium text-primary-700'
                        : 'border-line bg-white text-ink-600 hover:border-primary-300 hover:text-primary-700'
                    )}
                  >
                    {provider.name}
                  </button>
                );
              })}
            </div>
          </Field>

          <Field label="模型名称" required error={errors.model} hint={modelHint}>
            <div className="flex items-center gap-2">
              <Input
                ref={modelRef}
                list={modelListId}
                autoComplete="off"
                spellCheck={false}
                value={modelName}
                placeholder="例如 deepseek-chat"
                className="min-w-0 flex-1"
                onChange={(event) => changeModel(event.target.value)}
              />
              <Button className="shrink-0" loading={loadingModels} onClick={() => void fetchModels()}>
                获取模型列表
              </Button>
            </div>
            <datalist id={modelListId}>
              {(models || []).map((model) => (
                <option key={model} value={model} />
              ))}
            </datalist>
          </Field>

          <div className="border-t border-line pt-5">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <Button loading={testing} onClick={() => void test()}>
                测试连接
              </Button>
              <p className="min-w-0 flex-1 text-xs leading-5 text-ink-500">
                {testing ? '正在等模型应答，一般几秒钟…' : '用上面填写的内容向模型发一句话，确认能用。不会保存。'}
              </p>
            </div>
            {outcome && (
              <div
                role="status"
                className={cx(
                  'mt-3 flex gap-2 rounded-md border px-3 py-2.5 text-[13px] leading-5',
                  outcome.ok
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                    : 'border-rose-200 bg-rose-50 text-rose-700'
                )}
              >
                {outcome.ok ? (
                  <CheckCircleIcon className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" aria-hidden="true" />
                ) : (
                  <ExclamationCircleIcon className="mt-0.5 h-4 w-4 shrink-0 text-rose-500" aria-hidden="true" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="break-words">
                    {outcome.ok ? '' : '连接失败：'}
                    {outcome.message}
                  </p>
                  {outcome.ok && outcome.latencyMs > 0 && (
                    <p className="mt-0.5 text-xs tabular-nums text-emerald-700">耗时 {formatLatency(outcome.latencyMs)}</p>
                  )}
                </div>
              </div>
            )}
          </div>

          {saveError && (
            <div
              role="alert"
              className="flex gap-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2.5 text-[13px] leading-5 text-rose-700"
            >
              <ExclamationCircleIcon className="mt-0.5 h-4 w-4 shrink-0 text-rose-500" aria-hidden="true" />
              <p className="min-w-0 flex-1 break-words">没有保存成功：{saveError}</p>
            </div>
          )}
        </div>
      )}
    </Drawer>
  );
}
