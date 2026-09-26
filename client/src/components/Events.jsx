import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import Icon from './Icons';
import Loader from './Loader';

export default function Events({ active = true, namespace = 'all', refreshSignal = 0 }) {
  const [eventSnapshots, setEventSnapshots] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const fetchIdRef = useRef(0);
  const cacheKey = namespace || 'all';
  const hasCachedEvents = Object.prototype.hasOwnProperty.call(eventSnapshots, cacheKey);
  const events = eventSnapshots[cacheKey] || [];

  useEffect(() => {
    if (!active) return;
    fetchEvents({ silent: hasCachedEvents });
    // The cache check is intentionally read when the active namespace changes.
    // Snapshot updates themselves must not start another request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, namespace, refreshSignal]);

  const fetchEvents = async ({ silent = false } = {}) => {
    const fetchId = ++fetchIdRef.current;
    if (!silent) setLoading(true);
    setError(null);
    try {
      const ns = namespace || 'all';
      const response = await axios.get(`/api/events/${ns}`);
      const result = response.data.events || [];
      setEventSnapshots((current) => {
        const recent = Object.entries(current).filter(([key]) => key !== cacheKey);
        return Object.fromEntries([...recent.slice(-7), [cacheKey, result]]);
      });
      if (fetchId === fetchIdRef.current) setError(null);
    } catch (err) {
      if (fetchId === fetchIdRef.current && !silent) {
        setError(`Failed to fetch events: ${err.message}`);
      }
    } finally {
      if (fetchId === fetchIdRef.current) setLoading(false);
    }
  };

  const formatAge = (seconds) => {
    if (seconds < 60) return `${Math.floor(seconds)}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
    return `${Math.floor(seconds / 86400)}d`;
  };

  return (
    <div className="events-container">
      <div className="events-toolbar">
        <h3>Cluster Events</h3>
      </div>

      <div className="events-content">
        {loading && !hasCachedEvents && <Loader label="Loading events…" />}
        {error && <div className="events-error">{error}</div>}
        {!loading && !error && events.length === 0 && (
          <div className="events-empty">No recent events</div>
        )}
        {!error && events.length > 0 && (
          <table className="events-table">
            <thead>
              <tr>
                <th>Message</th>
                <th>Namespace</th>
                <th>Type</th>
                <th>Reason</th>
                <th>Object</th>
                <th>Count</th>
                <th>Age</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event, idx) => (
                <tr key={idx} className={`event-row event-${event.type.toLowerCase()}`}>
                  <td className="event-message">{event.message}</td>
                  <td className="event-namespace">{event.namespace}</td>
                  <td className="event-type">
                    <span className={`event-type-badge event-type-${event.type.toLowerCase()}`}>
                      {event.type}
                    </span>
                  </td>
                  <td className="event-reason">{event.reason}</td>
                  <td className="event-object">{event.involvedObject}</td>
                  <td className="event-count">{event.count}</td>
                  <td className="event-age">{formatAge(event.age)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
