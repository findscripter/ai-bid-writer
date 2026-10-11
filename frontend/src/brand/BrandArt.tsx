/**
 * 品牌图形：标志、标志动画、README 顶部的动画横幅。
 *
 * 标志：几层错开叠放的页面（分章撰写、合成全书），最前面一页是缩进的三级目录，右下角盖一枚方印（标书要盖章）。
 * 动画：页面依次叠上来 → 目录逐行写出 → 各章陆续写满 → 审校扫过 → 盖章，循环播放。
 *
 * 这里的组件只依赖 React，不用 Tailwind 类名，样式写在 SVG 自带的 <style> 里：
 * 同一份组件既在应用里渲染，也由 scripts/render-brand.js 渲染成静态 SVG 文件
 * （docs/brand/*.svg、public/favicon.svg）。SVG 里的 CSS 动画在 GitHub 的 README 里能直接播放。
 * 动画用的类名都带 aibw- 前缀，内嵌到页面里时不会和别的样式冲突；
 * 系统设置了“减少动态效果”时不播放，直接显示最终画面。
 */
import React from 'react';

export const BRAND = {
  blue: '#2750DB',
  blueBright: '#3B66F0',
  blueDeep: '#1F3FB4',
  blue400: '#5E87FA',
  blue300: '#90B0FF',
  blue100: '#DCE7FF',
  seal: '#D64541',
};

const SVG_NS = 'http://www.w3.org/2000/svg';

/** 一轮动画的时长（秒）。所有部件共用这一个周期，关键帧里的百分比就是在这一轮里的时刻 */
const CYCLE = 10;

/**
 * 一轮的结构：先展示成品，淡出后重新组装一遍，最后停在成品上，再接下一轮。
 * 这样第 0 帧就是完整的画面：不播放动画的查看器、只取第一帧的缩略图看到的都是成品。
 */
const SHOW_UNTIL = 7;
/** 淡出之后，各部件在这一刻回到起始状态（此时整体透明，看不到跳变） */
const RESET_AT = 10;
/** 组装过程在一轮里占的区间 */
const BUILD = [12, 88];

/** 组装进度（0~100）换算成这一轮里的百分比 */
function at(progress: number): number {
  return Math.round((BUILD[0] + ((BUILD[1] - BUILD[0]) * progress) / 100) * 100) / 100;
}

/** 组装过程的时间表（组装进度 0~100）。动画由它生成，改节奏只改这里 */
const T = {
  tile: [0, 6],
  pages: [
    [6, 14],
    [11, 19],
    [16, 24],
  ],
  rows: [
    [27, 33],
    [32, 38],
    [37, 43],
    [42, 48],
  ],
  chapters: [53, 78],
  scan: [80, 89],
  seal: [90, 96],
  ripple: [95, 100],
  /** 各阶段亮起的时刻：招标解读、目录、写作计划、正文、审校、导出 */
  stages: [6, 27, 40, 53, 80, 90],
};

/**
 * 关键帧：开头保持成品（end）；回到起始状态（start）后，在组装进度 [from, to] 之间过渡到 end，之后一直保持。
 * mid 是过渡途中的一个关键帧（组装进度、样式），用来做弹跳。
 */
function frames(name: string, from: number, to: number, start: string, end: string, mid?: [number, string]): string {
  const stops = [`0%,${RESET_AT - 0.2}%{${end}}`, `${RESET_AT}%,${at(from)}%{${start}}`];
  if (mid) stops.push(`${at(mid[0])}%{${mid[1]}}`);
  stops.push(`${at(to)}%,100%{${end}}`);
  return `@keyframes ${name}{${stops.join('')}}`;
}

function animate(selector: string, name: string, extra = ''): string {
  return `${selector}{animation:${name} ${CYCLE}s ease-in-out infinite both;${extra}}`;
}

// ---------------------------------------------------------------------------
// 标志
// ---------------------------------------------------------------------------

