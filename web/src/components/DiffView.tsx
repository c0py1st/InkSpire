import { diffChars } from 'diff';

/** 出版校对式 diff：删除=红色划线，新增=绿色下划线 */
export function DiffView(props: { original: string; next: string }) {
  const parts = diffChars(props.original, props.next);
  return (
    <div className="diff">
      {parts.map((p, i) =>
        p.added ? <ins key={i}>{p.value}</ins> : p.removed ? <del key={i}>{p.value}</del> : <span key={i}>{p.value}</span>,
      )}
    </div>
  );
}
