import type { Response } from 'express';

/**
 * SSE 输出的小工具。
 * 统一的事件协议：
 *   {type:'delta', text}   流式文本增量
 *   {type:'final', ...}    最终结构化结果
 *   {type:'error', message}
 */
export class Sse {
  private closed = false;

  constructor(private res: Response) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
  }

  send(obj: unknown): void {
    if (this.closed) return;
    this.res.write(`data: ${JSON.stringify(obj)}\n\n`);
  }

  delta(text: string): void {
    this.send({ type: 'delta', text });
  }

  error(err: unknown): void {
    this.send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    this.end();
  }

  end(): void {
    if (this.closed) return;
    this.closed = true;
    this.res.write('data: [DONE]\n\n');
    this.res.end();
  }

  get isClosed(): boolean {
    return this.closed;
  }
}

/**
 * 把"客户端真正断开"映射成 AbortSignal。
 * 注意：不能监听 req 'close'——在现代 Node 里，请求体被读完后 'close' 就会触发，
 * 即使客户端仍开着连接等待流式响应，这会导致上游请求被过早掐断。
 * 应监听 res 'close'，并仅在响应未正常完成（writableEnded=false）时视为断连。
 */
export function abortOnClose(
  req: { on(ev: 'aborted', cb: () => void): void },
  res: { on(ev: 'close', cb: () => void): void; writableEnded: boolean },
  onAbort: () => void,
): void {
  // 客户端在请求中途断开
  req.on('aborted', onAbort);
  // 连接关闭且响应还没正常写完 => 客户端跑了
  res.on('close', () => {
    if (!res.writableEnded) onAbort();
  });
}
