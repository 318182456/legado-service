import { useCallback, useEffect, useRef, useState } from 'react';

/** 列表只接受最后一次请求；切换条件或卸载时取消旧请求。 */
export function useLatestRequest() {
  const active = useRef<AbortController | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const invalidate = useCallback(() => {
    active.current?.abort();
    active.current = null;
  }, []);
  useEffect(() => invalidate, [invalidate]);

  const run = useCallback(async <T,>(load: (signal: AbortSignal) => Promise<T>, apply: (data: T) => void) => {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setLoading(true);
    setError('');
    try {
      const data = await load(controller.signal);
      if (active.current !== controller || controller.signal.aborted) return;
      apply(data);
    } catch (e) {
      if (active.current === controller && !controller.signal.aborted) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (active.current === controller) setLoading(false);
    }
  }, []);
  return { loading, error, run, invalidate };
}
