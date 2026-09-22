// Sorting helpers for the resource table (ResourceViewer).
//
// Kept as pure functions in their own module so the ordering rules can be unit
// tested without rendering React. The table sorts by an explicit ordering key
// per column (not the rendered text), so "92m" sorts below "346m" and "500Mi"
// below "10Gi". Rows missing a sortable value (no metrics, no capacity, no
// creation timestamp) always sort last, in both directions.

// "10Gi" / "500Mi" / "5" -> a number of bytes (or the bare number), so capacity
// columns sort by size and not lexically. Returns null when there's nothing to
// parse, so such rows sort last.
export const parseQuantity = (q) => {
  if (q === null || q === undefined || q === '') return null;
  const m = String(q).match(/^([\d.]+)\s*([KMGTP]i?)?/);
  if (!m) return null;
  const units = {
    K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15,
    Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, Pi: 1024 ** 5,
  };
  return parseFloat(m[1]) * (units[m[2]] || 1);
};

// Ordering key for a column: a number where the column is numeric, a string
// otherwise, or null when the row has no value for that column.
export const sortValue = (r, col, podMetrics = {}) => {
  const m = podMetrics[`${r.namespace}/${r.name}`];
  switch (col) {
    case 'Name': return r.name || '';
    case 'Namespace': return r.namespace || '';
    case 'Node': return r.node || '';
    case 'Status': return r.status || '';
    case 'Containers': return (r.containerStates || []).length;
    case 'CPU': return m ? m.cpuMilli : null;
    case 'Memory': return m ? m.memBytes : null;
    case 'Restarts': return Number(r.restarts) || 0;
    // ascending = youngest (most recent) first; undated rows sort last
    case 'Age': return r.createdAt ? -new Date(r.createdAt).getTime() : null;
    case 'Keys': return Number(r.dataKeys) || 0;
    case 'Secrets': return Number(r.saSecrets) || 0;
    case 'Capacity': return parseQuantity(r.capacity);
    case 'Type': return r.secretType || '';
    case 'Class': return r.ingressClass || '';
    case 'Hosts': return r.hosts || '';
    case 'Policy Types': return r.policyTypes || '';
    case 'Access Modes': return r.accessModes || '';
    case 'Reclaim Policy': return r.reclaimPolicy || '';
    case 'Storage Class': return r.storageClass || '';
    case 'Volume': return r.volume || '';
    case 'Claim': return r.claim || '';
    case 'Provisioner': return r.provisioner || '';
    case 'Binding Mode': return r.bindingMode || '';
    default: return '';
  }
};

const isNullish = (v) => v === null || v === undefined;

// Return a new array sorted by `sort` ({ col, dir: 'asc' | 'desc' }). When
// `sort` is falsy, the original array is returned unchanged (server order).
export const sortResources = (resources, sort, podMetrics = {}) => {
  if (!sort) return resources;
  const dir = sort.dir === 'asc' ? 1 : -1;
  return [...resources].sort((a, b) => {
    const va = sortValue(a, sort.col, podMetrics);
    const vb = sortValue(b, sort.col, podMetrics);
    // rows with no value for this column always sort last, either direction
    if (isNullish(va) && isNullish(vb)) return 0;
    if (isNullish(va)) return 1;
    if (isNullish(vb)) return -1;
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
    return String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: 'base' }) * dir;
  });
};
