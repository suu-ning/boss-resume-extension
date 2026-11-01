/**
 * 专业技能的条目归一化。
 *
 * 约定是「一行一条」（编辑器下面的提示就是这么写的），但历史档案里存在
 * 「一条里塞了多行」的脏数据（AI 补全、导入时整段落进一个元素）。
 * 这种数据在编辑器里看不出问题（textarea 直接显示换行），
 * 到预览里就露馅：列表按条目渲染，只出一个圆点，内部换行被 HTML 折叠成一整段。
 * 所以读写入口统一按行拆开。
 */
export function splitSkillItems(values: readonly string[] | undefined | null): string[] {
  const result: string[] = [];
  for (const value of values ?? []) {
    for (const line of String(value ?? "").split(/\r?\n/)) {
      const text = line.trim();
      if (text && !result.includes(text)) result.push(text);
    }
  }
  return result;
}
