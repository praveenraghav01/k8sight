import React from 'react';
import { METRIC_HISTORY_PERIODS } from '../hooks/useMetricHistory';

export default function MetricHistoryControls({ period, onChange, loading, available, message, source, pointCount = 0 }) {
  const status = loading
    ? 'Loading history…'
    : available === false
      ? `${message || 'Historical data requires a reachable Prometheus.'} The chart shows this session only.`
      : available === true
        ? message || `${pointCount} samples${pointCount && source ? ` · ${source}` : ''}`
        : null;

  return (
    <div className="metric-history-controls">
      <span className="metric-history-label">Period</span>
      <div className="metric-history-options" role="group" aria-label="Metric history period">
        {METRIC_HISTORY_PERIODS.map((option) => (
          <button
            key={option.value}
            type="button"
            className={`metric-history-option${period === option.value ? ' active' : ''}`}
            aria-pressed={period === option.value}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
      {status && (
        <span className={`metric-history-status${available === false ? ' unavailable' : ''}`} aria-live="polite">
          {status}
        </span>
      )}
    </div>
  );
}
