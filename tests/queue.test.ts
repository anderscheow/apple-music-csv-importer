import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runQueue } from '../src/queue.ts';

test('pause finishes in-flight searches and resume processes each remaining song once', async () => {
  const started: number[] = [];
  const finished: number[] = [];
  let paused = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const work = runQueue([0, 1, 2, 3, 4, 5], 3, () => paused, async (index) => {
    started.push(index);
    await gate;
    finished.push(index);
  });
  assert.deepEqual(started, [0, 1, 2]);
  paused = true;
  release();
  await work;
  assert.deepEqual(finished, [0, 1, 2]);
  const remaining = [0, 1, 2, 3, 4, 5].filter((index) => !finished.includes(index));
  await runQueue(remaining, 3, () => false, async (index) => { finished.push(index); });
  assert.deepEqual(finished.sort(), [0, 1, 2, 3, 4, 5]);
});
