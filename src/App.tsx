import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

type CalendarEvent = {
  id: string;
  summary?: string;
  location?: string;
  htmlLink?: string;
  start?: {
    date?: string;
    dateTime?: string;
  };
  end?: {
    date?: string;
    dateTime?: string;
  };
};

type MonthCell = {
  date: Date;
  inCurrentMonth: boolean;
};

type NewEventForm = {
  summary: string;
  allDay: boolean;
  startTime: string;
  endTime: string;
  location: string;
  description: string;
};

function getMonthStart(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function formatEventTime(event: CalendarEvent): string {
  if (event.start?.date) {
    return "All day";
  }

  if (!event.start?.dateTime) {
    return "No time";
  }

  return new Intl.DateTimeFormat(undefined, {
    timeStyle: "short",
  }).format(new Date(event.start.dateTime));
}

function getEventDayKey(event: CalendarEvent): string | null {
  if (event.start?.date) {
    return event.start.date;
  }

  if (event.start?.dateTime) {
    return toDayKey(new Date(event.start.dateTime));
  }

  return null;
}

function toDayKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseDayKey(dayKey: string): Date {
  const [year, month, day] = dayKey.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function buildDateTimeIso(dayKey: string, time: string): string {
  const [year, month, day] = dayKey.split("-").map(Number);
  const [hours, minutes] = time.split(":").map(Number);
  return new Date(year, month - 1, day, hours, minutes, 0, 0).toISOString();
}

function nextDayKey(dayKey: string): string {
  const date = parseDayKey(dayKey);
  date.setDate(date.getDate() + 1);
  return toDayKey(date);
}

function buildMonthGrid(monthStart: Date): MonthCell[] {
  const firstDay = new Date(monthStart);
  const startWeekday = firstDay.getDay();
  const gridStart = new Date(firstDay);
  gridStart.setDate(firstDay.getDate() - startWeekday);

  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(gridStart);
    date.setDate(gridStart.getDate() + index);
    return {
      date,
      inCurrentMonth: date.getMonth() === monthStart.getMonth(),
    };
  });
}

