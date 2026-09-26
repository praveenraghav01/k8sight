const RESOURCE_QUANTITY = /^([+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?)(Ei|Pi|Ti|Gi|Mi|Ki|E|P|T|G|M|K|k|m|u|n)?$/;

const MEMORY_MULTIPLIERS = {
  Ei: 1024 ** 6,
  Pi: 1024 ** 5,
  Ti: 1024 ** 4,
  Gi: 1024 ** 3,
  Mi: 1024 ** 2,
  Ki: 1024,
  E: 1e18,
  P: 1e15,
  T: 1e12,
  G: 1e9,
  M: 1e6,
  K: 1e3,
  k: 1e3,
  m: 1e-3,
  u: 1e-6,
  n: 1e-9
};

export const parseCpuMilli = (quantity) => {
  if (quantity == null || quantity === '') return null;
  const value = String(quantity).trim();
  if (value.endsWith('n')) return Number.parseFloat(value) / 1e6;
  if (value.endsWith('u')) return Number.parseFloat(value) / 1e3;
  if (value.endsWith('m')) return Number.parseFloat(value);
  const cores = Number.parseFloat(value);
  return Number.isFinite(cores) ? cores * 1000 : null;
};

export const parseMemoryBytes = (quantity) => {
  if (quantity == null || quantity === '') return null;
  const match = String(quantity).trim().match(RESOURCE_QUANTITY);
  if (!match) return null;
  const bytes = Number(match[1]) * (MEMORY_MULTIPLIERS[match[2]] || 1);
  return Number.isFinite(bytes) ? bytes : null;
};

// Match Kubernetes pod accounting: missing container values contribute zero,
// init containers use their peak, restartable init sidecars remain alongside
// later init/app containers, and pod overhead is added after that calculation.
export const effectivePodResource = (spec, field, resource, parse) => {
  const podSpec = spec || {};
  const regularContainers = podSpec.containers || [];
  const initContainers = podSpec.initContainers || [];
  const podValue = podSpec.resources?.[field]?.[resource];
  const overheadValue = podSpec.overhead?.[resource];
  const allContainers = [...regularContainers, ...initContainers];
  const declared = podValue != null
    || overheadValue != null
    || allContainers.some((container) => container.resources?.[field]?.[resource] != null);
  if (!declared) return null;

  const quantity = (value) => {
    const parsed = parse(value);
    return parsed == null || !Number.isFinite(parsed) ? 0 : parsed;
  };
  const overhead = quantity(overheadValue);
  if (podValue != null) return quantity(podValue) + overhead;

  const regularTotal = regularContainers.reduce(
    (sum, container) => sum + quantity(container.resources?.[field]?.[resource]),
    0
  );
  let restartableInitTotal = 0;
  let initPeak = 0;
  for (const container of initContainers) {
    const amount = quantity(container.resources?.[field]?.[resource]);
    initPeak = Math.max(initPeak, restartableInitTotal + amount);
    if (container.restartPolicy === 'Always') restartableInitTotal += amount;
  }

  return Math.max(regularTotal + restartableInitTotal, initPeak) + overhead;
};
