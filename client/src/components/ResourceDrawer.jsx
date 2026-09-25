import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import Icon from './Icons';
import MetricsChart from './MetricsChart';
import Loader from './Loader';
import ServicePortForward from './ServicePortForward';
import useClickOutside from '../hooks/useClickOutside';

const fmtCpu = (m) => (m >= 1000 ? `${(m / 1000).toFixed(2)} cores` : `${Math.round(m)}m`);
const fmtMem = (b) => {
  const mi = b / 1024 / 1024;
  return mi >= 1024 ? `${(mi / 1024).toFixed(2)} Gi` : `${Math.round(mi)} Mi`;
};
const fmtMemMi = (mi) => (mi >= 1024 ? `${(mi / 1024).toFixed(2)} Gi` : `${Math.round(mi)} Mi`);

const parseCpuMilliStr = (s) => {
  if (!s) return null;
  s = String(s);
  if (s.endsWith('n')) return parseFloat(s) / 1e6;
  if (s.endsWith('u')) return parseFloat(s) / 1e3;
  if (s.endsWith('m')) return parseFloat(s);
  return parseFloat(s) * 1000;
};
const parseMemBytesStr = (s) => {
  if (!s) return null;
  const m = String(s).match(/^(\d+(?:\.\d+)?)\s*([KMGTP]i)?$/);
  if (!m) return parseFloat(s) || null;
  const mult = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, Pi: 1024 ** 5 };
  return parseFloat(m[1]) * (mult[m[2]] || 1);
};
// Sum a resource across containers only if every container specifies it
const sumRes = (containers, kind, res, parse) => {
  let total = 0, count = 0;
  containers.forEach(c => {
    const v = c.resources?.[kind]?.[res];
    if (v != null) { total += parse(v) || 0; count++; }
  });
  return count === containers.length && count > 0 ? total : null;
};

const KIND_ICON = {
  Pod: 'pod', Service: 'service', Deployment: 'deployment',
  StatefulSet: 'statefulSet', DaemonSet: 'daemonSet', ReplicaSet: 'replicaSet',
  Job: 'job', CronJob: 'cronJob',
  ConfigMap: 'configMap', Secret: 'secret', ServiceAccount: 'serviceAccount',
  Role: 'accessControl', RoleBinding: 'accessControl',
  ClusterRole: 'accessControl', ClusterRoleBinding: 'accessControl',
  Ingress: 'ingress', NetworkPolicy: 'networkPolicy',
  PersistentVolume: 'persistentVolume', PersistentVolumeClaim: 'persistentVolumeClaim', StorageClass: 'storageClass'
};

// Owner kinds we have list views for (so "Controlled By" can link)
const OWNER_TYPE = {
  Deployment: 'deployment',
  StatefulSet: 'statefulSet',
  DaemonSet: 'daemonSet',
  Service: 'service'
};

