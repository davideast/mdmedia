export type Limiter = <T>(task: () => Promise<T>) => Promise<T>;

/** Runs at most `size` tasks at once, in the order they ask. */
export function limiter(size: number): Limiter {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async (task) => {
    if (active >= size) await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
    try {
      return await task();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}
