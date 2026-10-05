import React, { useEffect, useState } from 'react';

const W = 300;
const H = 68;
const PAD = 6;

// utilisation → colour: <80 green, 80-90 yellow, >=90 red
const utilColor = (pct) => {
  if (pct == null) return null;
  if (pct >= 90) return '#f85149';
  if (pct >= 80) return '#d29922';
  return '#3fb950';
};

export default function MetricsChart({ id, label, data, limit, format, fallbackColor = '#58a6ff', thresholdLabel = 'limit' }) {
  const points = (Array.isArray(data) ? data : []).map((point, index) => {
    if (typeof point === 'number') return { value: point, time: index, hasTimestamp: false };
    const timestamp = typeof point?.timestamp === 'number' ? point.timestamp : Date.parse(point?.timestamp);
    return {
      value: point?.value == null ? NaN : Number(point.value),
      time: Number.isFinite(timestamp) ? timestamp : index,
      hasTimestamp: Number.isFinite(timestamp)
    };
  }).filter((point) => Number.isFinite(point.value));
  const [hovered, setHovered] = useState(null);
  const current = points.length ? points[points.length - 1].value : null;
  const pct = limit && current != null ? (current / limit) * 100 : null;
  const color = pct != null ? utilColor(pct) : fallbackColor;

  const dataMax = Math.max(...points.map((point) => point.value), 0);
  const max = Math.max(dataMax, limit || 0, 1) * 1.15;
  const n = points.length;

  const yFor = (v) => H - PAD - (v / max) * (H - PAD * 2);
  const firstTime = points[0]?.time;
  const lastTime = points[n - 1]?.time;
  const timelineKey = `${firstTime ?? ''}:${lastTime ?? ''}`;
  const hasTimestamps = points.length > 0 && points.every((point) => point.hasTimestamp);
  useEffect(() => setHovered(null), [timelineKey]);
  const xy = points.map((point, i) => {
    const x = n === 1
      ? W
      : lastTime > firstTime
        ? ((point.time - firstTime) / (lastTime - firstTime)) * W
        : (i / (n - 1)) * W;
    return [x, yFor(point.value)];
  });
  const linePath = xy.map(([x, y], i) => `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const areaPath = linePath ? `${linePath} L ${W} ${H} L 0 ${H} Z` : '';
  const last = xy[xy.length - 1];
  const limitY = limit ? yFor(limit) : null;
  const timeLabel = (time) => new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
  }).format(new Date(time));
  const exactTimeLabel = (time) => {
    const date = new Date(time);
    return new Intl.DateTimeFormat(undefined, {
      year: 'numeric', month: 'short', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short'
    }).format(date);
  };
  const handlePointerMove = (event) => {
    if (!hasTimestamps || !xy.length) return;
    const svgRect = event.currentTarget.getBoundingClientRect();
    const chartRect = event.currentTarget.closest('.metric-chart').getBoundingClientRect();
    if (!svgRect.width || !chartRect.width) return;
    const ratio = Math.max(0, Math.min(1, (event.clientX - svgRect.left) / svgRect.width));
    const targetX = ratio * W;
    let index = 0;
    let distance = Infinity;
    xy.forEach(([x], i) => {
      const nextDistance = Math.abs(x - targetX);
      if (nextDistance < distance) { distance = nextDistance; index = i; }
    });
    const sampleRatio = xy[index][0] / W;
    const left = ((svgRect.left - chartRect.left + sampleRatio * svgRect.width) / chartRect.width) * 100;
    setHovered((currentHover) => currentHover?.index === index && Math.abs(currentHover.left - left) < 0.25
      ? currentHover
      : { index, left });
  };

  const fmt = format || ((v) => Math.round(v));

  return (
    <div className="metric-chart">
      <div className="metric-chart-head">
        <span className="metric-chart-label">{label}</span>
        <span className="metric-chart-value" style={{ color }}>
          {current == null ? '—' : fmt(current)}
          {limit ? (
            <span className="metric-chart-sub">
              {' / '}{fmt(limit)} {thresholdLabel}
              {pct != null && <span style={{ color, marginLeft: 6 }}>{Math.round(pct)}%</span>}
            </span>
          ) : null}
        </span>
      </div>
      {hovered && points[hovered.index] && hasTimestamps && (
        <div
          className="metric-chart-tooltip"
          style={{
            left: `${hovered.left}%`,
            transform: hovered.left < 24 ? 'translateX(0)' : hovered.left > 76 ? 'translateX(-100%)' : 'translateX(-50%)'
          }}
        >
          <time>{exactTimeLabel(points[hovered.index].time)}</time>
          <span>{label}</span>
          <strong style={{ color }}>{fmt(points[hovered.index].value)}</strong>
        </div>
      )}
      <svg
        className={`metric-chart-svg${hasTimestamps ? ' interactive' : ''}`}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        onPointerMove={handlePointerMove}
        onPointerLeave={() => setHovered(null)}
      >
        <defs>
          <linearGradient id={`grad-${id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.35" />
            <stop offset="100%" stopColor={color} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {areaPath && <path d={areaPath} fill={`url(#grad-${id})`} />}
        {linePath && <path d={linePath} fill="none" stroke={color} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />}
        {limitY != null && (
          <line
            x1="0" y1={limitY} x2={W} y2={limitY}
            stroke="#f85149" strokeWidth="1.2"
            strokeDasharray="5 4" vectorEffect="non-scaling-stroke" opacity="0.85"
          />
        )}
        {hovered && hasTimestamps && xy[hovered.index] && (
          <>
            <line x1={xy[hovered.index][0]} y1={PAD} x2={xy[hovered.index][0]} y2={H - PAD} className="metric-chart-crosshair" />
            <circle cx={xy[hovered.index][0]} cy={xy[hovered.index][1]} r="3.5" fill={color} stroke="var(--bg-base)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
          </>
        )}
        {last && <circle cx={last[0]} cy={last[1]} r="2.8" fill={color} />}
      </svg>
      {hasTimestamps && (
        <div className="metric-chart-time-range">
          <span>{timeLabel(firstTime)}</span>
          <span>{timeLabel(lastTime)}</span>
        </div>
      )}
    </div>
  );
}