const PAGES = [
  { x: 26, y: 10, fill: BRAND.blue300 },
  { x: 21, y: 14.5, fill: BRAND.blue100 },
];
/** 最前面一页上的目录行：一级、二级、三级、三级（按缩进体现层级） */
const ROWS = [
  { x: 18.5, y: 24.5, w: 15, h: 3.4, fill: BRAND.blueDeep },
  { x: 21.5, y: 31, w: 13.5, h: 3, fill: BRAND.blue400 },
  { x: 24.5, y: 37, w: 10, h: 3, fill: BRAND.blue300 },
  { x: 24.5, y: 43, w: 6.5, h: 3, fill: BRAND.blue300 },
];

/** 标志的各个部件。animated 时每个部件带上动画用的类名 */
function MarkShapes({ animated = false }: { animated?: boolean }) {
  const cls = (name: string) => (animated ? `aibw-${name}` : undefined);
  return (
    <>
      <rect className={cls('tile')} width="64" height="64" rx="14" fill={BRAND.blue} />
      {PAGES.map((page, index) => (
        <rect key={index} className={cls(`page${index}`)} x={page.x} y={page.y} width="24" height="32" rx="3.5" fill={page.fill} />
      ))}
      <rect className={cls('page2')} x="14" y="19" width="26" height="34" rx="3.5" fill="#FFFFFF" />
      {ROWS.map((row, index) => (
        <rect key={index} className={cls(`row${index}`)} x={row.x} y={row.y} width={row.w} height={row.h} rx={row.h / 2} fill={row.fill} />
      ))}
      {/* 方印：外层 g 负责倾斜，里层 g 负责动画（CSS 的 transform 会覆盖元素自己的 transform 属性，所以分开） */}
      <g transform="rotate(-8 38 47.5)">
        {animated && (
          <rect className="aibw-ripple" x="32.5" y="42" width="11" height="11" rx="2.5" fill="none" stroke={BRAND.seal} strokeWidth="1.2" opacity="0" />
        )}
        <g className={cls('seal')}>
          <rect x="32.5" y="42" width="11" height="11" rx="2" fill={BRAND.seal} />
          <rect x="34.3" y="43.8" width="7.4" height="7.4" rx="1" fill="none" stroke="#FFFFFF" strokeWidth="1.1" />
        </g>
      </g>
    </>
  );
}

/** 标志动画的关键帧（不含整体淡出，由外层决定） */
function markCss(): string {
  const parts: string[] = [];
  const pop = 'opacity:0;transform:scale(.86)';
  const shown = 'opacity:1;transform:none';
  parts.push(frames('aibw-k-tile', T.tile[0], T.tile[1], pop, shown));
  parts.push(animate('.aibw-tile', 'aibw-k-tile', 'transform-box:fill-box;transform-origin:center'));
  T.pages.forEach(([from, to], index) => {
    parts.push(frames(`aibw-k-page${index}`, from, to, 'opacity:0;transform:translate(-5px,6px)', shown));
    parts.push(animate(`.aibw-page${index}`, `aibw-k-page${index}`));
  });
  T.rows.forEach(([from, to], index) => {
    parts.push(frames(`aibw-k-row${index}`, from, to, 'transform:scaleX(0)', 'transform:scaleX(1)'));
    parts.push(animate(`.aibw-row${index}`, `aibw-k-row${index}`, 'transform-box:fill-box;transform-origin:left center'));
  });
  parts.push(
    frames('aibw-k-seal', T.seal[0], T.seal[1], 'opacity:0;transform:scale(1.9) rotate(-18deg)', shown, [
      T.seal[0] + 3,
      'opacity:1;transform:scale(.9) rotate(0)',
    ])
  );
  parts.push(animate('.aibw-seal', 'aibw-k-seal', 'transform-box:fill-box;transform-origin:center'));
  parts.push(
    `@keyframes aibw-k-ripple{0%,${at(T.ripple[0])}%{opacity:0;transform:scale(1)}${at(T.ripple[0] + 1)}%{opacity:.55;transform:scale(1)}${at(T.ripple[1])}%,100%{opacity:0;transform:scale(2.1)}}`
  );
  parts.push(animate('.aibw-ripple', 'aibw-k-ripple', 'transform-box:fill-box;transform-origin:center'));
  return parts.join('');
}

