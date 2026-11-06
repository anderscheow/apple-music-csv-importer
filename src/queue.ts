/** Process a bounded number of items at once. A stop request lets in-flight items finish. */
export async function runQueue<T>(items: readonly T[], concurrency: number, shouldStop: () => boolean, process: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (!shouldStop() && next < items.length) {
      const item = items[next++];
      await process(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}
