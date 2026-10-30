export class Emitter<Events extends Record<string, unknown[]>> {
  private map = new Map<keyof Events, Set<(...args: any[]) => void>>();

  on<K extends keyof Events>(ev: K, fn: (...args: Events[K]) => void): () => void {
    let s = this.map.get(ev);
    if (!s) this.map.set(ev, (s = new Set()));
    s.add(fn);
    return () => s!.delete(fn);
  }

  emit<K extends keyof Events>(ev: K, ...args: Events[K]): void {
    const s = this.map.get(ev);
    if (!s) return;
    for (const fn of [...s]) {
      try { fn(...args); } catch (e) { console.error(e); }
    }
  }

  clear(): void { this.map.clear(); }
}
