/**
 * 抽屉：从屏幕一侧滑出的面板（基于 Headless UI 的 Dialog，行为同 Modal）
 *
 * 用法：
 *   <Drawer open={open} onClose={() => setOpen(false)} title="本章写作计划" width={480}
 *           footer={<Button variant="primary" onClick={save}>保存</Button>}>
 *     ...
 *   </Drawer>
 *
 * - side：right 默认 / left
 * - width：数字按 px，字符串原样使用（如 "40vw"）；默认 420，窄屏时不超过屏宽
 * - 点遮罩、按 Esc、点右上角关闭按钮都会触发 onClose；dismissible={false} 可全部关掉
 * - 内容超高时只有中间内容区滚动，标题和 footer 固定
 * - padded：内容区是否留内边距，默认 true
 * - 初始焦点：同 Modal（本目录的控件写 autoFocus，原生元素写 data-autofocus）
 */
import { Description, Dialog, DialogBackdrop, DialogPanel, DialogTitle } from '@headlessui/react';
import { XMarkIcon } from '@heroicons/react/20/solid';
import type { ReactNode } from 'react';
import { cx, mergeClass } from './cx';
import { IconButton } from './IconButton';

export type DrawerSide = 'right' | 'left';

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  description?: ReactNode;
  side?: DrawerSide;
  width?: number | string;
  /** 底部操作区，靠右排列 */
  footer?: ReactNode;
  /** false 时点遮罩和按 Esc 不关闭，也不显示右上角关闭按钮 */
  dismissible?: boolean;
  padded?: boolean;
  /** 作用在抽屉面板上 */
  className?: string;
  children?: ReactNode;
}

const noop = () => {};

export function Drawer({
  open,
  onClose,
  title,
  description,
  side = 'right',
  width = 420,
  footer,
  dismissible = true,
  padded = true,
  className,
  children,
}: DrawerProps) {
  const right = side === 'right';
  const hasHeader = title != null || description != null || dismissible;
  return (
    <Dialog open={open} onClose={dismissible ? onClose : noop} className="relative z-50 focus:outline-none">
      <DialogBackdrop
        transition
        className="fixed inset-0 bg-ink-900/30 transition-opacity duration-200 ease-out data-[closed]:opacity-0"
      />
      <div className={cx('fixed inset-y-0 flex max-w-full', right ? 'right-0' : 'left-0')}>
        <DialogPanel
          transition
          style={{ width }}
          className={mergeClass(
            cx(
              'flex h-full max-w-[100vw] flex-col bg-white shadow-pop transition duration-200 ease-out',
              right
                ? 'border-l border-line data-[closed]:translate-x-full'
                : 'border-r border-line data-[closed]:-translate-x-full'
            ),
            className
          )}
        >
          {hasHeader ? (
            <div className="flex shrink-0 items-start gap-3 border-b border-line px-5 py-3">
              <div className="min-w-0 flex-1">
                {title != null ? (
                  <DialogTitle className="text-[15px] font-semibold leading-7 text-ink-900">{title}</DialogTitle>
                ) : null}
                {description != null ? (
                  <Description className="mt-0.5 text-[13px] leading-5 text-ink-500">{description}</Description>
                ) : null}
              </div>
              {dismissible ? (
                <IconButton label="关闭" icon={<XMarkIcon />} size="sm" className="-mr-1.5" onClick={onClose} />
              ) : null}
            </div>
          ) : null}
          <div className={cx('min-h-0 flex-1 overflow-y-auto', padded && 'px-5 py-4')}>{children}</div>
          {footer != null ? (
            <div className="flex shrink-0 items-center justify-end gap-2 border-t border-line bg-subtle px-5 py-3">
              {footer}
            </div>
          ) : null}
        </DialogPanel>
      </div>
    </Dialog>
  );
}
