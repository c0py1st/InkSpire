import { Dialog } from '@base-ui-components/react/dialog';
import type { DialogRootChangeEventReason } from '@base-ui-components/react/dialog';
import type { ReactNode } from 'react';

/** Base UI 关闭来源的字面量联合（非 string 假别名），消费端按来源精确比较 */
export type BuCloseReason = DialogRootChangeEventReason;

/**
 * Base UI Dialog 封装：
 * - 开关状态由调用方（zustand / 局部 state）受控传入，组件不持有内部 state
 * - Escape 关闭、焦点圈定、ARIA、滚动锁定由 Base UI 负责
 * - 视觉复用现有 .modal / .modal.narrow / .modal.settings-modal 体系
 * - 进出场过渡通过 data-starting-style / data-closed 属性挂在 bu- 类上
 */
export function BuDialog(props: {
  open: boolean;
  /** 统一关闭入口。reason: 'escape-key' | 'outside-press' | 'close-press' | …，可按来源决定是否真的关闭 */
  onClose: (reason: BuCloseReason) => void;
  /** 无障碍标题（sr-only，不影响视觉） */
  ariaTitle: string;
  /** 尺寸：default=860px narrow=560px wide=960px */
  size?: 'default' | 'narrow' | 'wide';
  /** 是否允许点击遮罩关闭（默认否，与旧版多数弹窗一致） */
  closeOnOutsidePress?: boolean;
  children: ReactNode;
}) {
  const sizeClass = props.size === 'narrow' ? 'modal narrow' : props.size === 'wide' ? 'modal settings-modal' : 'modal';
  return (
    <Dialog.Root
      open={props.open}
      onOpenChange={(open, details) => {
        if (!open) props.onClose(details.reason);
      }}
      disablePointerDismissal={!props.closeOnOutsidePress}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="bu-backdrop" />
        <Dialog.Popup className={`bu-popup ${sizeClass}`}>
          <Dialog.Title className="sr-only">{props.ariaTitle}</Dialog.Title>
          {props.children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
