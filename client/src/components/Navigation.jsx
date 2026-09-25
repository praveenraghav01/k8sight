import React from 'react';
import Icon from './Icons';
import CustomResourceTree from './CustomResourceTree';
import ContextSelector from './ContextSelector';

export default function Navigation({
  configStatus,
  onConfigChange,
  onSwitchContext,
  resourceType,
  onResourceTypeChange,
  navExpanded,
  onToggleNav,
  crSelection,
  onSelectCustomResource,
  argocdInstalled,
  argoView,
  onSelectArgoView,
  securityView,
  onSelectSecurityView,
  onAddAzure,
  onAddAws,
  onAddGke,
  onAddLocal,
  onOpenPreferences
}) {
  // Route context changes through the app-level switch so the new cluster's
  // namespaces + resources are re-fetched (a plain POST leaves the UI empty).
  const handleContextChange = (context) => {
    if (onSwitchContext) return onSwitchContext(context);
  };

  const mainSections = [
    { key: 'cluster', label: 'Cluster', icon: 'cluster' },
    { key: 'nodes', label: 'Nodes', icon: 'nodes' },
    { key: 'namespaces', label: 'Namespaces', icon: 'namespace' },
    { key: 'topology', label: 'Topology', icon: 'topology' }
  ];

  const workloadTypes = [
    { key: 'overview', label: 'Overview', icon: 'overview' },
    { key: 'pod', label: 'Pods', icon: 'pod' },
    { key: 'deployment', label: 'Deployments', icon: 'deployment' },
    { key: 'statefulSet', label: 'StatefulSets', icon: 'statefulSet' },
    { key: 'daemonSet', label: 'DaemonSets', icon: 'daemonSet' },
    { key: 'replicaSet', label: 'Replica Sets', icon: 'replicaSet' },
    { key: 'replicationController', label: 'Replication Controllers', icon: 'replicationController' },
    { key: 'job', label: 'Jobs', icon: 'job' },
    { key: 'cronJob', label: 'Cron Jobs', icon: 'cronJob' }
  ];

  const networkTypes = [
    { key: 'service', label: 'Services', icon: 'service' },
    { key: 'ingress', label: 'Ingress', icon: 'ingress' },
    { key: 'networkPolicy', label: 'Network Policies', icon: 'networkPolicy' }
  ];

  const storageTypes = [
    { key: 'persistentVolume', label: 'PersistentVolumes', icon: 'persistentVolume' },
    { key: 'persistentVolumeClaim', label: 'PersistentVolumeClaims', icon: 'persistentVolumeClaim' },
    { key: 'storageClass', label: 'StorageClasses', icon: 'storageClass' }
  ];

  const configTypes = [
    { key: 'configMap', label: 'ConfigMaps', icon: 'configMap' },
    { key: 'secret', label: 'Secrets', icon: 'secret' },
    { key: 'serviceAccount', label: 'ServiceAccounts', icon: 'serviceAccount' }
  ];

  const otherSections = [
    { key: 'events', label: 'Events', icon: 'events' },
    { key: 'helm', label: 'Helm', icon: 'helm' },
    { key: 'accessControl', label: 'Access Control', icon: 'accessControl' },
  ];

  // Security Center sub-views — mirror the tabs inside the Security view.
  const securityTypes = [
    { key: 'overview', label: 'Overview', icon: 'overview' },
    { key: 'images', label: 'Images', icon: 'box' },
    { key: 'resources', label: 'Resources', icon: 'configuration' },
    { key: 'roles', label: 'Roles', icon: 'accessControl' },
  ];

  // ArgoCD sub-views — these mirror the tabs inside the ArgoCD view and only
  // appear when Argo CD's CRDs are detected on the cluster. Repositories and
  // Clusters live under a nested "Settings" group.
  const argocdTypes = [
    { key: 'dashboard', label: 'Dashboard', icon: 'overview' },
    { key: 'applications', label: 'Applications', icon: 'argocd' },
    { key: 'view', label: 'View', icon: 'topology' },
    { key: 'appsets', label: 'Application Sets', icon: 'box' },
    { key: 'projects', label: 'Projects', icon: 'accessControl' },
  ];
  const argocdSettingsTypes = [
    { key: 'repositories', label: 'Repositories', icon: 'git' },
    { key: 'clusters', label: 'Clusters', icon: 'cluster' },
  ];

  const renderTreeItem = (type) => (
    <div
      key={type.key}
      className={`nav-item ${resourceType === type.key ? 'active' : ''}`}
      onClick={() => onResourceTypeChange(type.key)}
      title={type.label}
    >
      <Icon name={type.icon} size={15} className="nav-lead-icon" />
      {type.label}
    </div>
  );

  const renderSection = (key, label, items) => (
    <div className="nav-section">
      <div className="nav-section-title" onClick={() => onToggleNav(key)}>
        <span className={`nav-section-chevron ${navExpanded[key] ? 'open' : ''}`}>
          <Icon name="chevronRight" size={13} strokeWidth={2.2} />
        </span>
        {label}
      </div>
      {navExpanded[key] && <div className="nav-items">{items.map(renderTreeItem)}</div>}
    </div>
  );

  return (
    <nav className="nav-sidebar">
      <div className="nav-header">
        <div className="nav-brand">
          <div className="nav-brand-logo">
            <Icon name="logo" size={19} strokeWidth={1.8} />
          </div>
          <div className="nav-brand-text">
            <span className="nav-brand-title">k8sight</span>
            <span className="nav-brand-sub">
              Kubernetes
              {typeof __APP_VERSION__ !== 'undefined' && (
                <span className="nav-brand-version">v{__APP_VERSION__}</span>
              )}
            </span>
          </div>
          <button
            className="theme-toggle"
            onClick={onOpenPreferences}
            title="Preferences"
          >
            <Icon name="settings" size={16} />
          </button>
        </div>
        <div className="nav-cluster">Context</div>
        <ContextSelector
          contexts={configStatus.contexts || []}
          contextsInfo={configStatus.contextsInfo}
          currentContext={configStatus.currentContext}
          onChange={handleContextChange}
          onAddAzure={onAddAzure}
          onAddAws={onAddAws}
          onAddGke={onAddGke}
          onAddLocal={onAddLocal}
        />
      </div>

      <div className="nav-sections">
        {mainSections.map(section => (
          <div
            key={section.key}
            className={`nav-item simple ${resourceType === section.key ? 'active' : ''}`}
            onClick={() => onResourceTypeChange(section.key)}
          >
            <Icon name={section.icon} size={16} className="nav-lead-icon" />
            {section.label}
          </div>
        ))}

        <div className="nav-group-label">Workloads</div>
        {renderSection('workloads', 'Workloads', workloadTypes)}
        {renderSection('config', 'Config', configTypes)}
        {renderSection('network', 'Network', networkTypes)}
        {renderSection('storage', 'Storage', storageTypes)}

        <div className="nav-group-label">Cluster</div>
        {otherSections.map(section => (
          <div
            key={section.key}
            className={`nav-item simple ${resourceType === section.key ? 'active' : ''}`}
            onClick={() => onResourceTypeChange(section.key)}
          >
            <Icon name={section.icon} size={16} className="nav-lead-icon" />
            {section.label}
          </div>
        ))}

        {argocdInstalled && (
          <div className="nav-section">
            <div className="nav-section-title" onClick={() => onToggleNav('argocd')}>
              <span className={`nav-section-chevron ${navExpanded.argocd ? 'open' : ''}`}>
                <Icon name="chevronRight" size={13} strokeWidth={2.2} />
              </span>
              <Icon name="argocd" size={15} className="nav-lead-icon" />
              Argo CD
            </div>
            {navExpanded.argocd && (
              <div className="nav-items">
                {argocdTypes.map((type) => (
                  <div
                    key={type.key}
                    className={`nav-item ${argoView === type.key ? 'active' : ''}`}
                    onClick={() => onSelectArgoView(type.key)}
                    title={type.label}
                  >
                    <Icon name={type.icon} size={15} className="nav-lead-icon" />
                    {type.label}
                  </div>
                ))}

                <div className="nav-subsection">
                  <div className="nav-section-title nested" onClick={() => onToggleNav('argocdSettings')}>
                    <span className={`nav-section-chevron ${navExpanded.argocdSettings ? 'open' : ''}`}>
                      <Icon name="chevronRight" size={13} strokeWidth={2.2} />
                    </span>
                    Settings
                  </div>
                  {navExpanded.argocdSettings && (
                    <div className="nav-items">
                      {argocdSettingsTypes.map((type) => (
                        <div
                          key={type.key}
                          className={`nav-item ${argoView === type.key ? 'active' : ''}`}
                          onClick={() => onSelectArgoView(type.key)}
                          title={type.label}
                        >
                          <Icon name={type.icon} size={15} className="nav-lead-icon" />
                          {type.label}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        <div className="nav-section">
          <div className="nav-section-title" onClick={() => onToggleNav('security')}>
            <span className={`nav-section-chevron ${navExpanded.security ? 'open' : ''}`}>
              <Icon name="chevronRight" size={13} strokeWidth={2.2} />
            </span>
            <Icon name="shield" size={15} className="nav-lead-icon" />
            Security Center
          </div>
          {navExpanded.security && (
            <div className="nav-items">
              {securityTypes.map((type) => (
                <div
                  key={type.key}
                  className={`nav-item ${resourceType === 'security' && securityView === type.key ? 'active' : ''}`}
                  onClick={() => onSelectSecurityView(type.key)}
                  title={type.label}
                >
                  <Icon name={type.icon} size={15} className="nav-lead-icon" />
                  {type.label}
                </div>
              ))}
            </div>
          )}
        </div>

        <CustomResourceTree selection={crSelection} onSelect={onSelectCustomResource} />
      </div>
    </nav>
  );
}
