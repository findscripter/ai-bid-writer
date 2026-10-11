/**
 * 把 src/brand 里的 React 组件渲染成静态 SVG 文件：
 * - ../docs/brand/hero-light.svg、hero-dark.svg：README 顶部的动画（SVG 里的 CSS 动画在 GitHub 上能直接播放）
 * - ../docs/brand/hero-compact-light.svg、hero-compact-dark.svg：同一个动画的窄屏版（手机上看 README）
 * - ../docs/brand/logo.svg：标志
 * - public/favicon.svg：浏览器标签页图标
 *
 * 应用里用的是同一份组件，改了 src/brand 之后在 frontend 目录下运行：node scripts/render-brand.js
 */
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const frontend = path.resolve(__dirname, '..');
const srcDir = path.join(frontend, 'src', 'brand');
// 转译结果放在 node_modules 下面，require 时才找得到 react 等依赖
const outDir = path.join(frontend, 'node_modules', '.cache', 'render-brand');
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

for (const file of fs.readdirSync(srcDir)) {
  if (!/\.tsx?$/.test(file) || /\.test\.tsx?$/.test(file)) continue;
  const source = fs.readFileSync(path.join(srcDir, file), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2019,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
    fileName: file,
  });
  fs.writeFileSync(path.join(outDir, file.replace(/\.tsx?$/, '.js')), outputText);
}

const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const brand = require(path.join(outDir, 'BrandArt.js'));

function write(target, element) {
  const markup = renderToStaticMarkup(element);
  if (!markup.startsWith('<svg') || markup.indexOf('xmlns="http://www.w3.org/2000/svg"') < 0) {
    throw new Error(`${target}：组件必须渲染成带 xmlns 的 <svg>`);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `<?xml version="1.0" encoding="UTF-8"?>\n${markup}\n`);
  console.log(`${path.relative(path.dirname(frontend), target)}  ${(markup.length / 1024).toFixed(1)} KB`);
}

const docs = path.join(frontend, '..', 'docs', 'brand');
write(path.join(docs, 'hero-light.svg'), React.createElement(brand.BrandHero, { theme: 'light' }));
write(path.join(docs, 'hero-dark.svg'), React.createElement(brand.BrandHero, { theme: 'dark' }));
write(path.join(docs, 'hero-compact-light.svg'), React.createElement(brand.BrandHero, { theme: 'light', compact: true }));
write(path.join(docs, 'hero-compact-dark.svg'), React.createElement(brand.BrandHero, { theme: 'dark', compact: true }));
write(path.join(docs, 'logo.svg'), React.createElement(brand.LogoMark, { size: 256, title: 'AI写标书助手' }));
write(path.join(frontend, 'public', 'favicon.svg'), React.createElement(brand.LogoMark, { size: 64, title: 'AI写标书助手' }));

fs.rmSync(outDir, { recursive: true, force: true });
