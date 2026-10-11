/**
 * 模态对话框（基于 Headless UI 的 Dialog：自带焦点圈定、Esc 关闭、滚动锁定、读屏标注）
 *
 * 用法：
 *   <Modal
 *     open={open}
 *     onClose={() => setOpen(false)}
 *     title="新建项目"
 *     description="上传招标文件后开始解析"
 *     footer={<>
 *       <Button onClick={() => setOpen(false)}>取消</Button>
 *       <Button variant="primary" loading={saving} onClick={submit}>创建</Button>
 *     </>}
 *   >
 *     <Field label="项目名称"><Input autoFocus /></Field>
 *   </Modal>
 *
 * - size：sm 384px / md 512px（默认）/ lg 672px / xl 896px；要别的宽度用 className 传 max-w-* 类
 * - 内容超高时只有中间内容区滚动，标题和 footer 固定
 * - dismissible：默认 true；传 false 时点遮罩、按 Esc 都不关闭，右上角的关闭按钮也不显示
 *   （用于进行中不能打断的操作，此时必须在 footer 里给出口）
 * - 初始焦点：默认落在对话框本身。想让某个控件先获得焦点：本目录的控件（Input / Textarea /
 *   Select / NumberInput / Checkbox / Button）写 autoFocus 即可；原生元素要写 data-autofocus
 *   （对话框内容先渲染、后挂进文档，原生 autoFocus 在里面不生效）
 * - padded：内容区是否留内边距，默认 true
 * - 只需要「确定 / 取消」的二次确认请用 useConfirm()，不用自己拼 Modal
 */
import { Description, Dialog, DialogBackdrop, DialogPanel, DialogTitle } from '@headlessui/react';
import { XMarkIcon } from '@heroicons/react/20/solid';
import type { ReactNode } from 'react';
import { cx, mergeClass } from './cx';
import { IconButton } from './IconButton';

export type ModalSize = 'sm' | 'md' | 'lg' | 'xl';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  description?: ReactNode;
  size?: ModalSize;
  /** 底部操作区，靠右排列 */
  footer?: ReactNode;
  /** false 时点遮罩和按 Esc 不关闭，也不显示右上角关闭按钮 */
  dismissible?: boolean;
  padded?: boolean;
  /** 不显示右上角关闭按钮（点遮罩、按 Esc 仍可关闭） */
  hideClose?: boolean;
  /** 读屏语义：需要用户立即回应的确认框用 alertdialog */
  role?: 'dialog' | 'alertdialog';
  /** 作用在对话框面板上 */
  className?: string;
  children?: ReactNode;
}

const SIZE: Record<ModalSize, string> = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
};

const noop = () => {};

export function Modal({
  open,
  onClose,
  title,
  description,
  size = 'md',
  footer,
  dismissible = true,
  padded = true,
  hideClose = false,
  role = 'dialog',
  className,
  children,
}: ModalProps) {
  const showClose = dismissible && !hideClose;
  const hasHeader = title != null || description != null || showClose;
  const hasBody = children != null && children !== false;
  return (
    <Dialog
      open={open}
      onClose={dismissible ? onClose : noop}
      role={role}
      className="relative z-50 focus:outline-none"
    >
      <DialogBackdrop
        transition
        className="fixed inset-0 bg-ink-900/40 transition-opacity duration-200 ease-out data-[closed]:opacity-0"
      />
      <div className="fixed inset-0 flex items-center justify-center p-4 sm:p-8">
        <DialogPanel
          transition
          className={mergeClass(
            cx(
              'flex max-h-full w-full flex-col rounded-xl border border-line bg-white shadow-pop',
              'transition duration-200 ease-out data-[closed]:translate-y-2 data-[closed]:opacity-0',
              SIZE[size]
            ),
            className
          )}
        >
          {hasHeader ? (
            <div className={cx('flex shrink-0 items-start gap-3 px-5 pt-4', hasBody ? 'pb-1' : 'pb-4')}>
              <div className="min-w-0 flex-1">
                {title != null ? (
                  <DialogTitle className="text-base font-semibold leading-7 text-ink-900">{title}</DialogTitle>
                ) : null}
                {description != null ? (
                  <Description className="mt-0.5 text-[13px] leading-5 text-ink-500">{description}</Description>
                ) : null}
              </div>
              {showClose ? (
                <IconButton label="关闭" icon={<XMarkIcon />} size="sm" className="-mr-1.5" onClick={onClose} />
              ) : null}
            </div>
          ) : null}
          {hasBody ? (
            <div className={cx('min-h-0 flex-1 overflow-y-auto', padded && 'px-5 py-4')}>{children}</div>
          ) : null}
          {footer != null ? (
            <div className="flex shrink-0 items-center justify-end gap-2 rounded-b-xl border-t border-line bg-subtle px-5 py-3">
              {footer}
            </div>
          ) : null}
        </DialogPanel>
      </div>
    </Dialog>
  );
}