export default function App() {
  const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;
  const clientSecret = import.meta.env.VITE_GOOGLE_CLIENT_SECRET;
  const redirectUri = import.meta.env.VITE_GOOGLE_REDIRECT_URI;

  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [isRestoringSession, setIsRestoringSession] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentMonth, setCurrentMonth] = useState(getMonthStart(new Date()));
  const [selectedDayKey, setSelectedDayKey] = useState(toDayKey(new Date()));
  const [showCreateEventForm, setShowCreateEventForm] = useState(false);
  const [isCreatingEvent, setIsCreatingEvent] = useState(false);
  const [createEventError, setCreateEventError] = useState<string | null>(null);
  const [newEventForm, setNewEventForm] = useState<NewEventForm>({
    summary: "",
    allDay: false,
    startTime: "09:00",
    endTime: "10:00",
    location: "",
    description: "",
  });

  const fetchEvents = useCallback(async (token: string, monthStart: Date) => {
    setIsLoading(true);
    setError(null);

    try {
      const rangeStart = new Date(monthStart.getFullYear(), monthStart.getMonth(), 1);
      const rangeEnd = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 1);

      const params = new URLSearchParams({
        maxResults: "2500",
        orderBy: "startTime",
        singleEvents: "true",
        timeMin: rangeStart.toISOString(),
        timeMax: rangeEnd.toISOString(),
      });

      const response = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params.toString()}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );

      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        const message = payload?.error?.message ?? "Failed to fetch events from Google Calendar.";
        throw new Error(message);
      }

      const payload = (await response.json()) as { items?: CalendarEvent[] };
      setEvents(payload.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unexpected error");
      setEvents([]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!clientId) {
      setIsRestoringSession(false);
      return;
    }

    let alive = true;
    const restoreSession = async () => {
      try {
        const token = await invoke<{ access_token: string }>("restore_google_session", {
          clientId,
          clientSecret: clientSecret || null,
        });
        if (alive) {
          setAccessToken(token.access_token);
          setError(null);
        }
      } catch (err) {
        if (!alive) {
          return;
        }
        const message = err instanceof Error ? err.message : typeof err === "string" ? err : JSON.stringify(err);
        if (!message.includes("No saved Google session")) {
          setError(message);
        }
      } finally {
        if (alive) {
          setIsRestoringSession(false);
        }
      }
    };

    void restoreSession();

    return () => {
      alive = false;
    };
  }, [clientId, clientSecret]);

  useEffect(() => {
    if (!accessToken) {
      setEvents([]);
      return;
    }

    void fetchEvents(accessToken, currentMonth);
  }, [accessToken, currentMonth, fetchEvents]);

  const connectGoogleCalendar = async () => {
    if (!clientId) {
      setError("Missing VITE_GOOGLE_CLIENT_ID in .env");
      return;
    }

    setIsAuthenticating(true);
    setError(null);

    try {
      const token = await invoke<{ access_token: string }>("login_with_google", {
        clientId,
        clientSecret: clientSecret || null,
        redirectUri: redirectUri || null,
      });
      setAccessToken(token.access_token);
    } catch (err) {
      const message = err instanceof Error ? err.message : typeof err === "string" ? err : JSON.stringify(err);
      setError(message);
    } finally {
      setIsAuthenticating(false);
    }
  };

  const disconnect = async () => {
    try {
      await invoke("clear_google_session");
    } catch {
      // Keep local sign-out behavior even if secure storage cleanup fails.
    }
    setAccessToken(null);
    setEvents([]);
    setError(null);
  };

  const monthGrid = useMemo(() => buildMonthGrid(currentMonth), [currentMonth]);

  const eventsByDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const event of events) {
      const key = getEventDayKey(event);
      if (!key) continue;
      const bucket = map.get(key);
      if (bucket) {
        bucket.push(event);
      } else {
        map.set(key, [event]);
      }
    }
    return map;
  }, [events]);

  const monthTitle = useMemo(
    () =>
      new Intl.DateTimeFormat(undefined, {
        month: "long",
        year: "numeric",
      }).format(currentMonth),
    [currentMonth]
  );

  const selectedDateLabel = useMemo(() => {
    return new Intl.DateTimeFormat(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    }).format(parseDayKey(selectedDayKey));
  }, [selectedDayKey]);

  const selectedDayEvents = useMemo(
    () => eventsByDay.get(selectedDayKey) ?? [],
    [eventsByDay, selectedDayKey]
  );

  const createEvent = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!accessToken) {
      setCreateEventError("You are not authenticated.");
      return;
    }

    const summary = newEventForm.summary.trim();
    if (!summary) {
      setCreateEventError("Event title is required.");
      return;
    }

    setIsCreatingEvent(true);
    setCreateEventError(null);
    try {
      let requestBody: Record<string, unknown> = {
        summary,
      };

      if (newEventForm.location.trim()) {
        requestBody.location = newEventForm.location.trim();
      }
      if (newEventForm.description.trim()) {
        requestBody.description = newEventForm.description.trim();
      }

      if (newEventForm.allDay) {
        requestBody = {
          ...requestBody,
          start: { date: selectedDayKey },
          end: { date: nextDayKey(selectedDayKey) },
        };
      } else {
        const startIso = buildDateTimeIso(selectedDayKey, newEventForm.startTime);
        const endIso = buildDateTimeIso(selectedDayKey, newEventForm.endTime);
        if (new Date(endIso) <= new Date(startIso)) {
          throw new Error("End time must be after start time.");
        }
        requestBody = {
          ...requestBody,
          start: { dateTime: startIso },
          end: { dateTime: endIso },
        };
      }

      const response = await fetch(
        "https://www.googleapis.com/calendar/v3/calendars/primary/events",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(requestBody),
        }
      );

      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        const message = payload?.error?.message ?? "Failed to create calendar event.";
        throw new Error(message);
      }

      setShowCreateEventForm(false);
      setNewEventForm({
        summary: "",
        allDay: false,
        startTime: "09:00",
        endTime: "10:00",
        location: "",
        description: "",
      });
      await fetchEvents(accessToken, currentMonth);
    } catch (err) {
      setCreateEventError(err instanceof Error ? err.message : "Failed to create event.");
    } finally {
      setIsCreatingEvent(false);
    }
  };

  return (
    <main className="app-shell">
      <h1>Google Calendar Sync</h1>

      {isRestoringSession ? (
        <section className="card">
          <p>Restoring your saved Google session...</p>
        </section>
      ) : !accessToken ? (
        <section className="card">
          <p>Connect your Google account to load monthly view.</p>
          <button onClick={connectGoogleCalendar} disabled={isAuthenticating}>
            {isAuthenticating ? "Waiting for Google sign-in..." : "Connect Google Calendar"}
          </button>
          {error ? <p className="error">{error}</p> : null}
        </section>
      ) : (
        <section className="card">
          <div className="actions month-actions">
            <button onClick={() => setCurrentMonth((prev) => new Date(prev.getFullYear(), prev.getMonth() - 1, 1))}>
              Prev
            </button>
            <h2 className="month-title">{monthTitle}</h2>
            <button onClick={() => setCurrentMonth((prev) => new Date(prev.getFullYear(), prev.getMonth() + 1, 1))}>
              Next
            </button>
            <button onClick={() => void fetchEvents(accessToken, currentMonth)} disabled={isLoading}>
              {isLoading ? "Syncing..." : "Sync"}
            </button>
            <button onClick={() => void disconnect()} className="secondary">
              Disconnect
            </button>
          </div>

          {error ? <p className="error">{error}</p> : null}

          <div className="calendar-layout">
            <div className="calendar-pane">
              <div className="weekday-row">
                {[
                  "Sun",
                  "Mon",
                  "Tue",
                  "Wed",
                  "Thu",
                  "Fri",
                  "Sat",
                ].map((label) => (
                  <div key={label} className="weekday-cell">
                    {label}
                  </div>
                ))}
              </div>

              <div className="month-grid">
                {monthGrid.map((cell) => {
                  const key = toDayKey(cell.date);
                  const dayEvents = eventsByDay.get(key) ?? [];
                  const isSelected = key === selectedDayKey;

                  return (
                    <div
                      key={key}
                      role="button"
                      tabIndex={0}
                      onClick={() => setSelectedDayKey(key)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          setSelectedDayKey(key);
                        }
                      }}
                      className={`day-cell ${cell.inCurrentMonth ? "" : "day-muted"} ${isSelected ? "day-selected" : ""}`}
                    >
                      <div className="day-number">{cell.date.getDate()}</div>
                      <ul className="day-events">
                        {dayEvents.map((event) => (
                          <li key={event.id} className="day-event-item">
                            <span className="event-time">{formatEventTime(event)}</span>
                            {event.htmlLink ? (
                              <a href={event.htmlLink} target="_blank" rel="noreferrer">
                                {event.summary ?? "Untitled event"}
                              </a>
                            ) : (
                              <span>{event.summary ?? "Untitled event"}</span>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })}
              </div>
            </div>

            <section className="day-detail">
              <h3>{selectedDateLabel}</h3>
              <div className="day-detail-actions">
                <button
                  onClick={() => {
                    setShowCreateEventForm((prev) => !prev);
                    setCreateEventError(null);
                  }}
                  className="secondary"
                >
                  {showCreateEventForm ? "Cancel" : "Add Event"}
                </button>
              </div>

              {showCreateEventForm ? (
                <form className="event-form" onSubmit={createEvent}>
                  <label>
                    Title
                    <input
                      type="text"
                      value={newEventForm.summary}
                      onChange={(event) =>
                        setNewEventForm((prev) => ({ ...prev, summary: event.target.value }))
                      }
                      required
                    />
                  </label>

                  <label className="checkbox-line">
                    <input
                      type="checkbox"
                      checked={newEventForm.allDay}
                      onChange={(event) =>
                        setNewEventForm((prev) => ({ ...prev, allDay: event.target.checked }))
                      }
                    />
                    All day
                  </label>

                  {!newEventForm.allDay ? (
                    <div className="time-grid">
                      <label>
                        Start
                        <input
                          type="time"
                          value={newEventForm.startTime}
                          onChange={(event) =>
                            setNewEventForm((prev) => ({ ...prev, startTime: event.target.value }))
                          }
                          required
                        />
                      </label>
                      <label>
                        End
                        <input
                          type="time"
                          value={newEventForm.endTime}
                          onChange={(event) =>
                            setNewEventForm((prev) => ({ ...prev, endTime: event.target.value }))
                          }
                          required
                        />
                      </label>
                    </div>
                  ) : null}

                  <label>
                    Location
                    <input
                      type="text"
                      value={newEventForm.location}
                      onChange={(event) =>
                        setNewEventForm((prev) => ({ ...prev, location: event.target.value }))
                      }
                    />
                  </label>

                  <label>
                    Notes
                    <textarea
                      rows={3}
                      value={newEventForm.description}
                      onChange={(event) =>
                        setNewEventForm((prev) => ({ ...prev, description: event.target.value }))
                      }
                    />
                  </label>

                  {createEventError ? <p className="error">{createEventError}</p> : null}
                  <button type="submit" disabled={isCreatingEvent}>
                    {isCreatingEvent ? "Creating..." : "Create Event"}
                  </button>
                </form>
              ) : null}

              {selectedDayEvents.length === 0 ? (
                <p>No events on this day.</p>
              ) : (
                <ul className="detail-events">
                  {selectedDayEvents.map((event) => (
                    <li key={event.id} className="detail-event-item">
                      <strong>{event.summary ?? "Untitled event"}</strong>
                      <p>{formatEventTime(event)}</p>
                      {event.location ? <p>{event.location}</p> : null}
                      {event.htmlLink ? (
                        <a href={event.htmlLink} target="_blank" rel="noreferrer">
                          Open in Google Calendar
                        </a>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </section>
      )}
    </main>
  );
}
