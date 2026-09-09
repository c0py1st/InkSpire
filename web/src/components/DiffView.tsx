import { memo, useMemo } from 'react';
import { diffChars } from 'diff';

/** 出版校对式 diff：删除=红色划线，新增=绿色下划线。
 * memo + useMemo：字符级 diff 是 O(n·m) 重计算，仅在文本真正变化时重跑。 */
export const DiffView = memo(function DiffView(props: { original: string; next: string }) {
  const parts = useMemo(() => diffChars(props.original, props.next), [props.original, props.next]);
  return (
    <div className="diff">
      {parts.map((p, i) =>
        p.added ? <ins key={i}>{p.value}</ins> : p.removed ? <del key={i}>{p.value}</del> : <span key={i}>{p.value}</span>,
      )}
    </div>
  );
});
