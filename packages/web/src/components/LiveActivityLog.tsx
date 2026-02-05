import type { ToolEvent } from '../App';
import './LiveActivityLog.css';

interface LiveActivityLogProps {
  events: ToolEvent[];
}

export function LiveActivityLog({ events }: LiveActivityLogProps) {
  return (
    <aside className="live-activity">
      <div className="activity-header">
        <h3>🔧 Live Activity</h3>
        <span className="event-count">{events.length}</span>
      </div>

      <div className="events-list">
        {events.length === 0 ? (
          <div className="empty-events">
            <p>Tool executions will appear here</p>
          </div>
        ) : (
          events.slice().reverse().map((event) => (
            <div
              key={event.id}
              className={`event-item ${event.type} animate-slide-in`}
            >
              <div className="event-icon">
                {event.type === 'start' ? '⏳' : event.result?.success ? '✅' : '❌'}
              </div>
              <div className="event-content">
                <div className="event-tool">{event.tool}</div>
                <div className="event-time">
                  {event.timestamp.toLocaleTimeString()}
                </div>
                {event.type === 'start' && event.args && (
                  <pre className="event-args">
                    {JSON.stringify(event.args, null, 2).slice(0, 200)}
                  </pre>
                )}
                {event.type === 'end' && event.result && (
                  <div className={`event-result ${event.result.success ? 'success' : 'error'}`}>
                    {event.result.success
                      ? event.result.output.slice(0, 100)
                      : event.result.error
                    }
                    {event.result.output.length > 100 && '...'}
                  </div>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </aside>
  );
}