const formatAge = (createdAt) => {
  if (!createdAt) return '-';
  const seconds = Math.floor((new Date() - new Date(createdAt)) / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
};

// Decode a base64 (Secret) value to a UTF-8 string
const decodeB64 = (v) => {
  try {
    const bin = atob(v);
    const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return v;
  }
};

const statusClass = (status) => {
  const s = (status || '').toLowerCase();
  if (s === 'running' || s === 'ready' || s === 'active' || s === 'succeeded' || s === 'bound') return 'running';
  if (s === 'pending' || s.includes('progress')) return 'pending';
  if (s === 'failed' || s === 'error' || s === 'crashloopbackoff') return 'failed';
  return '';
};

function Row({ label, children }) {
  if (children == null || children === '' || children === '-') return null;
  return (
    <div className="drawer-row">
      <span className="drawer-row-label">{label}</span>
      <span className="drawer-row-value">{children}</span>
    </div>
  );
}

function Chips({ obj, max }) {
  const entries = Object.entries(obj || {});
  if (!entries.length) return null;
  const shown = max ? entries.slice(0, max) : entries;
  return (
    <div className="drawer-chips">
      {shown.map(([k, v]) => (
        <span key={k} className="drawer-chip">{k}{v ? `: ${v}` : ''}</span>
      ))}
      {max && entries.length > max && <span className="drawer-chip muted">+{entries.length - max} more</span>}
    </div>
  );
}

// Annotations often hold huge blobs (e.g. last-applied-configuration). Render
// each as a readable key → value pair, pretty-printing JSON and collapsing long
// values behind a toggle so the panel stays scannable.
function AnnotationItem({ name, value }) {
  const [open, setOpen] = useState(false);
  const raw = value == null ? '' : String(value);
  const trimmed = raw.trim();
  let pretty = null;
  const looksJson = (trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'));
  if (looksJson) { try { pretty = JSON.stringify(JSON.parse(trimmed), null, 2); } catch { /* not valid JSON */ } }
  const display = pretty ?? raw;
  const collapsible = pretty != null || display.length > 100 || display.includes('\n');
  return (
    <div className="anno-item">
      <div className="anno-key" title={name}>{name}</div>
      {collapsible ? (
        <div className="anno-value">
          <button className="anno-toggle" onClick={() => setOpen((o) => !o)}>
            <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} strokeWidth={2.4} />
            {open ? 'Hide' : (pretty != null ? 'Show JSON' : 'Show value')}
            <span className="anno-size">{pretty != null ? 'JSON · ' : ''}{display.length.toLocaleString()} chars</span>
          </button>
          {open && <pre className="anno-pre">{display}</pre>}
        </div>
      ) : (
        <div className="anno-value anno-inline">{raw}</div>
      )}
    </div>
  );
}

function Annotations({ obj }) {
  const entries = Object.entries(obj || {});
  if (!entries.length) return null;
  // Put the noisy last-applied-configuration last; it's rarely what you want.
  entries.sort((a, b) => (a[0].includes('last-applied-configuration') ? 1 : 0) - (b[0].includes('last-applied-configuration') ? 1 : 0));
  return (
    <div className="drawer-annos">
      {entries.map(([k, v]) => <AnnotationItem key={k} name={k} value={v} />)}
    </div>
  );
}

export default function ResourceDrawer({ resource, namespace, resourceType, onClose, onOpenTab, onNavigate, onAction, canScale, canRestart, refreshSignal = 0 }) {
  const [obj, setObj] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [cpuHist, setCpuHist] = useState([]);
  const [memHist, setMemHist] = useState([]);
  const [metricsNow, setMetricsNow] = useState(null);
  const [metricsAvail, setMetricsAvail] = useState(true);
  const [revealSecrets, setRevealSecrets] = useState(false);
  const drawerRef = useRef(null);
  useClickOutside(drawerRef, onClose);

  const isPodKind = resourceType === 'pod' || (resource?.kind || '').toLowerCase() === 'pod';

  useEffect(() => {
    if (resource) fetchDetail();
  }, [resource]);

  // A global/auto refresh updates the open drawer in place: the panel keeps its
  // content, tab and scroll while the new object is fetched underneath.
  const didMount = useRef(false);
  useEffect(() => {
    if (!didMount.current) { didMount.current = true; return; }
    if (resource) fetchDetail({ silent: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSignal]);

  // Live metrics polling for pods
  useEffect(() => {
    if (!resource || !isPodKind) return;
    let active = true;
    setCpuHist([]);
    setMemHist([]);
    setMetricsNow(null);
    setMetricsAvail(true);
    const ns = resource.namespace || namespace;

    const poll = async () => {
      try {
        const res = await axios.get(`/api/metrics/pod/${ns}/${resource.name}`);
        if (!active) return;
        if (res.data?.available === false) {
          setMetricsAvail(false);
          return;
        }
        setMetricsNow(res.data);
        setCpuHist(h => [...h, res.data.cpuMilli].slice(-40));
        setMemHist(h => [...h, res.data.memBytes].slice(-40));
      } catch (e) {
        if (active) setMetricsAvail(false);
      }
    };
    poll();
    const iv = setInterval(poll, 3000);
    return () => { active = false; clearInterval(iv); };
  }, [resource, isPodKind]);

  const fetchDetail = async ({ silent = false } = {}) => {
    if (!silent) {
      setLoading(true);
      setObj(null);
      setRevealSecrets(false);
    }
    try {
      const ns = resource.namespace || namespace;
      const kind = resource.kind || 'Pod';
      const res = await axios.get(`/api/resource/${ns}/${kind}/${resource.name}`);
      setObj(res.data);
      setError(null);
    } catch (err) {
      if (!silent) setError(`Failed to load details: ${err.response?.data?.error || err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const meta = obj?.metadata || {};
  const spec = obj?.spec || {};
  const status = obj?.status || {};
  const kind = obj?.kind || resource.kind || 'Pod';
  const isPod = kind === 'Pod';
  const isSecret = kind === 'Secret';
  const isConfigMap = kind === 'ConfigMap';

  // Data key/values: ConfigMap is plain; Secret is base64 -> decode
  const dataEntries = (isSecret || isConfigMap)
    ? [
        ...Object.entries(obj?.data || {}).map(([k, v]) => [k, isSecret ? decodeB64(v) : v]),
        ...Object.entries(obj?.binaryData || {}).map(([k]) => [k, '<binary data>']),
        ...Object.entries(obj?.stringData || {}).map(([k, v]) => [k, v])
      ]
    : [];

  const conditions = (status.conditions || []).filter(c => c.status === 'True').map(c => c.type);
  const owner = (meta.ownerReferences || [])[0];
  const containers = spec.containers || [];

  // CPU/Memory thresholds: prefer limits, fall back to requests
  const cpuLimitVal = sumRes(containers, 'limits', 'cpu', parseCpuMilliStr);
  const cpuReqVal = sumRes(containers, 'requests', 'cpu', parseCpuMilliStr);
  const cpuThreshold = cpuLimitVal ?? cpuReqVal;          // millicores
  const cpuThreshKind = cpuLimitVal != null ? 'limit' : 'request';
  const memLimitVal = sumRes(containers, 'limits', 'memory', parseMemBytesStr);
  const memReqVal = sumRes(containers, 'requests', 'memory', parseMemBytesStr);
  const memThreshold = memLimitVal ?? memReqVal;          // bytes
  const memThreshKind = memLimitVal != null ? 'limit' : 'request';

  const secretNames = [];
  (spec.volumes || []).forEach(v => { if (v.secret?.secretName) secretNames.push(v.secret.secretName); });
  (spec.imagePullSecrets || []).forEach(s => s.name && secretNames.push(s.name));

  return (
    <div className="resource-drawer" ref={drawerRef}>
      <div className="drawer-header">
        <div className="drawer-title">
          <div className={`drawer-title-icon ${statusClass(resource.status) || 'blue'}`}>
            <Icon name={KIND_ICON[kind] || 'box'} size={18} />
          </div>
          <div className="drawer-title-text">
            <span className="drawer-kind">{kind}</span>
            <span className="drawer-name" title={resource.name}>{resource.name}</span>
          </div>
        </div>
        <div className="drawer-actions">
          {isPod && (
            <>
              <button className="drawer-action-btn" title="Logs" onClick={() => onOpenTab('logs')}>
                <Icon name="logs" size={16} />
              </button>
              <button className="drawer-action-btn" title="Terminal" onClick={() => onOpenTab('terminal')}>
                <Icon name="terminal" size={16} />
              </button>
            </>
          )}
          <button className="drawer-action-btn" title="Edit YAML" onClick={() => onOpenTab('configuration')}>
            <Icon name="configuration" size={16} />
          </button>
          {canScale && (
            <button className="drawer-action-btn" title="Scale" onClick={() => onAction && onAction('scale')}>
              <Icon name="scale" size={16} />
            </button>
          )}
          {canRestart && (
            <button className="drawer-action-btn" title="Rollout restart" onClick={() => onAction && onAction('restart')}>
              <Icon name="refresh" size={16} />
            </button>
          )}
          <button className="drawer-action-btn danger" title="Delete" onClick={() => onAction && onAction('delete')}>
            <Icon name="delete" size={16} />
          </button>
          <button className="drawer-action-btn" title="Close" onClick={onClose}>
            <Icon name="close" size={17} />
          </button>
        </div>
      </div>

      <div className="drawer-body">
        {isPodKind && (
          <div className="drawer-section">
            <div className="drawer-section-title">Resource Usage</div>
            {!metricsAvail ? (
              <div className="drawer-dim">Metrics not available</div>
            ) : (
              <div className="metric-charts">
                <MetricsChart
                  id="cpu"
                  label="CPU"
                  data={cpuHist}
                  limit={cpuThreshold}
                  thresholdLabel={cpuThreshKind}
                  format={fmtCpu}
                  fallbackColor="#58a6ff"
                />
                <MetricsChart
                  id="mem"
                  label="Memory"
                  data={memHist.map(b => b / 1024 / 1024)}
                  limit={memThreshold != null ? memThreshold / 1024 / 1024 : null}
                  thresholdLabel={memThreshKind}
                  format={fmtMemMi}
                  fallbackColor="#bc8cff"
                />
              </div>
            )}
          </div>
        )}

        {loading && <Loader label="Loading details…" inline />}
        {error && <div className="drawer-error">{error}</div>}

        {!loading && obj && (
          <>
            <div className="drawer-section">
              <Row label="Created">
                {formatAge(meta.creationTimestamp)} ago
                {meta.creationTimestamp && (
                  <span className="drawer-dim"> ({new Date(meta.creationTimestamp).toLocaleString()})</span>
                )}
              </Row>
              <Row label="Name">{meta.name}</Row>
              <Row label="Namespace">
                <span className="xlink" onClick={() => onNavigate?.toNamespace(meta.namespace)}>
                  {meta.namespace}
                </span>
              </Row>
              <Row label="Labels"><Chips obj={meta.labels} max={12} /></Row>
              {meta.annotations && Object.keys(meta.annotations).length > 0 && (
                <div className="drawer-annos-block">
                  <span className="drawer-row-label">Annotations</span>
                  <Annotations obj={meta.annotations} />
                </div>
              )}
            </div>

            <div className="drawer-section">
              <Row label="Status">
                <span className={`drawer-status ${statusClass(status.phase || resource.status)}`}>
                  {status.phase || resource.status || '—'}
                </span>
              </Row>
              {isPod && (
                <>
                  <Row label="Node">
                    <span className="xlink" onClick={() => onNavigate?.toNode(spec.nodeName)}>
                      {spec.nodeName}
                    </span>
                  </Row>
                  <Row label="Pod IP">{status.podIP}</Row>
                  <Row label="Priority Class">{spec.priorityClassName || '—'}</Row>
                  <Row label="QoS Class">{status.qosClass}</Row>
                  <Row label="Service Account">{spec.serviceAccountName || spec.serviceAccount}</Row>
                  <Row label="Conditions">
                    <span className="drawer-chips">
                      {conditions.map(c => <span key={c} className="drawer-chip cond">{c}</span>)}
                    </span>
                  </Row>
                  {spec.tolerations?.length ? <Row label="Tolerations">{spec.tolerations.length}</Row> : null}
                  {secretNames.length ? (
                    <Row label="Secrets">
                      <span className="drawer-chips">
                        {[...new Set(secretNames)].map(s => <span key={s} className="drawer-chip">{s}</span>)}
                      </span>
                    </Row>
                  ) : null}
                </>
              )}
              {owner && (
                <Row label="Controlled By">
                  {OWNER_TYPE[owner.kind] ? (
                    <span
                      className="xlink"
                      onClick={() => onNavigate?.toResource({ type: OWNER_TYPE[owner.kind], namespace: meta.namespace, name: owner.name })}
                    >
                      {owner.kind}/{owner.name}
                    </span>
                  ) : (
                    <span>{owner.kind}/{owner.name}</span>
                  )}
                </Row>
              )}
            </div>

            {/* ConfigMap / Secret data */}
            {(isConfigMap || isSecret) && (
              <div className="drawer-section">
                <div className="drawer-section-title data-title">
                  <span>Data ({dataEntries.length})</span>
                  {isSecret && dataEntries.length > 0 && (
                    <button className="reveal-btn" onClick={() => setRevealSecrets(v => !v)}>
                      <Icon name={revealSecrets ? 'eyeOff' : 'eye'} size={13} />
                      {revealSecrets ? 'Hide' : 'Reveal'}
                    </button>
                  )}
                </div>
                {dataEntries.length === 0 ? (
                  <div className="drawer-dim">No data</div>
                ) : (
                  dataEntries.map(([key, value]) => (
                    <div key={key} className="data-item">
                      <div className="data-key">
                        <span>{key}</span>
                        <button
                          className="data-copy"
                          title="Copy value"
                          onClick={() => navigator.clipboard?.writeText(String(value))}
                        >
                          <Icon name="copy" size={13} />
                        </button>
                      </div>
                      <pre className="data-value">
                        {isSecret && !revealSecrets ? '••••••••••••' : String(value)}
                      </pre>
                    </div>
                  ))
                )}
              </div>
            )}

            {/* Workload spec */}
            {(kind === 'Deployment' || kind === 'StatefulSet' || kind === 'DaemonSet' || kind === 'ReplicaSet') && (
              <div className="drawer-section">
                <div className="drawer-section-title">Replicas</div>
                <Row label="Desired">{spec.replicas != null ? spec.replicas : '—'}</Row>
                <Row label="Ready">{status.readyReplicas || 0}</Row>
                <Row label="Available">{status.availableReplicas || 0}</Row>
                <Row label="Updated">{status.updatedReplicas || 0}</Row>
                <Row label="Strategy">{spec.strategy?.type || spec.updateStrategy?.type}</Row>
                <Row label="Selector"><Chips obj={spec.selector?.matchLabels} max={8} /></Row>
              </div>
            )}

            {/* Service spec */}
            {kind === 'Service' && (
              <div className="drawer-section">
                <div className="drawer-section-title">Networking</div>
                <Row label="Type">{spec.type}</Row>
                <Row label="Cluster IP">{spec.clusterIP}</Row>
                <Row label="Session Affinity">{spec.sessionAffinity}</Row>
                <Row label="Selector"><Chips obj={spec.selector} max={8} /></Row>
                <Row label="Ports">
                  <span className="drawer-chips">
                    {(spec.ports || []).map((p, i) => (
                      <span key={i} className="drawer-chip">{p.port}{p.targetPort ? `→${p.targetPort}` : ''}/{p.protocol || 'TCP'}</span>
                    ))}
                  </span>
                </Row>
              </div>
            )}

            {/* Port forwarding (services only) */}
            {kind === 'Service' && (
              <ServicePortForward namespace={meta.namespace} name={meta.name} ports={spec.ports || []} />
            )}

            {/* PersistentVolume storage — link out to its StorageClass and bound PVC */}
            {kind === 'PersistentVolume' && (
              <div className="drawer-section">
                <div className="drawer-section-title">Storage</div>
                <Row label="Capacity">{spec.capacity?.storage}</Row>
                <Row label="Access Modes">{(spec.accessModes || []).join(', ')}</Row>
                <Row label="Reclaim Policy">{spec.persistentVolumeReclaimPolicy}</Row>
                <Row label="Volume Mode">{spec.volumeMode}</Row>
                <Row label="Storage Class">
                  {spec.storageClassName ? (
                    <span className="xlink" onClick={() => onNavigate?.toResource({ type: 'storageClass', name: spec.storageClassName })}>
                      {spec.storageClassName}
                    </span>
                  ) : '—'}
                </Row>
                <Row label="Claim">
                  {spec.claimRef?.name ? (
                    <span className="xlink" onClick={() => onNavigate?.toResource({ type: 'persistentVolumeClaim', namespace: spec.claimRef.namespace, name: spec.claimRef.name })}>
                      {spec.claimRef.namespace ? `${spec.claimRef.namespace}/` : ''}{spec.claimRef.name}
                    </span>
                  ) : '—'}
                </Row>
              </div>
            )}

            {/* PersistentVolumeClaim storage — link out to its StorageClass and bound PV */}
            {kind === 'PersistentVolumeClaim' && (
              <div className="drawer-section">
                <div className="drawer-section-title">Storage</div>
                <Row label="Capacity">{status.capacity?.storage || spec.resources?.requests?.storage}</Row>
                <Row label="Access Modes">{(spec.accessModes || []).join(', ')}</Row>
                <Row label="Volume Mode">{spec.volumeMode}</Row>
                <Row label="Storage Class">
                  {spec.storageClassName ? (
                    <span className="xlink" onClick={() => onNavigate?.toResource({ type: 'storageClass', name: spec.storageClassName })}>
                      {spec.storageClassName}
                    </span>
                  ) : '—'}
                </Row>
                <Row label="Volume">
                  {spec.volumeName ? (
                    <span className="xlink" onClick={() => onNavigate?.toResource({ type: 'persistentVolume', name: spec.volumeName })}>
                      {spec.volumeName}
                    </span>
                  ) : '—'}
                </Row>
              </div>
            )}

            {/* Containers */}
            {containers.length > 0 && (
              <div className="drawer-section">
                <div className="drawer-section-title">Containers ({containers.length})</div>
                {containers.map((c, i) => {
                  const cs = (status.containerStatuses || []).find(s => s.name === c.name);
                  const ready = cs?.ready;
                  const cm = metricsNow?.containers?.find(m => m.name === c.name);
                  return (
                    <div key={i} className="drawer-container">
                      <div className="drawer-container-head">
                        <span className={`status-dot ${ready ? 'running' : (cs ? 'failed' : 'pending')}`} />
                        <span className="drawer-container-name">{c.name}</span>
                        {cs && <span className="drawer-dim">restarts: {cs.restartCount}</span>}
                      </div>
                      {cm && (
                        <Row label="Usage">
                          <span style={{ color: '#58a6ff' }}>{fmtCpu(cm.cpuMilli)} CPU</span>
                          {' · '}
                          <span style={{ color: '#bc8cff' }}>{fmtMem(cm.memBytes)} Mem</span>
                        </Row>
                      )}
                      <Row label="Image">{c.image}</Row>
                      {c.ports?.length ? (
                        <Row label="Ports">
                          <span className="drawer-chips">
                            {c.ports.map((p, j) => <span key={j} className="drawer-chip">{p.containerPort}/{p.protocol || 'TCP'}</span>)}
                          </span>
                        </Row>
                      ) : null}
                      {c.resources?.requests && (
                        <Row label="Requests">
                          {`${c.resources.requests.cpu || '—'} CPU · ${c.resources.requests.memory || '—'} Mem`}
                        </Row>
                      )}
                      {c.resources?.limits && (
                        <Row label="Limits">
                          {`${c.resources.limits.cpu || '—'} CPU · ${c.resources.limits.memory || '—'} Mem`}
                        </Row>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
