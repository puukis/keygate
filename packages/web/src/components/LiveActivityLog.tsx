import { useState } from 'react';
import type { ToolEvent } from '../App';
import './LiveActivityLog.css';

interface LiveActivityLogProps {
  events: ToolEvent[];
}

const MAX_VISIBLE_EVENTS = 24;

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}...`;
}

export function LiveActivityLog({ events }: LiveActivityLogProps) {
  const [showProviderEvents, setShowProviderEvents] = useState(false);
  const [showAllEvents, setShowAllEvents] = useState(false);

  const orderedEvents = events.slice().reverse();
  const providerEventCount = events.filter((event) => event.type === 'provider').length;
  const filteredEvents = showProviderEvents
    ? orderedEvents
    : orderedEvents.filter((event) => event.type !== 'provider');
  const hasOverflow = filteredEvents.length > MAX_VISIBLE_EVENTS;
  const collapsedEventCount = Math.max(0, filteredEvents.length - MAX_VISIBLE_EVENTS);
  const visibleEvents = showAllEvents
    ? filteredEvents
    : filteredEvents.slice(0, MAX_VISIBLE_EVENTS);

  return (
    <aside className="live-activity">
      <div className="activity-header">
        <h3>🔧 Live Activity</h3>
        <span className="event-count">{events.length}</span>
      </div>

      <div className="activity-controls">
        <button
          type="button"
          className={`activity-toggle ${showProviderEvents ? 'active' : ''}`}
          onClick={() => setShowProviderEvents((prev) => !prev)}
        >
          {showProviderEvents ? 'Hide Provider Events' : 'Show Provider Events'}
        </button>
        {!showProviderEvents && providerEventCount > 0 && (
          <span className="provider-summary">
            {providerEventCount} provider notifications hidden
          </span>
        )}
      </div>

      <div className="events-list">
        {visibleEvents.length === 0 ? (
          <div className="empty-events">
            <p>
              {events.length === 0
                ? 'Tool and provider events will appear here'
                : 'No tool events yet. Enable provider events to inspect low-level notifications.'}
            </p>
          </div>
        ) : (
          visibleEvents.map((event) => {
            const icon = event.type === 'start'
              ? '⏳'
              : event.type === 'provider'
                ? '📡'
                : event.result?.success
                  ? '✅'
                  : '❌';
            const argsPreview = event.args
              ? truncateText(JSON.stringify(event.args, null, 2), 220)
              : undefined;
            const resultPreview = event.type === 'end' && event.result
              ? truncateText(
                event.result.success
                  ? event.result.output
                  : (event.result.error ?? 'Request failed'),
                140,
              )
              : undefined;
            const resultSuccess = event.result?.success ?? false;

            return (
              <div
                key={event.id}
                className={`event-item ${event.type} animate-slide-in`}
              >
                <div className="event-icon">{icon}</div>
                <div className="event-content">
                  <div className="event-tool">{event.tool}</div>
                  <div className="event-time">
                    {event.timestamp.toLocaleTimeString()}
                  </div>
                  {event.detail && (
                    <div className="event-detail">{event.detail}</div>
                  )}
                  {argsPreview && (
                    <pre className="event-args">
                      {argsPreview}
                    </pre>
                  )}
                  {resultPreview && (
                    <div className={`event-result ${resultSuccess ? 'success' : 'error'}`}>
                      {resultPreview}
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}

        {hasOverflow && (
          <button
            type="button"
            className="activity-more-btn"
            onClick={() => setShowAllEvents((prev) => !prev)}
          >
            {showAllEvents ? 'Show fewer events' : `Show ${collapsedEventCount} more`}
          </button>
        )}
      </div>
    </aside>
  );
}