function fadeCss(): string {
  return (
    `@keyframes aibw-k-fade{0%,${SHOW_UNTIL}%{opacity:1}${RESET_AT - 0.6}%,${RESET_AT + 0.4}%{opacity:0}${BUILD[0]}%,100%{opacity:1}}` +
    animate('.aibw-fade', 'aibw-k-fade')
  );
}

/** 不想看动画的人：直接显示最终画面 */
const REDUCED_MOTION =
  '@media (prefers-reduced-motion:reduce){.aibw-anim,.aibw-anim *{animation:none!important}.aibw-ripple,.aibw-scan{opacity:0}}';

interface LogoMarkProps {
  /** 像素尺寸（正方形） */
  size?: number;
  /** 有 title 时作为图片朗读；不给时对读屏软件隐藏（旁边通常已经有产品名） */
  title?: string;
  className?: string;
}

/** 标志（静态） */
export function LogoMark({ size = 28, title, className }: LogoMarkProps) {
  return (
    <svg
      xmlns={SVG_NS}
      viewBox="0 0 64 64"
      width={size}
      height={size}
      className={className}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      {title && <title>{title}</title>}
      <MarkShapes />
    </svg>
  );
}

interface AnimatedLogoProps {
  size?: number;
  className?: string;
  /** 循环播放；默认只从组装开始播一遍，最后停在成品上（放在界面里不一直动） */
  loop?: boolean;
}

/** 标志动画：页面叠上来、目录写出、盖章 */
export function AnimatedLogo({ size = 72, className, loop = false }: AnimatedLogoProps) {
  // 所有部件同样往前拨到“回到起始状态”的那一刻，彼此仍然同步。
  // 规则挂在这个实例的类名上，并且比各部件的动画规则更具体：同一页面里有循环和不循环的两个实例时互不影响
  const mode = loop ? 'aibw-loop' : 'aibw-once';
  const start = `svg.${mode} .aibw-anim,svg.${mode} .aibw-anim *{animation-delay:-${(CYCLE * RESET_AT) / 100}s${loop ? '' : ';animation-iteration-count:1'}}`;
  return (
    <svg
      xmlns={SVG_NS}
      viewBox="0 0 64 64"
      width={size}
      height={size}
      className={className ? `${mode} ${className}` : mode}
      aria-hidden="true"
    >
      <style>{markCss() + fadeCss() + start + REDUCED_MOTION}</style>
      <g className="aibw-anim aibw-fade">
        <MarkShapes animated />
      </g>
    </svg>
  );
}

// ---------------------------------------------------------------------------
// README 顶部的动画横幅
// ---------------------------------------------------------------------------

const THEMES = {
  light: {
    card: '#FFFFFF',
    border: '#E3E6EC',
    text: '#14171F',
    muted: '#69728A',
    track: '#E3E6EC',
    /** 还没轮到的阶段节点：对白底约 3:1，仍然看得出来 */
    idle: '#8E96A8',
    active: BRAND.blue,
    chapterA: BRAND.blue300,
    chapterB: BRAND.blue400,
    scan: 'rgba(39,80,219,0.10)',
  },
  dark: {
    card: '#151B23',
    border: '#30363D',
    text: '#E6EDF3',
    muted: '#8D96A0',
    track: '#262C36',
    idle: '#6E7681',
    active: BRAND.blue400,
    chapterA: BRAND.blueBright,
    chapterB: BRAND.blue400,
    scan: 'rgba(144,176,255,0.12)',
  },
};

export type BrandTheme = keyof typeof THEMES;

const STAGES = ['招标解读', '目录', '写作计划', '正文', '审校', '导出'];
const FONT = '"PingFang SC","Microsoft YaHei","Noto Sans SC","Source Han Sans SC",system-ui,sans-serif';
const TITLE = '先定全书口径，再分章撰写，写完回看';
const SUBTITLE = '从招标文件到十几万字的技术标：解析、规划、撰写、审校，最后导出 Word';
const SCAN_WIDTH = 34;
const WAVES = 10;

interface HeroLayout {
  width: number;
  height: number;
  mark: { x: number; y: number; scale: number };
  title: { x: number; y: number; size: number; anchor: 'start' | 'middle' };
  /** 副标题；窄屏版不放 */
  subtitle: { x: number; y: number; size: number } | null;
  stages: { x0: number; x1: number; y: number };
  grid: { x: number; y: number; cols: number; rows: number; w: number; h: number; gapX: number; gapY: number };
}

