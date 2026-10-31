import React, { useEffect, useRef, useState } from 'react';
import Icon from './Icons';
import ContextMenu from './ContextMenu';
import { MAX_GROUPS, activeTab } from '../lib/workspace';
import { tabLabel, tabScope, viewIcon } from '../lib/views';

// Split-screen workspace: side-by-side groups, each with its own tab strip and
// one visible tab. Layout changes go through `dispatch` (lib/workspace.js);
// what a tab shows is rendered by the parent via `renderTab`.

// The tab being dragged. dataTransfer can't be read during dragover, so the id
// lives here for the length of the drag.
let dragTabId = null;
const TAB_MIME = 'application/x-k8sight-tab';

// A page kept mounted inside a tab after its first visit, hidden when another
// page is showing, so switching back is instant and keeps scroll/selection.
function CachedPage({ active, children }) {
  const [mounted, setMounted] = useState(active);
  useEffect(() => { if (active) setMounted(true); }, [active]);
  if (!mounted && !active) return null;
  return <div className="cached-view-slot" hidden={!active}>{children}</div>;
}

// One tab's content. Pages it has visited stay mounted; returning to one (or
// to the tab) bumps that page's refresh signal so it updates quietly.
function TabPane({ tab, visible, focused, pageKeyFor, renderTab, refreshTick, contextKey, column, onFocus }) {
  const pageKey = pageKeyFor(tab.view);
  const [visited, setVisited] = useState(() => [pageKey]);
  const [revisits, setRevisits] = useState({});
  const last = useRef({ pageKey, visible });

  useEffect(() => {
    const prev = last.current;
    last.current = { pageKey, visible };
    if (!visible) return;
    const returning = (prev.pageKey !== pageKey && visited.includes(pageKey)) || (!prev.visible && prev.pageKey === pageKey);
    if (!visited.includes(pageKey)) setVisited((v) => [...v, pageKey]);
    else if (returning && pageKey !== 'overview' && pageKey !== 'resources' && pageKey !== 'preferences') {
      setRevisits((r) => ({ ...r, [pageKey]: (r[pageKey] || 0) + 1 }));
    }
  }, [pageKey, visible]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="ws-pane" hidden={!visible} style={{ gridColumn: column, gridRow: 2 }} onMouseDownCapture={onFocus}>
      {visited.map((pk) => (
        <CachedPage key={`${contextKey}|${pk}`} active={pk === pageKey}>
          {renderTab(tab, pk, {
            visible: visible && pk === pageKey,
            focused,
            signal: refreshTick + (revisits[pk] || 0),
          })}
        </CachedPage>
      ))}
    </div>
  );
}

