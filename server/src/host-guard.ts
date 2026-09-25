import type { NextFunction, Request, Response } from 'express';

/**
 * Host 白名单守卫：服务端只监听 127.0.0.1，但浏览器遭受 DNS rebinding 时
 * （恶意域名解析到 127.0.0.1）请求会变成"同源"打到本机 API 上，
 * 书稿与设置便可被任意网页读取。校验 Host 头是这类攻击的标准拦法。
 */
export function isAllowedHost(header: string | undefined, port: number): boolean {
  if (!header) return false;
  const h = header.trim().toLowerCase();
  return h === `127.0.0.1:${port}` || h === `localhost:${port}` || h === `[::1]:${port}`;
}

export function hostGuard(port: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!isAllowedHost(req.headers.host, port)) {
      res.status(403).json({ error: '非法 Host：本服务仅接受本机请求' });
      return;
    }
    next();
  };
}