/**
 * 两种版式：宽版放在电脑上看；窄版竖着排、字相对更大，手机上（README 被缩到屏幕宽）也看得清。
 * 宽版里标题与第一个阶段名称的左缘对齐（阶段名称以节点为中心，四个字约 56px 宽）。
 */
const LAYOUTS: Record<'wide' | 'compact', HeroLayout> = {
  wide: {
    width: 960,
    height: 300,
    mark: { x: 64, y: 54, scale: 3 },
    title: { x: 344, y: 92, size: 26, anchor: 'start' },
    subtitle: { x: 344, y: 124, size: 15 },
    stages: { x0: 372, x1: 892, y: 168 },
    grid: { x: 372, y: 222, cols: 20, rows: 2, w: 20, h: 9, gapX: 6.4, gapY: 8 },
  },
  compact: {
    width: 480,
    height: 372,
    mark: { x: 184, y: 30, scale: 1.75 },
    title: { x: 240, y: 178, size: 22, anchor: 'middle' },
    subtitle: null,
    stages: { x0: 60, x1: 420, y: 226 },
    grid: { x: 69.5, y: 296, cols: 12, rows: 2, w: 22, h: 9, gapX: 7, gapY: 8 },
  },
};

function gridWidth(layout: HeroLayout): number {
  const g = layout.grid;
  return g.cols * (g.w + g.gapX) - g.gapX;
}

/** 各章写满的顺序：固定的伪随机，看起来像多章同时在写 */
function chapterWave(index: number, cols: number): number {
  return (index * 7 + Math.floor(index / cols) * 3) % WAVES;
}

function heroCss(theme: BrandTheme, layout: HeroLayout): string {
  const c = THEMES[theme];
  const parts: string[] = [markCss(), fadeCss()];

  // 阶段：节点和文字依次亮起；进度线按阶段推进
  T.stages.forEach((when, index) => {
    parts.push(
      frames(`aibw-k-node${index}`, when, when + 3, `fill:${c.idle};transform:scale(.7)`, `fill:${c.active};transform:none`, [
        when + 1.5,
        `fill:${c.active};transform:scale(1.35)`,
      ])
    );
    parts.push(animate(`.aibw-node${index}`, `aibw-k-node${index}`, 'transform-box:fill-box;transform-origin:center'));
    parts.push(frames(`aibw-k-label${index}`, when, when + 3, `fill:${c.muted}`, `fill:${c.text}`));
    parts.push(animate(`.aibw-label${index}`, `aibw-k-label${index}`));
  });
  const last = T.stages.length - 1;
  const progress = T.stages.map((when, index) => `${at(when)}%{transform:scaleX(${(index / last).toFixed(3)})}`);
  parts.push(
    `@keyframes aibw-k-progress{0%,${RESET_AT - 0.2}%{transform:scaleX(1)}${RESET_AT}%{transform:scaleX(0)}${progress.join('')}100%{transform:scaleX(1)}}`
  );
  parts.push(animate('.aibw-progress', 'aibw-k-progress', 'transform-box:fill-box;transform-origin:left center'));

  // 正文：各章分几波写满
  const [from, to] = T.chapters;
  const step = (to - from) / WAVES;
  for (let wave = 0; wave < WAVES; wave++) {
    const start = from + wave * step;
    parts.push(frames(`aibw-k-ch${wave}`, start, start + step * 1.6, 'transform:scaleX(0)', 'transform:scaleX(1)'));
    parts.push(animate(`.aibw-ch${wave}`, `aibw-k-ch${wave}`, 'transform-box:fill-box;transform-origin:left center'));
  }

  // 审校：一道光从左到右扫过全部章节（只在网格范围内移动）
  const sweep = gridWidth(layout) - SCAN_WIDTH;
  parts.push(
    `@keyframes aibw-k-scan{0%,${at(T.scan[0])}%{opacity:0;transform:translateX(0)}${at(T.scan[0] + 1)}%{opacity:1}${at(T.scan[1] - 1)}%{opacity:1}${at(T.scan[1])}%,100%{opacity:0;transform:translateX(${sweep}px)}}`
  );
  parts.push(animate('.aibw-scan', 'aibw-k-scan'));

  parts.push(REDUCED_MOTION);
  return parts.join('');
}