function TabStrip({ state, group, index, dispatch, onNewTab, canSplit, column, onOpenInWindow }) {
  const [menu, setMenu] = useState(null); // { x, y, tab }
  const [dropAt, setDropAt] = useState(null); // insertion index while dragging over the strip
  const left = index > 0 ? state.groups[index - 1] : null;
  const right = index < state.groups.length - 1 ? state.groups[index + 1] : null;
  const focused = state.focus === group.id;
  const multi = state.groups.length > 1;

  const indexAt = (e) => {
    const tabs = [...e.currentTarget.querySelectorAll('.ws-tab')];
    const i = tabs.findIndex((el) => {
      const r = el.getBoundingClientRect();
      return e.clientX < r.left + r.width / 2;
    });
    return i < 0 ? tabs.length : i;
  };

  const menuItems = (tab) => {
    const items = [];
    if (left) items.push({ label: 'Move to the left', icon: 'arrowLeft', onClick: () => dispatch({ type: 'moveTab', tabId: tab.id, toGroupId: left.id }) });
    if (right) items.push({ label: 'Move to the right', icon: 'arrowRight', onClick: () => dispatch({ type: 'moveTab', tabId: tab.id, toGroupId: right.id }) });
    else if (group.tabs.length > 1 && state.groups.length < MAX_GROUPS) {
      items.push({ label: 'Move to a new group on the right', icon: 'splitView', onClick: () => dispatch({ type: 'moveTabToNewGroup', tabId: tab.id, ofGroupId: group.id, side: 'right' }) });
    }
    if (onOpenInWindow) items.push({ label: 'Open in new window', icon: 'newWindow', onClick: () => onOpenInWindow(tab) });
    if (items.length) items.push({ divider: true });
    items.push({ label: 'Close', icon: 'close', onClick: () => dispatch({ type: 'closeTab', tabId: tab.id, keepOne: true }) });
    if (group.tabs.length > 1) {
      items.push({ label: 'Close others', icon: 'close', onClick: () => group.tabs.filter((t) => t.id !== tab.id).forEach((t) => dispatch({ type: 'closeTab', tabId: t.id })) });
    }
    return items;
  };

  return (
    <div className={`ws-strip ${focused && multi ? 'focused' : ''}`} style={{ gridColumn: column, gridRow: 1 }}>
      <div
        className="ws-tabs"
        role="tablist"
        onDragOver={(e) => { if (!dragTabId) return; e.preventDefault(); e.stopPropagation(); setDropAt(indexAt(e)); }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDropAt(null); }}
        onDrop={(e) => {
          if (!dragTabId) return;
          e.preventDefault(); e.stopPropagation();
          dispatch({ type: 'moveTab', tabId: dragTabId, toGroupId: group.id, index: indexAt(e) });
          setDropAt(null);
        }}
      >
        {group.tabs.map((tab, i) => {
          const scope = tabScope(tab);
          const label = tabLabel(tab);
          const selected = tab.id === group.active;
          return (
            <div
              key={tab.id}
              role="tab"
              aria-selected={selected}
              tabIndex={0}
              draggable
              title={scope ? `${label}\nNamespaces: ${scope}` : label}
              className={`ws-tab ${selected ? 'active' : ''} ${dropAt === i ? 'drop-before' : ''} ${dropAt === group.tabs.length && i === group.tabs.length - 1 ? 'drop-after' : ''}`}
              onClick={() => dispatch({ type: 'activateTab', tabId: tab.id })}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); dispatch({ type: 'activateTab', tabId: tab.id }); } }}
              onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}
              onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); dispatch({ type: 'closeTab', tabId: tab.id, keepOne: true }); } }}
              onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, tab }); }}
              onDragStart={(e) => {
                dragTabId = tab.id;
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData(TAB_MIME, tab.id);
                document.body.classList.add('ws-dragging');
              }}
              onDragEnd={(e) => {
                const dropped = e.dataTransfer?.dropEffect && e.dataTransfer.dropEffect !== 'none';
                dragTabId = null; setDropAt(null); document.body.classList.remove('ws-dragging');
                // Let go outside the window: open the tab in a window of its own there.
                const outside = e.screenX < window.screenX || e.screenX > window.screenX + window.outerWidth
                  || e.screenY < window.screenY || e.screenY > window.screenY + window.outerHeight;
                if (!dropped && outside && (e.screenX || e.screenY) && onOpenInWindow) onOpenInWindow(tab, { x: e.screenX, y: e.screenY });
              }}
            >
              <Icon name={viewIcon(tab.view)} size={13} className="ws-tab-icon" />
              <span className="ws-tab-label">{label}</span>
              {scope && <span className="ws-tab-scope">{scope}</span>}
              <button
                type="button"
                className="ws-tab-close"
                aria-label={`Close ${label}`}
                onClick={(e) => { e.stopPropagation(); dispatch({ type: 'closeTab', tabId: tab.id, keepOne: true }); }}
              >
                <Icon name="close" size={11} strokeWidth={2.2} />
              </button>
            </div>
          );
        })}
      </div>
      <div className="ws-strip-actions">
        <button type="button" className="ws-strip-btn" title="New tab" aria-label="New tab" onClick={() => onNewTab(group.id)}>
          <Icon name="plus" size={14} strokeWidth={2} />
        </button>
        <button
          type="button"
          className="ws-strip-btn"
          title={canSplit ? 'Split right (⌘\\ / Ctrl+\\)' : `Up to ${MAX_GROUPS} groups`}
          aria-label="Split right"
          disabled={!canSplit}
          onClick={() => dispatch({ type: 'split', groupId: group.id })}
        >
          <Icon name="splitView" size={14} />
        </button>
        {!group.tabs.length && multi && (
          <button type="button" className="ws-strip-btn" title="Close group" aria-label="Close group" onClick={() => dispatch({ type: 'closeGroup', groupId: group.id })}>
            <Icon name="close" size={13} strokeWidth={2} />
          </button>
        )}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.tab)} onClose={() => setMenu(null)} />}
    </div>
  );
}

