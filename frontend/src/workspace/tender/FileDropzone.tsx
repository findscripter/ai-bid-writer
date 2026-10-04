/**
 * 文件拖拽 / 选择区（只负责行为，外观由调用方决定）。
 *
 * 用法：
 *   <FileDropzone label="选择招标文件" onFiles={upload} clickable>
 *     {({ dragging }) => <div className={dragging ? '高亮' : ''}>把文件拖到这里，或点击选择</div>}
 *   </FileDropzone>
 *
 * - clickable：整个区域可以点击、可以用键盘聚焦后按回车打开选择框；
 *   为 false 时只接受拖拽，由调用方通过 ref.open() 或 children 里拿到的 open 打开选择框
 * - disabled：不响应点击和拖放
 * - 同一个文件可以连续选择两次（每次选完都会清空选择框）
 */
import { forwardRef, useCallback, useImperativeHandle, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent, KeyboardEvent, ReactNode } from 'react';
import { cx } from '../../ui';
import { DOCUMENT_ACCEPT } from './upload';

export interface FileDropzoneHandle {
  /** 打开系统的文件选择框 */
  open: () => void;
}

/** pick：在文件选择框里选的；drop：拖进来的 */
export type FileSource = 'pick' | 'drop';

interface FileDropzoneProps {
  onFiles: (files: File[], source: FileSource) => void;
  /** 读屏文案；clickable 时也是整个区域的名称 */
  label: string;
  multiple?: boolean;
  disabled?: boolean;
  clickable?: boolean;
  /** 标在隐藏的文件选择框上，便于定位 */
  inputName?: string;
  className?: string;
  children: (state: { dragging: boolean; open: () => void }) => ReactNode;
}

function hasFiles(event: DragEvent<HTMLElement>): boolean {
  const types = event.dataTransfer ? event.dataTransfer.types : null;
  if (!types) return false;
  // 不同浏览器里 types 可能是数组，也可能是 DOMStringList
  return Array.prototype.indexOf.call(types, 'Files') >= 0;
}

export const FileDropzone = forwardRef<FileDropzoneHandle, FileDropzoneProps>(function FileDropzone(
  { onFiles, label, multiple = false, disabled = false, clickable = false, inputName, className, children },
  ref
) {
  const inputRef = useRef<HTMLInputElement>(null);
  // 拖拽经过子元素时会成对触发 enter / leave，用计数判断是否真的离开了整个区域
  const depth = useRef(0);
  const [dragging, setDragging] = useState(false);

  const open = useCallback(() => {
    if (disabled || !inputRef.current) return;
    inputRef.current.click();
  }, [disabled]);

  useImperativeHandle(ref, () => ({ open }), [open]);

  const onChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files ? Array.from(event.target.files) : [];
    event.target.value = '';
    if (files.length > 0 && !disabled) onFiles(files, 'pick');
  };

  const onDragEnter = (event: DragEvent<HTMLDivElement>) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    depth.current += 1;
    if (!disabled) setDragging(true);
  };

  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = disabled ? 'none' : 'copy';
  };

  const onDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (!hasFiles(event)) return;
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setDragging(false);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    depth.current = 0;
    setDragging(false);
    if (disabled) return;
    const files = Array.from(event.dataTransfer.files);
    if (files.length > 0) onFiles(files, 'drop');
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      open();
    }
  };

  const interactive = clickable && !disabled;

  return (
    <div
      className={cx('relative', clickable && (disabled ? 'cursor-not-allowed' : 'cursor-pointer'), className)}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? (disabled ? -1 : 0) : undefined}
      aria-label={clickable ? label : undefined}
      aria-disabled={clickable && disabled ? true : undefined}
      onClick={interactive ? open : undefined}
      onKeyDown={interactive ? onKeyDown : undefined}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <input
        ref={inputRef}
        type="file"
        name={inputName}
        accept={DOCUMENT_ACCEPT}
        multiple={multiple}
        disabled={disabled}
        tabIndex={-1}
        aria-label={label}
        className="hidden"
        onChange={onChange}
        onClick={(event) => event.stopPropagation()}
      />
      {children({ dragging: dragging && !disabled, open })}
    </div>
  );
});
