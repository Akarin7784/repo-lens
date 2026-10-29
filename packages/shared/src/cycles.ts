/** Tarjan 强连通分量(迭代实现,避免大仓库递归爆栈) */
export function findCycles(nodes: string[], adj: Map<string, Set<string>>): string[][] {
  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];
  for (const start of nodes) {
    if (idx.has(start)) continue;
    const work: Array<{ v: string; it: Iterator<string> }> = [];
    const visit = (v: string) => {
      idx.set(v, index);
      low.set(v, index++);
      stack.push(v);
      onStack.add(v);
      work.push({ v, it: (adj.get(v) ?? new Set<string>()).values() });
    };
    visit(start);
    while (work.length) {
      const top = work[work.length - 1]!;
      const nx = top.it.next();
      if (!nx.done) {
        const w = nx.value;
        if (!idx.has(w)) visit(w);
        else if (onStack.has(w)) low.set(top.v, Math.min(low.get(top.v)!, idx.get(w)!));
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.v, Math.min(low.get(parent.v)!, low.get(top.v)!));
      if (low.get(top.v) === idx.get(top.v)) {
        const comp: string[] = [];
        let w: string;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          comp.push(w);
        } while (w !== top.v);
        if (comp.length > 1 || adj.get(top.v)?.has(top.v)) out.push(comp.sort());
      }
    }
  }
  return out.sort((a, b) => (a[0]! < b[0]! ? -1 : 1));
}