// Drop zones over a group's body while a tab is dragged: the middle third adds
// the tab to this group, the left/right thirds make a new group on that side.
function DropZone({ group, dispatch, column }) {
  const [zone, setZone] = useState(null);
  const zoneAt = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    return x < 1 / 3 ? 'left' : x > 2 / 3 ? 'right' : 'center';
  };
  return (
    <div
      className={`ws-drop ${zone ? `zone-${zone}` : ''}`}
      style={{ gridColumn: column, gridRow: 2 }}
      onDragOver={(e) => { if (!dragTabId) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setZone(zoneAt(e)); }}
      onDragLeave={() => setZone(null)}
      onDrop={(e) => {
        if (!dragTabId) return;
        e.preventDefault();
        const z = zoneAt(e);
        if (z === 'center') dispatch({ type: 'moveTab', tabId: dragTabId, toGroupId: group.id });
        else dispatch({ type: 'moveTabToNewGroup', tabId: dragTabId, ofGroupId: group.id, side: z });
        setZone(null);
      }}
    >
      <div className="ws-drop-hint" />
    </div>
  );
}

function Divider({ left, right, dispatch, containerRef, column }) {
  const onPointerDown = (e) => {
    e.preventDefault();
    const width = containerRef.current?.getBoundingClientRect().width || 1;
    const startX = e.clientX;
    const startLeft = left.size;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    document.body.classList.add('ws-resizing');
    const move = (ev) => dispatch({ type: 'resize', leftId: left.id, rightId: right.id, leftSize: startLeft + (ev.clientX - startX) / width });
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      document.body.classList.remove('ws-resizing');
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };
  return <div className="ws-divider" role="separator" aria-orientation="vertical" style={{ gridColumn: column, gridRow: '1 / 3' }} onPointerDown={onPointerDown} />;
}

// Laid out as one CSS grid: a column per group (with a thin divider column
// between them), the tab strips in row 1 and the bodies in row 2. Every tab's
// pane is a direct child of the grid, keyed by tab id, so moving a tab to
// another group only changes its column: it is never remounted, and a shell or
// log stream open in it keeps running.
export default function Workspace({ state, dispatch, renderTab, pageKeyFor, tabSignals, contextKey, onNewTab, onOpenInWindow = null, hideStrip = false }) {
  const containerRef = useRef(null);
  const canSplit = state.groups.length < MAX_GROUPS;
  const colOf = (i) => 2 * i + 1;
  const template = state.groups.map((g) => `minmax(0, ${g.size}fr)`).join(' 5px ');
  const focusGroup = (gid) => () => { if (state.focus !== gid) dispatch({ type: 'focusGroup', groupId: gid }); };
  // Stable order (ids grow over time) so a move doesn't shuffle the DOM.
  const panes = state.groups
    .flatMap((g, i) => g.tabs.map((tab) => ({ tab, group: g, i })))
    .sort((a, b) => (a.tab.id < b.tab.id ? -1 : 1));
  return (
    <div className={`ws ${hideStrip ? 'no-strip' : ''}`} ref={containerRef} style={{ gridTemplateColumns: template }}>
      {state.groups.map((group, i) => {
        const focused = state.focus === group.id;
        const current = activeTab(group);
        return (
          <React.Fragment key={group.id}>
            {i > 0 && <Divider left={state.groups[i - 1]} right={group} dispatch={dispatch} containerRef={containerRef} column={colOf(i) - 1} />}
            {!hideStrip && <TabStrip state={state} group={group} index={i} dispatch={dispatch} onNewTab={onNewTab} canSplit={canSplit} column={colOf(i)} onOpenInWindow={onOpenInWindow} />}
            <section
              className={`ws-body ${focused && state.groups.length > 1 ? 'focused' : ''}`}
              style={{ gridColumn: colOf(i), gridRow: 2 }}
              aria-label={current ? tabLabel(current) : 'Empty group'}
              onMouseDownCapture={focusGroup(group.id)}
            >
              {!group.tabs.length && (
                <div className="ws-empty">
                  <Icon name="splitView" size={28} strokeWidth={1.4} />
                  <p>Drag a tab here, or open one from the navigator</p>
                </div>
              )}
            </section>
            <DropZone group={group} dispatch={dispatch} column={colOf(i)} />
          </React.Fragment>
        );
      })}
      {panes.map(({ tab, group, i }) => (
        <TabPane
          key={tab.id}
          tab={tab}
          visible={tab.id === group.active}
          focused={state.focus === group.id}
          pageKeyFor={pageKeyFor}
          renderTab={renderTab}
          refreshTick={tabSignals[tab.id] || 0}
          contextKey={contextKey}
          column={colOf(i)}
          onFocus={focusGroup(group.id)}
        />
      ))}
    </div>
  );
}
