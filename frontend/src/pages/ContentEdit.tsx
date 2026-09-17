/**
 * 内容编辑页面 - 完整标书预览和生成
 */
import React, { useState, useEffect, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import { OutlineData, OutlineItem } from '../types';
import { DocumentTextIcon, PlayIcon, DocumentArrowDownIcon, CheckCircleIcon, ExclamationCircleIcon, ArrowUpIcon } from '@heroicons/react/24/outline';
import {
  collectSseText,
  contentApi,
  ChapterContentRequest,
  documentApi,
  getErrorMessage,
  Persona,
  MultiCopyEvent,
  readMultiCopySseStream,
} from '../services/api';
import { saveAs } from 'file-saver';
import { draftStorage } from '../utils/draftStorage';

interface ContentEditProps {
  outlineData: OutlineData | null;
}

interface GenerationProgress {
  total: number;
  completed: number;
  current: string;
  failed: string[];
  generating: Set<string>; // 正在生成的项目ID集合
}

interface MultiCopyParams {
  targetPages: number;
  extendedTargetPages: number;
  copies: number;
  injectResponseChapters: boolean;
  parallelConcurrency: number;
  modelsText: string; // 逗号分隔的模型ID，按份轮转；空=全部用默认模型
}

interface MultiCopyChapterResult {
  chapterId: string;
  title: string;
  targetWords: number | null;
  charCount: number;
  content: string;
}

interface MultiCopyResult {
  copyIndex: number;
  persona: Persona | null;
  chapters: MultiCopyChapterResult[];
  totalChars: number;
  outline?: OutlineItem[]; // 该份自己的目录树（每份结构可能不同）
  leafCount?: number; // 该份的叶子章节数
  model?: string; // 该份使用的模型
}

interface MultiCopyProgress {
  active: boolean;
  totalChapters: number;
  completedChapters: number;
  currentLabel: string;
  errorMessage: string | null;
}


const ContentEdit: React.FC<ContentEditProps> = ({
  outlineData,
}) => {
  const [isGenerating, setIsGenerating] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [progress, setProgress] = useState<GenerationProgress>({
    total: 0,
    completed: 0,
    current: '',
    failed: [],
    generating: new Set<string>()
  });
  const [leafItems, setLeafItems] = useState<OutlineItem[]>([]);
  const [showScrollToTop, setShowScrollToTop] = useState(false);
  const [singleTargetPages, setSingleTargetPages] = useState<number>(40);
  const [exportWithDiagrams, setExportWithDiagrams] = useState<boolean>(false);
  const [exportDiagramModel, setExportDiagramModel] = useState<string>('');

  // 多份生成相关状态
  const [showMultiPanel, setShowMultiPanel] = useState(false);
  const [multiParams, setMultiParams] = useState<MultiCopyParams>({
    targetPages: 40,
    extendedTargetPages: 60,
    copies: 4,
    injectResponseChapters: true,
    parallelConcurrency: 3,
    modelsText: '',
  });
  const [multiResults, setMultiResults] = useState<MultiCopyResult[]>([]);
  const [multiProgress, setMultiProgress] = useState<MultiCopyProgress>({
    active: false,
    totalChapters: 0,
    completedChapters: 0,
    currentLabel: '',
    errorMessage: null,
  });
  const [exportingCopyIndex, setExportingCopyIndex] = useState<number | null>(null);

  // 收集所有叶子节点
  const collectLeafItems = useCallback((items: OutlineItem[]): OutlineItem[] => {
    let leaves: OutlineItem[] = [];
    items.forEach(item => {
      if (!item.children || item.children.length === 0) {
        leaves.push(item);
      } else {
        leaves = leaves.concat(collectLeafItems(item.children));
      }
    });
    return leaves;
  }, []);

  // 获取章节的上级章节信息
  const getParentChapters = useCallback((targetId: string, items: OutlineItem[], parents: OutlineItem[] = []): OutlineItem[] => {
    for (const item of items) {
      if (item.id === targetId) {
        return parents;
      }
      if (item.children && item.children.length > 0) {
        const found = getParentChapters(targetId, item.children, [...parents, item]);
        if (found.length > 0 || item.children.some(child => child.id === targetId)) {
          return found.length > 0 ? found : [...parents, item];
        }
      }
    }
    return [];
  }, []);

  // 获取章节的同级章节信息
  const getSiblingChapters = useCallback((targetId: string, items: OutlineItem[]): OutlineItem[] => {
    // 直接在当前级别查找
    if (items.some(item => item.id === targetId)) {
      return items;
    }
    
    // 递归在子级别查找
    for (const item of items) {
      if (item.children && item.children.length > 0) {
        const siblings = getSiblingChapters(targetId, item.children);
        if (siblings.length > 0) {
          return siblings;
        }
      }
    }
    
    return [];
  }, []);

  useEffect(() => {
    if (outlineData) {
      const leaves = collectLeafItems(outlineData.outline);
      // 恢复本地缓存的正文内容（仅对叶子节点生效）
      const filtered = draftStorage.filterContentByOutlineLeaves(outlineData.outline);
      const mergedLeaves = leaves.map((leaf) => {
        const cached = filtered[leaf.id];
        return cached ? { ...leaf, content: cached } : leaf;
      });

      // 目录变更时，顺手清理掉无效的旧缓存（只保留当前叶子节点）
      draftStorage.saveContentById(filtered);

      setLeafItems(mergedLeaves);
      setProgress(prev => ({ ...prev, total: leaves.length }));
    }
  }, [outlineData, collectLeafItems]);

  // 监听页面滚动，控制回到顶部按钮的显示
  useEffect(() => {
    // 现在主内容区为内部滚动容器（App.tsx: #app-main-scroll），不能只监听 window
    const scrollContainer = document.getElementById('app-main-scroll');

    const handleScroll = () => {
      const scrollTop = scrollContainer
        ? scrollContainer.scrollTop
        : (window.pageYOffset || document.documentElement.scrollTop);
      setShowScrollToTop(scrollTop > 300);
    };

    // 初始化计算一次，避免刷新后位置不对
    handleScroll();

    const target = scrollContainer || window;
    target.addEventListener('scroll', handleScroll);
    return () => target.removeEventListener('scroll', handleScroll);
  }, []);

  // 获取叶子节点的实时内容
  const getLeafItemContent = (itemId: string): string | undefined => {
    const leafItem = leafItems.find(leaf => leaf.id === itemId);
    return leafItem?.content;
  };

  // 检查是否为叶子节点
  const isLeafNode = (item: OutlineItem): boolean => {
    return !item.children || item.children.length === 0;
  };

  // 渲染目录结构
  const renderOutline = (items: OutlineItem[], level: number = 1): React.ReactElement[] => {
    return items.map((item) => {
      const isLeaf = isLeafNode(item);
      const currentContent = isLeaf ? getLeafItemContent(item.id) : item.content;
      
      return (
        <div key={item.id} className={`mb-${level === 1 ? '8' : '4'}`}>
          {/* 标题 */}
          <div className={`text-${level === 1 ? 'xl' : level === 2 ? 'lg' : 'base'} font-${level === 1 ? 'bold' : 'semibold'} text-slate-900 mb-2`}>
            {item.id} {item.title}
          </div>
          
          {/* 描述 */}
          <div className="text-sm text-slate-600 mb-4">
            {item.description}
          </div>

          {/* 内容（仅叶子节点） */}
          {isLeaf && (
            <div className="border-l-4 border-primary-200 pl-4 mb-6">
              {currentContent ? (
                <div className="prose max-w-none">
                  <ReactMarkdown>{currentContent}</ReactMarkdown>
                </div>
              ) : (
                <div className="text-slate-400 italic py-4">
                  <DocumentTextIcon className="inline w-4 h-4 mr-2" />
                  {progress.generating.has(item.id) ? (
                    <span className="text-primary-600">正在生成内容...</span>
                  ) : (
                    '内容待生成...'
                  )}
                </div>
              )}
            </div>
          )}

          {/* 子章节 */}
          {item.children && item.children.length > 0 && (
            <div className={`ml-${level * 4} mt-4`}>
              {renderOutline(item.children, level + 1)}
            </div>
          )}
        </div>
      );
    });
  };

  // 生成单个章节内容
  const generateItemContent = async (
    item: OutlineItem,
    projectOverview: string,
    targetWords?: number,
  ): Promise<OutlineItem> => {
    if (!outlineData) throw new Error('缺少目录数据');

    setProgress(prev => ({
      ...prev,
      current: item.title,
      generating: new Set([...Array.from(prev.generating), item.id])
    }));

    try {
      const parentChapters = getParentChapters(item.id, outlineData.outline);
      const siblingChapters = getSiblingChapters(item.id, outlineData.outline);

      const request: ChapterContentRequest = {
        chapter: item,
        parent_chapters: parentChapters,
        sibling_chapters: siblingChapters,
        project_overview: projectOverview,
        target_words: targetWords,
      };

      const response = await contentApi.generateChapterContentStream(request);

      let content = '';
      const updatedItem = { ...item };

      await collectSseText(
        response,
        (fullText) => {
          content = fullText;
          updatedItem.content = content;
          draftStorage.upsertChapterContent(item.id, content);
          setLeafItems((prevItems) => {
            const newItems = [...prevItems];
            const index = newItems.findIndex((leafItem) => leafItem.id === item.id);
            if (index !== -1) {
              newItems[index] = { ...updatedItem };
            }
            return newItems;
          });
        },
        '章节内容生成失败'
      );

      return updatedItem;
    } catch (error) {
      setProgress(prev => ({
        ...prev,
        failed: [...prev.failed, item.title]
      }));
      throw error;
    } finally {
      // 从正在生成的集合中移除当前项目
      setProgress(prev => {
        const newGenerating = new Set(Array.from(prev.generating));
        newGenerating.delete(item.id);
        return {
          ...prev,
          generating: newGenerating
        };
      });
    }
  };

  // 开始生成所有内容
  const handleGenerateContent = async () => {
    if (!outlineData || leafItems.length === 0) return;

    setIsGenerating(true);
    setMessage(null);
    setProgress({
      total: leafItems.length,
      completed: 0,
      current: '',
      failed: [],
      generating: new Set<string>()
    });

    // 按目标页数均摊每章字数（750字/页，200字下限，8000字上限）
    const WORDS_PER_PAGE = 750;
    const totalWords = singleTargetPages * WORDS_PER_PAGE;
    const rawPerChapter = leafItems.length > 0 ? Math.floor(totalWords / leafItems.length) : 750;
    const perChapterWords = Math.max(200, Math.min(8000, rawPerChapter));

    try {
      const concurrency = 3;
      const updatedItems = [...leafItems];

      for (let i = 0; i < leafItems.length; i += concurrency) {
        const batch = leafItems.slice(i, i + concurrency);
        const promises = batch.map(item =>
          generateItemContent(item, outlineData.project_overview || '', perChapterWords)
            .then(updatedItem => {
              const index = updatedItems.findIndex(ui => ui.id === updatedItem.id);
              if (index !== -1) updatedItems[index] = updatedItem;
              setProgress(prev => ({ ...prev, completed: prev.completed + 1 }));
              return updatedItem;
            })
            .catch(() => {
              setProgress(prev => ({ ...prev, completed: prev.completed + 1 }));
              return item;
            })
        );
        await Promise.all(promises);
      }

      setLeafItems(updatedItems);
    } catch (error) {
      setMessage({ type: 'error', text: getErrorMessage(error, '生成内容失败') });
    } finally {
      setIsGenerating(false);
      setProgress(prev => ({ ...prev, current: '', generating: new Set<string>() }));
    }
  };

  // 多份生成主流程：调用 SSE 接口，按事件累积每份每章内容
  const handleGenerateMultiCopies = async () => {
    if (!outlineData || leafItems.length === 0) {
      setMessage({ type: 'error', text: '请先生成目录' });
      return;
    }
    if (multiParams.copies < 2) {
      setMessage({ type: 'error', text: '多份生成至少需要 2 份' });
      return;
    }

    setMessage(null);
    setMultiResults([]);
    setMultiProgress({
      active: true,
      totalChapters: leafItems.length * multiParams.copies,
      completedChapters: 0,
      currentLabel: '准备中...',
      errorMessage: null,
    });

    // 用本地变量累积，避免 React 异步 setState 导致丢事件
    const acc = new Map<number, MultiCopyResult>();
    // 章节 id → 标题（包括后端注入的响应章节）
    const chapterTitleMap = new Map<string, string>();
    leafItems.forEach((l) => chapterTitleMap.set(l.id, l.title));

    try {
      const modelList = multiParams.modelsText
        .split(/[,，;；\n]/)
        .map((m) => m.trim())
        .filter(Boolean);

      const response = await contentApi.generateMultiCopiesStream({
        outline: { outline: outlineData.outline },
        project_overview: outlineData.project_overview || '',
        target_pages: multiParams.targetPages,
        extended_target_pages: multiParams.extendedTargetPages,
        copies: multiParams.copies,
        inject_response_chapters: multiParams.injectResponseChapters,
        parallel_concurrency: multiParams.parallelConcurrency,
        models: modelList.length > 0 ? modelList : undefined,
      });

      await readMultiCopySseStream(response, (event: MultiCopyEvent) => {
        if ('error' in event && event.error === true && !('type' in event)) {
          const errorEvent = event as { error: true; message?: string };
          throw new Error(errorEvent.message || '多份生成失败');
        }
        const ev = event as Exclude<MultiCopyEvent, { error: true; message?: string }>;

        if (ev.type === 'meta') {
          // 每份目录结构不同，总章节数 = 各份叶子数之和（后端已求和）
          const realTotal = ev.total_leaf_count ?? ev.leaf_count;
          setMultiProgress((p) => ({ ...p, totalChapters: realTotal }));
          const failedCount = (ev.copies_plan || []).filter((c) => c.variant_failed).length;
          if (failedCount > 0) {
            setMessage({
              type: 'error',
              text: `有 ${failedCount} 份目录变体生成失败，已回退为原目录结构（这些份的目录可能与第 1 份相同）。`,
            });
          }
        } else if (ev.type === 'copy_start') {
          acc.set(ev.copy_index, {
            copyIndex: ev.copy_index,
            persona: ev.persona,
            chapters: [],
            totalChars: 0,
            outline: ev.outline,
            leafCount: ev.leaf_count,
            model: ev.model,
          });
          const tag = (ev as { is_extended?: boolean }).is_extended ? '【长版】' : '';
          const modelTag = ev.model ? ` · ${ev.model}` : '';
          setMultiProgress((p) => ({ ...p, currentLabel: `${tag}第 ${ev.copy_index + 1} 份开始（${ev.persona?.name ?? '默认风格'}${modelTag}）` }));
        } else if (ev.type === 'chapter_start') {
          if (ev.title) {
            chapterTitleMap.set(ev.chapter_id, ev.title);
          }
          setMultiProgress((p) => ({ ...p, currentLabel: `第 ${ev.copy_index + 1} 份 - ${ev.title}（目标 ${ev.target_words ?? '?'} 字）` }));
        } else if (ev.type === 'chapter_end') {
          const copy = acc.get(ev.copy_index);
          if (copy) {
            copy.chapters.push({
              chapterId: ev.chapter_id,
              title: chapterTitleMap.get(ev.chapter_id) || ev.chapter_id,
              targetWords: null,
              charCount: ev.char_count,
              content: ev.content,
            });
            copy.totalChars += ev.char_count;
          }
          setMultiResults(Array.from(acc.values()).sort((a, b) => a.copyIndex - b.copyIndex));
          setMultiProgress((p) => ({ ...p, completedChapters: p.completedChapters + 1 }));
        }
      });

      setMessage({ type: 'success', text: `已生成 ${multiParams.copies} 份不雷同正文` });
    } catch (err) {
      const errMsg = getErrorMessage(err, '多份生成失败');
      setMultiProgress((p) => ({ ...p, errorMessage: errMsg }));
      setMessage({ type: 'error', text: errMsg });
    } finally {
      setMultiProgress((p) => ({ ...p, active: false, currentLabel: '' }));
    }
  };

  // 把多份生成结果中的某一份导出为 Word（用对应份内容覆盖原 outline 的叶子，
  // 并将后端注入的"响应章节"作为顶级章节追加到导出 outline）
  const handleExportMultiCopy = async (copy: MultiCopyResult) => {
    if (!outlineData) return;
    setExportingCopyIndex(copy.copyIndex);
    try {
      const contentMap = new Map(copy.chapters.map((c) => [c.chapterId, c.content]));
      const usedIds = new Set<string>();

      const buildExportOutline = (items: OutlineItem[]): OutlineItem[] =>
        items.map((item) => {
          usedIds.add(item.id);
          const isLeaf = !item.children || item.children.length === 0;
          const next: OutlineItem = { ...item };
          if (isLeaf) {
            next.content = contentMap.get(item.id) || item.content || '';
          } else {
            next.children = buildExportOutline(item.children!);
          }
          return next;
        });

      // 每份目录结构不同：按"该份自己的目录树"套正文导出；缺失时回退到原目录
      const baseTree = copy.outline && copy.outline.length > 0 ? copy.outline : outlineData.outline;
      const baseOutline = buildExportOutline(baseTree);

      // 后端注入的响应章节在 baseOutline 里不存在，需要补到顶级
      const extraChapters: OutlineItem[] = copy.chapters
        .filter((c) => !usedIds.has(c.chapterId))
        .map((c) => ({
          id: c.chapterId,
          title: c.title,
          description: '',
          content: c.content,
        }));

      const finalOutline = [...baseOutline, ...extraChapters];

      const response = await documentApi.exportWord({
        project_name: outlineData.project_name,
        project_overview: outlineData.project_overview,
        outline: finalOutline,
        copy_index: copy.copyIndex,
        persona_name: copy.persona?.name,
        with_diagrams: exportWithDiagrams,
        diagram_model: exportWithDiagrams ? (exportDiagramModel.trim() || undefined) : undefined,
      });
      const blob = await response.blob();
      const personaSuffix = copy.persona ? `-${copy.persona.name}` : '';
      saveAs(blob, `${outlineData.project_name || '标书文档'}-第${copy.copyIndex + 1}份${personaSuffix}.docx`);
      setMessage({ type: 'success', text: `第 ${copy.copyIndex + 1} 份导出成功（共 ${finalOutline.length} 个一级章节）` });
    } catch (err) {
      setMessage({ type: 'error', text: getErrorMessage(err, '导出失败') });
    } finally {
      setExportingCopyIndex(null);
    }
  };

  // 获取叶子节点的最新内容（包括生成的内容）
  const getLatestContent = (item: OutlineItem): string => {
    if (!item.children || item.children.length === 0) {
      // 叶子节点，从 leafItems 获取最新内容
      const leafItem = leafItems.find(leaf => leaf.id === item.id);
      return leafItem?.content || item.content || '';
    }
    return item.content || '';
  };

  // 解析Markdown内容为Word段落
  // （已提取到文件顶层，供后续导出Word等复用）

  // 滚动到页面顶部
  const scrollToTop = () => {
    const scrollContainer = document.getElementById('app-main-scroll');
    if (scrollContainer) {
      scrollContainer.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // 导出Word文档
  const handleExportWord = async () => {
    if (!outlineData) return;

    try {
      setMessage(null);
      // 构建带有最新内容的导出数据（leafItems 中存的是实时内容）
      const buildExportOutline = (items: OutlineItem[]): OutlineItem[] => {
        return items.map(item => {
          const latestContent = getLatestContent(item);
          const exportedItem: OutlineItem = {
            ...item,
            content: latestContent,
          };
          if (item.children && item.children.length > 0) {
            exportedItem.children = buildExportOutline(item.children);
          }
          return exportedItem;
        });
      };

      const exportPayload = {
        project_name: outlineData.project_name,
        project_overview: outlineData.project_overview,
        outline: buildExportOutline(outlineData.outline),
        with_diagrams: exportWithDiagrams,
        diagram_model: exportWithDiagrams ? (exportDiagramModel.trim() || undefined) : undefined,
      };

      const response = await documentApi.exportWord(exportPayload);
      const blob = await response.blob();
      saveAs(blob, `${outlineData.project_name || '标书文档'}.docx`);
      setMessage({ type: 'success', text: '导出成功' });
    } catch (error) {
      setMessage({ type: 'error', text: getErrorMessage(error, '导出失败，请重试') });
    }
  };

  if (!outlineData) {
    return (
      <div className="max-w-6xl mx-auto">
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6">
          <div className="text-center py-12">
            <DocumentTextIcon className="mx-auto h-12 w-12 text-slate-400" />
            <h3 className="mt-2 text-sm font-medium text-slate-900">暂无内容</h3>
            <p className="mt-1 text-sm text-slate-500">
              请先在"目录编辑"步骤中生成目录结构
            </p>
          </div>
        </div>
      </div>
    );
  }

  const completedItems = leafItems.filter(item => item.content).length;

  return (
    <div className="max-w-6xl mx-auto">
      {/* 顶部工具栏 */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm mb-6">
        <div className="px-6 py-4 border-b border-slate-200">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">标书内容</h2>
              <p className="text-sm text-slate-500 mt-1">
                共 {leafItems.length} 个章节，已生成 {completedItems} 个
                {progress.failed.length > 0 && (
                  <span className="text-red-500 ml-2">失败 {progress.failed.length} 个</span>
                )}
              </p>
            </div>
            
            <div className="flex items-center space-x-3">
              {/* 目标页数控制 */}
              <div className="flex items-center space-x-1.5">
                <label className="text-xs text-slate-500 whitespace-nowrap">目标页数</label>
                <input
                  type="number"
                  min={5}
                  max={300}
                  value={singleTargetPages}
                  onChange={(e) => setSingleTargetPages(Math.max(5, Math.min(300, Number(e.target.value) || 40)))}
                  disabled={isGenerating}
                  className="w-16 rounded border-slate-300 shadow-sm text-sm focus:border-primary-500 focus:ring-primary-500 disabled:opacity-50"
                  title={`每章约 ${leafItems.length > 0 ? Math.max(200, Math.min(8000, Math.floor(singleTargetPages * 750 / leafItems.length))) : 750} 字（A4/小四/1.5倍行距≈750字/页）`}
                />
                <span className="text-xs text-slate-400">
                  ≈{leafItems.length > 0 ? Math.max(200, Math.min(8000, Math.floor(singleTargetPages * 750 / leafItems.length))) : 750}字/章
                </span>
              </div>

              <button
                onClick={handleGenerateContent}
                disabled={isGenerating}
                className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <PlayIcon className="w-4 h-4 mr-2" />
                {isGenerating ? '生成中...' : '生成标书'}
              </button>
              
              <label
                className="inline-flex items-center gap-1.5 text-xs text-slate-600 cursor-pointer select-none"
                title="导出前由 AI 为架构/流程/进度/组织等章节自动生成技术插图并嵌入（会增加导出耗时与 LLM 调用）"
              >
                <input
                  type="checkbox"
                  checked={exportWithDiagrams}
                  onChange={(e) => setExportWithDiagrams(e.target.checked)}
                  disabled={isGenerating}
                  className="h-4 w-4 rounded border-slate-300 text-primary-600 focus:ring-primary-500"
                />
                插入技术插图
              </label>
              {exportWithDiagrams && (
                <input
                  type="text"
                  value={exportDiagramModel}
                  onChange={(e) => setExportDiagramModel(e.target.value)}
                  disabled={isGenerating}
                  placeholder="插图模型(留空用默认)"
                  title="专门用于画图的模型，建议用较强模型。留空则用左侧配置的模型"
                  className="w-44 rounded-md border-slate-300 shadow-sm text-xs font-mono focus:border-primary-500 focus:ring-primary-500"
                />
              )}

              <button
                onClick={handleExportWord}
                disabled={isGenerating}
                className="inline-flex items-center px-4 py-2 border border-slate-300 text-sm font-medium rounded-md text-slate-700 bg-white hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <DocumentArrowDownIcon className="w-4 h-4 mr-2" />
                导出Word
              </button>

              <button
                onClick={() => setShowMultiPanel((v) => !v)}
                disabled={isGenerating || multiProgress.active}
                className="inline-flex items-center px-4 py-2 border border-slate-300 text-sm font-medium rounded-md text-slate-700 bg-slate-50 hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50 disabled:cursor-not-allowed"
                title="一次生成多份不雷同的标书，每份风格不同"
              >
                📑 {showMultiPanel ? '收起' : '多份生成'}
              </button>
            </div>
          </div>
          
          {/* 进度条 */}
          {isGenerating && (
            <div className="mt-4">
              <div className="flex items-center justify-between text-sm text-slate-600 mb-2">
                <span>正在生成: {progress.current}</span>
                <span>{progress.completed} / {progress.total}</span>
              </div>
              <div className="w-full bg-slate-200 rounded-full h-2">
                <div
                  className="bg-primary-600 h-2 rounded-full transition-all duration-300"
                  style={{ width: `${(progress.completed / progress.total) * 100}%` }}
                />
              </div>
            </div>
          )}

          {message && (
            <div className={`mt-4 rounded-md border px-4 py-3 text-sm ${
              message.type === 'success'
                ? 'border-green-200 bg-green-50 text-green-700'
                : 'border-red-200 bg-red-50 text-red-700'
            }`}>
              {message.text}
            </div>
          )}

          {/* 多份生成参数面板 */}
          {showMultiPanel && (
            <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-4">
              <div className="flex items-start justify-between mb-3">
                <div>
                  <h3 className="text-sm font-semibold text-slate-900">多份不雷同标书生成</h3>
                  <p className="text-xs text-slate-700 mt-1">
                    每份采用不同 persona、字体、字号、行距、页边距，并跨份做内容去重。
                    自动追加"响应表型章节"覆盖招标文件第一/三/四/五章硬性要求。
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">短版页数</label>
                  <input
                    type="number"
                    min={1}
                    max={500}
                    value={multiParams.targetPages}
                    onChange={(e) => setMultiParams({ ...multiParams, targetPages: Math.max(1, Number(e.target.value) || 1) })}
                    disabled={multiProgress.active}
                    className="w-full rounded-md border-slate-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 sm:text-sm"
                  />
                  <p className="text-xs text-slate-500 mt-1">前 N-1 份的目标页数（建议 30-50）</p>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">长版页数</label>
                  <input
                    type="number"
                    min={1}
                    max={500}
                    value={multiParams.extendedTargetPages}
                    onChange={(e) => setMultiParams({ ...multiParams, extendedTargetPages: Math.max(1, Number(e.target.value) || 1) })}
                    disabled={multiProgress.active}
                    className="w-full rounded-md border-slate-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 sm:text-sm"
                  />
                  <p className="text-xs text-slate-500 mt-1">最后 1 份的目标页数（建议 50+）</p>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">份数</label>
                  <input
                    type="number"
                    min={2}
                    max={5}
                    value={multiParams.copies}
                    onChange={(e) => setMultiParams({ ...multiParams, copies: Math.max(2, Math.min(5, Number(e.target.value) || 2)) })}
                    disabled={multiProgress.active}
                    className="w-full rounded-md border-slate-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 sm:text-sm"
                  />
                  <p className="text-xs text-slate-500 mt-1">2-5 份，自动轮转 persona</p>
                </div>
                <div className="flex items-end">
                  <button
                    onClick={handleGenerateMultiCopies}
                    disabled={multiProgress.active || isGenerating || leafItems.length === 0}
                    className="w-full inline-flex items-center justify-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {multiProgress.active ? '生成中...' : '🚀 开始生成'}
                  </button>
                </div>
              </div>

              <div className="mt-3">
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  每份使用的模型（逗号分隔，按份轮转；留空则全部用默认模型）
                </label>
                <input
                  type="text"
                  value={multiParams.modelsText}
                  onChange={(e) => setMultiParams({ ...multiParams, modelsText: e.target.value })}
                  disabled={multiProgress.active}
                  placeholder="deepseek-chat, gpt-4o（留空则全部用左侧配置的模型）"
                  className="w-full rounded-md border-slate-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 text-xs font-mono"
                />
                <p className="text-xs text-slate-500 mt-1">
                  不同模型写出的结构和文风天然不同，进一步降低雷同度；模型ID需在当前 API 服务商可用
                </p>
              </div>

              <div className="mt-3 flex items-center justify-between gap-4 flex-wrap">
                <div className="flex items-center">
                  <input
                    type="checkbox"
                    id="inject-response-chapters"
                    checked={multiParams.injectResponseChapters}
                    onChange={(e) => setMultiParams({ ...multiParams, injectResponseChapters: e.target.checked })}
                    disabled={multiProgress.active}
                    className="h-4 w-4 rounded border-slate-300 text-primary-600 focus:ring-primary-500"
                  />
                  <label htmlFor="inject-response-chapters" className="ml-2 text-xs text-slate-700">
                    自动追加响应表型章节 — <strong>建议保持开启</strong>
                  </label>
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-xs text-slate-700">同份并发数</label>
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={multiParams.parallelConcurrency}
                    onChange={(e) => setMultiParams({ ...multiParams, parallelConcurrency: Math.max(1, Math.min(10, Number(e.target.value) || 1)) })}
                    disabled={multiProgress.active}
                    className="w-16 rounded-md border-slate-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 text-xs"
                  />
                  <span className="text-xs text-slate-500">受 LLM 限流约束，建议 2-3</span>
                </div>
              </div>

              {/* 多份进度 */}
              {(multiProgress.active || multiProgress.completedChapters > 0) && (
                <div className="mt-4">
                  <div className="flex items-center justify-between text-xs text-slate-700 mb-1">
                    <span>{multiProgress.currentLabel || '完成'}</span>
                    <span>{multiProgress.completedChapters} / {multiProgress.totalChapters}</span>
                  </div>
                  <div className="w-full bg-slate-200 rounded-full h-1.5">
                    <div
                      className="bg-primary-600 h-1.5 rounded-full transition-all duration-300"
                      style={{
                        width: multiProgress.totalChapters > 0
                          ? `${(multiProgress.completedChapters / multiProgress.totalChapters) * 100}%`
                          : '0%',
                      }}
                    />
                  </div>
                </div>
              )}

              {/* 多份结果列表 */}
              {multiResults.length > 0 && (
                <div className="mt-4 space-y-2">
                  {multiResults.map((copy) => {
                    const isLastCopy = copy.copyIndex === multiParams.copies - 1;
                    // 每份目录结构不同，用该份自己的叶子数判断是否生成完成
                    const realLeafCount = copy.leafCount ?? leafItems.length;
                    const isComplete = copy.chapters.length >= realLeafCount;
                    return (
                      <div
                        key={copy.copyIndex}
                        className="flex items-center justify-between rounded-md border border-slate-200 bg-white px-3 py-2"
                      >
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium text-slate-900">
                            第 {copy.copyIndex + 1} 份
                            {isLastCopy && (
                              <span className="ml-2 inline-block px-2 py-0.5 text-xs bg-amber-100 text-amber-700 rounded">
                                长版（≈{multiParams.extendedTargetPages}页）
                              </span>
                            )}
                            {copy.persona && (
                              <span className="ml-2 inline-block px-2 py-0.5 text-xs bg-slate-100 text-slate-700 rounded">
                                {copy.persona.name}
                              </span>
                            )}
                            {copy.model && (
                              <span className="ml-2 inline-block px-2 py-0.5 text-xs bg-primary-50 text-primary-700 rounded font-mono">
                                {copy.model}
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-slate-500 mt-0.5">
                            {copy.chapters.length} 章 · 共 {copy.totalChars.toLocaleString()} 字 · 约 {Math.round(copy.totalChars / 750)} 页
                          </div>
                        </div>
                        <button
                          onClick={() => handleExportMultiCopy(copy)}
                          disabled={multiProgress.active || exportingCopyIndex !== null || !isComplete}
                          className="ml-3 inline-flex items-center px-3 py-1.5 border border-slate-300 text-xs font-medium rounded-md text-slate-700 bg-white hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          <DocumentArrowDownIcon className="w-3.5 h-3.5 mr-1.5" />
                          {exportingCopyIndex === copy.copyIndex
                            ? '导出中...'
                            : isComplete
                              ? '导出 Word'
                              : `${copy.chapters.length}/${realLeafCount}`}
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 文档内容 */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm">
        <div className="p-8">
          <div className="prose max-w-none">
            {/* 文档标题 */}
            <h1 className="text-3xl font-bold text-slate-900 mb-8">
              {outlineData.project_name || '投标技术文件'}
            </h1>
            
            {/* 项目概述 */}
            {outlineData.project_overview && (
              <div className="bg-primary-50 border-l-4 border-primary-400 p-6 mb-8">
                <h2 className="text-lg font-semibold text-primary-900 mb-2">项目概述</h2>
                <p className="text-primary-800">{outlineData.project_overview}</p>
              </div>
            )}

            {/* 目录结构和内容 */}
            <div className="space-y-8">
              {renderOutline(outlineData.outline)}
            </div>
          </div>
        </div>
      </div>

      {/* 底部统计 */}
      <div className="mt-6 bg-white rounded-xl border border-slate-200 shadow-sm p-4">
        <div className="flex items-center justify-between text-sm text-slate-600">
          <div className="flex items-center space-x-6">
            <div className="flex items-center">
              <CheckCircleIcon className="w-4 h-4 text-green-500 mr-1" />
              <span>已完成: {completedItems}</span>
            </div>
            <div className="flex items-center">
              <DocumentTextIcon className="w-4 h-4 text-slate-400 mr-1" />
              <span>待生成: {leafItems.length - completedItems}</span>
            </div>
            {progress.failed.length > 0 && (
              <div className="flex items-center">
                <ExclamationCircleIcon className="w-4 h-4 text-red-500 mr-1" />
                <span className="text-red-600">失败: {progress.failed.length}</span>
              </div>
            )}
          </div>
          <div>
            <span>总字数: {leafItems.reduce((sum, item) => sum + (item.content?.length || 0), 0)}</span>
          </div>
        </div>
      </div>

      {/* 回到顶部按钮 */}
      {showScrollToTop && (
        <button
          onClick={scrollToTop}
          className="fixed bottom-24 right-6 bg-primary-600 hover:bg-primary-700 text-white rounded-full p-3 shadow-lg transition-all duration-300 hover:shadow-xl focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 z-[60]"
          aria-label="回到顶部"
        >
          <ArrowUpIcon className="w-5 h-5" />
        </button>
      )}
    </div>
  );
};

export default ContentEdit;
