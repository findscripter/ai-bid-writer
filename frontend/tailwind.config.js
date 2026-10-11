/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./src/**/*.{js,jsx,ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // 单一强调色（钴蓝）：只用在主要操作和当前状态上
        primary: {
          50: '#EEF4FF',
          100: '#DCE7FF',
          200: '#BDD1FF',
          300: '#90B0FF',
          400: '#5E87FA',
          500: '#3B66F0',
          600: '#2750DB',
          700: '#1F3FB4',
          800: '#1D378F',
          900: '#1C3272',
        },
        // 文字色阶：900 正文 / 700 次级标题 / 600 说明 / 500 辅助 / 400 占位 / 300 禁用
        ink: {
          900: '#14171F',
          700: '#343B4A',
          600: '#4A5263',
          500: '#69728A',
          400: '#8E96A8',
          300: '#B4BAC8',
        },
        // 边框：层次主要靠细边框而不是阴影
        line: {
          DEFAULT: '#E3E6EC',
          strong: '#CBD0DA',
        },
        // 画布（页面底色）与弱底色（表头、悬停、禁用态）
        canvas: '#F4F5F8',
        subtle: '#F8F9FB',
      },
      fontFamily: {
        sans: [
          '"PingFang SC"',
          '"Microsoft YaHei UI"',
          '"Microsoft YaHei"',
          '"Noto Sans SC"',
          'system-ui',
          'sans-serif',
        ],
        mono: ['"JetBrains Mono"', 'Consolas', 'monospace'],
      },
      fontSize: {
        // 文稿正文：15px、行高 1.9（text-doc）；界面基准仍是 text-sm = 14px
        doc: ['15px', { lineHeight: '1.9' }],
        '2xs': ['11px', { lineHeight: '16px' }],
      },
      boxShadow: {
        card: '0 1px 2px rgba(16,24,40,0.04)',
        pop: '0 8px 24px rgba(16,24,40,0.12)',
      },
      keyframes: {
        // 状态点「写作中」的呼吸光环
        breathe: {
          '0%': { transform: 'scale(1)', opacity: '0.55' },
          '70%, 100%': { transform: 'scale(2.6)', opacity: '0' },
        },
        // 流式输出时的文末光标
        'caret-blink': {
          '0%, 55%': { opacity: '1' },
          '56%, 100%': { opacity: '0' },
        },
        // 不确定进度条
        indeterminate: {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(350%)' },
        },
        'toast-in': {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        breathe: 'breathe 1.8s cubic-bezier(0, 0, 0.2, 1) infinite',
        'caret-blink': 'caret-blink 1.1s steps(1, end) infinite',
        indeterminate: 'indeterminate 1.4s ease-in-out infinite',
        'toast-in': 'toast-in 0.18s ease-out',
      },
    },
  },
  plugins: [
    require('@tailwindcss/forms'),
    require('@tailwindcss/typography'),
  ],
}
