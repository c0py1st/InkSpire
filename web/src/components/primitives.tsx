import type { CSSProperties, ReactNode } from 'react';

export function Btn(props: {
  children: ReactNode;
  onClick?: () => void;
  primary?: boolean;
  ghost?: boolean;
  danger?: boolean;
  small?: boolean;
  disabled?: boolean;
  title?: string;
  style?: CSSProperties;
}) {
  const cls = ['btn', props.primary && 'primary', props.ghost && 'ghost', props.danger && 'danger', props.small && 'small']
    .filter(Boolean)
    .join(' ');
  return (
    <button className={cls} onClick={props.onClick} disabled={props.disabled} title={props.title} style={props.style}>
      {props.children}
    </button>
  );
}

export function Field(props: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div className="field">
      <label>{props.label}{props.hint ? <span style={{ fontWeight: 400, marginLeft: 6 }}>{props.hint}</span> : null}</label>
      {props.children}
    </div>
  );
}
