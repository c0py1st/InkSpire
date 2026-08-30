import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
// 本地打包的霞鹜文楷屏幕版：按 unicode-range 子集加载，不依赖 CDN，保证正文字体统一
import 'lxgw-wenkai-screen-webfont/style.css';
import './styles/global.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
