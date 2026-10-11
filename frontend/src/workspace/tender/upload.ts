/**
 * 上传前的本地检查：扩展名、大小。能在本地说清楚的问题不必等后端报错。
 * 真正的类型判断（文件头、是否加密、是否损坏）仍由后端完成。
 */

/** 文件选择框的 accept：只列扩展名和对应的类型 */
export const DOCUMENT_ACCEPT =
  '.docx,.pdf,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** 把字节数写成使用者习惯的 MB / KB（与后端报错里的写法一致） */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0KB';
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')}MB`;
  }
  return `${Math.max(Math.floor(bytes / 1024), 1)}KB`;
}

function extensionOf(name: string): string {
  const match = /\.([^./\\]+)$/.exec(name);
  return match ? match[1].toLowerCase() : '';
}

/**
 * 检查一个待上传的文档。没问题返回 null，否则返回可以直接展示的原因。
 * maxSize 为 null 表示还不知道上限（应用信息没加载完），此时交给后端判断。
 */
export function checkDocumentFile(file: File, maxSize: number | null): string | null {
  const extension = extensionOf(file.name);
  if (extension === 'doc') {
    return '暂不支持老式 Word 格式（.doc）。请用 Word 或 WPS 打开它，另存为 .docx 后再上传。';
  }
  // 没有扩展名的文件交给后端按内容判断
  if (extension && extension !== 'docx' && extension !== 'pdf') {
    return `不支持这种文件（.${extension}）。只能上传 Word 文档（.docx）或 PDF（.pdf）。`;
  }
  if (file.size === 0) {
    return '这个文件是空的（0 字节），请确认文件完整后重新选择。';
  }
  if (maxSize && file.size > maxSize) {
    return `文件太大（${formatFileSize(file.size)}），上限是 ${formatFileSize(maxSize)}。请压缩文件里的图片，或拆分后再上传。`;
  }
  return null;
}

/** 上传区下方的格式说明 */
export function formatHint(maxSize: number | null): string {
  const size = maxSize ? `，不超过 ${formatFileSize(maxSize)}` : '';
  return `支持 Word 文档（.docx）和 PDF（.pdf）${size}。老式 .doc 请先另存为 .docx。`;
}