interface BrandHeroProps {
  theme?: BrandTheme;
  /** 窄屏版：竖着排，去掉副标题 */
  compact?: boolean;
}

/** README 顶部的动画横幅：标志的组装过程，加上六个阶段依次推进、各章陆续写满 */
export function BrandHero({ theme = 'light', compact = false }: BrandHeroProps) {
  const c = THEMES[theme];
  const layout = LAYOUTS[compact ? 'compact' : 'wide'];
  const { stages: row, grid } = layout;
  const gap = (row.x1 - row.x0) / (STAGES.length - 1);
  const chapters: Array<{ x: number; y: number; wave: number; fill: string }> = [];
  for (let r = 0; r < grid.rows; r++) {
    for (let col = 0; col < grid.cols; col++) {
      const index = r * grid.cols + col;
      chapters.push({
        x: grid.x + col * (grid.w + grid.gapX),
        y: grid.y + r * (grid.h + grid.gapY),
        wave: chapterWave(index, grid.cols),
        fill: (col + r) % 3 === 0 ? c.chapterB : c.chapterA,
      });
    }
  }
  return (
    <svg
      xmlns={SVG_NS}
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      width={layout.width}
      height={layout.height}
      role="img"
      aria-label="AI写标书助手：招标解读、目录、写作计划、正文、审校、导出"
    >
      <title>AI写标书助手</title>
      <style>{heroCss(theme, layout)}</style>
      <rect x="0.5" y="0.5" width={layout.width - 1} height={layout.height - 1} rx="20" fill={c.card} stroke={c.border} />

      <text
        x={layout.title.x}
        y={layout.title.y}
        textAnchor={layout.title.anchor}
        fontFamily={FONT}
        fontSize={layout.title.size}
        fontWeight="600"
        fill={c.text}
      >
        {TITLE}
      </text>
      {layout.subtitle && (
        <text x={layout.subtitle.x} y={layout.subtitle.y} fontFamily={FONT} fontSize={layout.subtitle.size} fill={c.muted}>
          {SUBTITLE}
        </text>
      )}

      <g className="aibw-anim aibw-fade">
        <g transform={`translate(${layout.mark.x} ${layout.mark.y}) scale(${layout.mark.scale})`}>
          <MarkShapes animated />
        </g>

        {/* 六个阶段 */}
        <rect x={row.x0} y={row.y - 1.5} width={row.x1 - row.x0} height="3" rx="1.5" fill={c.track} />
        <rect className="aibw-progress" x={row.x0} y={row.y - 1.5} width={row.x1 - row.x0} height="3" rx="1.5" fill={c.active} />
        {STAGES.map((label, index) => {
          const x = row.x0 + index * gap;
          return (
            <g key={label}>
              <circle cx={x} cy={row.y} r="9" fill={c.card} />
              <circle className={`aibw-node${index}`} cx={x} cy={row.y} r="6.5" fill={c.active} />
              <text className={`aibw-label${index}`} x={x} y={row.y + 30} textAnchor="middle" fontFamily={FONT} fontSize="14" fill={c.text}>
                {label}
              </text>
            </g>
          );
        })}

        {/* 各章：先画轨道，再画会写满的部分 */}
        {chapters.map((ch, index) => (
          <rect key={`t${index}`} x={ch.x} y={ch.y} width={grid.w} height={grid.h} rx="3" fill={c.track} />
        ))}
        {chapters.map((ch, index) => (
          <rect key={`c${index}`} className={`aibw-ch${ch.wave}`} x={ch.x} y={ch.y} width={grid.w} height={grid.h} rx="3" fill={ch.fill} />
        ))}
        {/* 审校的扫描光带：默认不显示，只在动画里出现 */}
        <rect
          className="aibw-scan"
          x={grid.x}
          y={grid.y - 6}
          width={SCAN_WIDTH}
          height={grid.rows * (grid.h + grid.gapY) + 4}
          rx="4"
          fill={c.scan}
          opacity="0"
        />
      </g>
    </svg>
  );
}
