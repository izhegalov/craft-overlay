import { parentPort } from 'node:worker_threads';
import type { Settings } from './store';
import { baseAdvice, checkItem } from './targets';

// Симуляция занимает секунды: в отдельном потоке она не держит окна и хоткеи.
parentPort?.once(
  'message',
  ({ text, baseId, settings }: { text?: string; baseId?: string; settings: Settings }) => {
    parentPort?.postMessage(
      baseId === undefined ? checkItem(text ?? '', settings) : baseAdvice(baseId, settings),
    );
  },
);
