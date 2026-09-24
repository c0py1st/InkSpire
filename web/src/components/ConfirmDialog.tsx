import { useStore } from '../state/store';
import { BuDialog } from './BuDialog';
import { Btn } from './primitives';

/**
 * 全局确认框：由 store.confirmAsk 以 Promise 形式驱动，App 在 confirmReq 存在时挂载。
 * 存在动机：原生 window.confirm 在内嵌 WebView 里不可见且挂死页面事件循环。
 * Escape / 取消都是 false，与原生语义一致。
 */
export function ConfirmDialog() {
  const req = useStore((s) => s.confirmReq);
  const answer = useStore((s) => s.answerConfirm);
  if (!req) return null;
  return (
    <BuDialog open onClose={() => answer(false)} ariaTitle={req.title} size="narrow">
      <div className="m-head">{req.title}</div>
      <div className="m-body" style={{ whiteSpace: 'pre-wrap', fontSize: 13.5 }}>{req.message}</div>
      <div className="m-foot">
        <div className="spacer" />
        <Btn ghost onClick={() => answer(false)}>取消</Btn>
        <Btn primary onClick={() => answer(true)}>{req.okLabel}</Btn>
      </div>
    </BuDialog>
  );
}
