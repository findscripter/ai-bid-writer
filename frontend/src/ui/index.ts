/**
 * 基础组件库统一出口。
 *
 * 页面里统一这样引用：
 *   import { Button, Modal, useToast } from '../ui';
 *
 * 应用根部需要挂两个 Provider（顺序无所谓）：
 *   <ToastProvider><ConfirmProvider><App /></ConfirmProvider></ToastProvider>
 *
 * 视觉验收页在 ./Gallery（默认导出，没有接入路由）。
 * 路由、Markdown 渲染、格式化函数在 ../lib 下：router.ts / MarkdownView.tsx / format.ts。
 */
export { cx, mergeClass } from './cx';

export { Button } from './Button';
export type { ButtonProps, ButtonSize, ButtonVariant } from './Button';

export { IconButton } from './IconButton';
export type { IconButtonProps, IconButtonSize, IconButtonVariant } from './IconButton';

export { Badge } from './Badge';
export type { BadgeProps, BadgeSize, BadgeTone } from './Badge';

export { Card } from './Card';
export type { CardProps } from './Card';

export { Modal } from './Modal';
export type { ModalProps, ModalSize } from './Modal';

export { Drawer } from './Drawer';
export type { DrawerProps, DrawerSide } from './Drawer';

export { Tabs } from './Tabs';
export type { TabItem, TabsProps, TabsSize, TabsVariant } from './Tabs';

export { Field } from './Field';
export type { FieldProps } from './Field';

export { Input } from './Input';
export type { InputProps } from './Input';

export { Textarea } from './Textarea';
export type { TextareaProps } from './Textarea';

export { Select } from './Select';
export type { SelectOption, SelectProps } from './Select';

export { Checkbox } from './Checkbox';
export type { CheckboxProps } from './Checkbox';

export { Switch } from './Switch';
export type { SwitchProps, SwitchSize } from './Switch';

export { NumberInput } from './NumberInput';
export type { NumberInputProps } from './NumberInput';

export { Spinner } from './Spinner';
export type { SpinnerProps, SpinnerSize, SpinnerTone } from './Spinner';

export { ProgressBar } from './ProgressBar';
export type { ProgressBarProps, ProgressSize, ProgressTone } from './ProgressBar';

export { EmptyState } from './EmptyState';
export type { EmptyStateProps } from './EmptyState';

export { ToastProvider, toast, useToast } from './Toast';
export type { ToastApi, ToastKind, ToastOptions } from './Toast';

export { ConfirmProvider, useConfirm } from './ConfirmDialog';
export type { ConfirmFn, ConfirmOptions } from './ConfirmDialog';

export { StatusDot, STATUS_LABEL } from './StatusDot';
export type { DotStatus, StatusDotProps } from './StatusDot';

export { Skeleton } from './Skeleton';
export type { SkeletonProps } from './Skeleton';

export { Tooltip } from './Tooltip';
export type { TooltipProps, TooltipSide } from './Tooltip';
