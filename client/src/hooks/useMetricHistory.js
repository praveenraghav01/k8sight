import { useEffect, useState } from 'react';
import axios from 'axios';

export const METRIC_HISTORY_PERIODS = [
  { value: '15m', label: '15m' },
  { value: '1h', label: '1h' },
  { value: '6h', label: '6h' },
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' }
];

const emptyHistory = { available: null, points: [], message: null, source: null };

export default function useMetricHistory({ kind, namespace, name, enabled }) {
  const [period, setPeriod] = useState('1h');
  const [history, setHistory] = useState(emptyHistory);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!enabled || !name || (kind === 'pod' && !namespace)) {
      setLoading(false);
      setHistory(emptyHistory);
      return undefined;
    }

    const controller = new AbortController();
    const path = kind === 'pod'
      ? `/api/metrics/history/pod/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`
      : `/api/metrics/history/node/${encodeURIComponent(name)}`;
    setLoading(true);
    setHistory(emptyHistory);
    axios.get(path, { params: { period }, signal: controller.signal })
      .then(({ data }) => {
        if (!controller.signal.aborted) setHistory(data || emptyHistory);
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setHistory({
          ...emptyHistory,
          available: false,
          message: error.response?.data?.message || 'Unable to load metric history.'
        });
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [enabled, kind, namespace, name, period]);

  return { ...history, period, setPeriod, loading };
}
