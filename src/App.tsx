import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

type GoogleSession = {
  email: string;
  access_token: string;
};

type ConnectedAccount = {
  email: string;
  accessToken: string;
  color: string;
};

type CalendarEvent = {
  id: string;
  summary?: string;
  location?: string;
  htmlLink?: string;
  sourceEmail: string;
  sourceColor: string;
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

const ACCOUNT_COLORS = [
  "#2f6fe7",
  "#d94841",
  "#2a9d8f",
  "#f59e0b",
  "#7c3aed",
  "#0f766e",
  "#ef4444",
  "#1d4ed8",
];

function colorForEmail(email: string): string {
  let hash = 0;
  for (let i = 0; i < email.length; i += 1) {
    hash = (hash * 31 + email.charCodeAt(i)) % 2147483647;
  }
  return ACCOUNT_COLORS[Math.abs(hash) % ACCOUNT_COLORS.length];
}

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

function normalizeAccount(session: GoogleSession): ConnectedAccount {
  return {
    email: session.email,
    accessToken: session.access_token,
    color: colorForEmail(session.email),
  };
}

function eventStartMs(event: CalendarEvent): number {
  if (event.start?.dateTime) {
    return new Date(event.start.dateTime).getTime();
  }
  if (event.start?.date) {
    return parseDayKey(event.start.date).getTime();
  }
  return Number.MAX_SAFE_INTEGER;
}

export default function App() {
  const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;
  const clientSecret = import.meta.env.VITE_GOOGLE_CLIENT_SECRET;
  const redirectUri = import.meta.env.VITE_GOOGLE_REDIRECT_URI;

  const [accounts, setAccounts] = useState<ConnectedAccount[]>([]);
  const [activeAccountEmail, setActiveAccountEmail] = useState<string>("");
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

  const fetchEvents = useCallback(async (accountsToLoad: ConnectedAccount[], monthStart: Date) => {
    if (accountsToLoad.length === 0) {
      setEvents([]);
      return;
    }

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

      const settled = await Promise.allSettled(
        accountsToLoad.map(async (account) => {
          const response = await fetch(
            `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params.toString()}`,
            {
              headers: {
                Authorization: `Bearer ${account.accessToken}`,
              },
            }
          );

          if (!response.ok) {
            const payload = await response.json().catch(() => null);
            const message = payload?.error?.message ?? "Failed to fetch events.";
            throw new Error(`${account.email}: ${message}`);
          }

          const payload = (await response.json()) as {
            items?: Array<Omit<CalendarEvent, "sourceEmail" | "sourceColor">>;
          };

          return (payload.items ?? []).map((event) => ({
            ...event,
            sourceEmail: account.email,
            sourceColor: account.color,
          }));
        })
      );

      const merged: CalendarEvent[] = [];
      const errors: string[] = [];

      for (const result of settled) {
        if (result.status === "fulfilled") {
          merged.push(...result.value);
        } else {
          errors.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
        }
      }

      merged.sort((a, b) => eventStartMs(a) - eventStartMs(b));
      setEvents(merged);

      if (errors.length > 0) {
        setError(`Some accounts failed to sync: ${errors.join(" | ")}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unexpected sync error");
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
    const restoreSessions = async () => {
      try {
        const restored = await invoke<GoogleSession[]>("restore_google_sessions", {
          clientId,
          clientSecret: clientSecret || null,
        });

        if (!alive) {
          return;
        }

        const normalized = restored.map(normalizeAccount);
        setAccounts(normalized);
        if (normalized.length > 0) {
          setActiveAccountEmail(normalized[0].email);
        }
      } catch (err) {
        if (!alive) {
          return;
        }
        const message = err instanceof Error ? err.message : typeof err === "string" ? err : JSON.stringify(err);
        setError(message);
      } finally {
        if (alive) {
          setIsRestoringSession(false);
        }
      }
    };

    void restoreSessions();
    return () => {
      alive = false;
    };
  }, [clientId, clientSecret]);

  useEffect(() => {
    if (accounts.length === 0) {
      setEvents([]);
      return;
    }

    void fetchEvents(accounts, currentMonth);
  }, [accounts, currentMonth, fetchEvents]);

  useEffect(() => {
    if (accounts.length === 0) {
      setActiveAccountEmail("");
      return;
    }

    if (!accounts.some((account) => account.email === activeAccountEmail)) {
      setActiveAccountEmail(accounts[0].email);
    }
  }, [accounts, activeAccountEmail]);

  const connectGoogleAccount = async () => {
    if (!clientId) {
      setError("Missing VITE_GOOGLE_CLIENT_ID in .env");
      return;
    }

    setIsAuthenticating(true);
    setError(null);

    try {
      const session = await invoke<GoogleSession>("login_with_google", {
        clientId,
        clientSecret: clientSecret || null,
        redirectUri: redirectUri || null,
      });

      const normalized = normalizeAccount(session);
      setAccounts((prev) => {
        const existing = prev.find((account) => account.email === normalized.email);
        if (existing) {
          return prev.map((account) =>
            account.email === normalized.email
              ? { ...account, accessToken: normalized.accessToken, color: normalized.color }
              : account
          );
        }
        return [...prev, normalized];
      });
      setActiveAccountEmail(normalized.email);
    } catch (err) {
      const message = err instanceof Error ? err.message : typeof err === "string" ? err : JSON.stringify(err);
      setError(message);
    } finally {
      setIsAuthenticating(false);
    }
  };

  const disconnectAccount = async (email: string) => {
    try {
      await invoke("clear_google_session", { email });
    } catch {
      // Keep local sign-out behavior even if secure storage cleanup fails.
    }

    setAccounts((prev) => prev.filter((account) => account.email !== email));
    setError(null);
  };

  const monthGrid = useMemo(() => buildMonthGrid(currentMonth), [currentMonth]);
  const todayKey = useMemo(() => toDayKey(new Date()), []);

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

    const account = accounts.find((entry) => entry.email === activeAccountEmail);
    if (!account) {
      setCreateEventError("Select an account before creating an event.");
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
            Authorization: `Bearer ${account.accessToken}`,
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
      await fetchEvents(accounts, currentMonth);
    } catch (err) {
      setCreateEventError(err instanceof Error ? err.message : "Failed to create event.");
    } finally {
      setIsCreatingEvent(false);
    }
  };

  return (
    <main className="app-shell">
      <h1>G-Calendar</h1>

      {isRestoringSession ? (
        <section className="card">
          <p>Restoring saved Google sessions...</p>
        </section>
      ) : accounts.length === 0 ? (
        <section className="card">
          <p>Connect one or more Google accounts to load monthly view.</p>
          <button onClick={connectGoogleAccount} disabled={isAuthenticating}>
            {isAuthenticating ? "Waiting for Google sign-in..." : "Connect Google Account"}
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
            <button
              onClick={() => {
                const now = new Date();
                setCurrentMonth(getMonthStart(now));
                setSelectedDayKey(toDayKey(now));
              }}
              className="secondary"
            >
              Today
            </button>
            <button onClick={() => void fetchEvents(accounts, currentMonth)} disabled={isLoading}>
              {isLoading ? "Syncing..." : "Sync"}
            </button>
            <button onClick={connectGoogleAccount} disabled={isAuthenticating}>
              {isAuthenticating ? "Connecting..." : "Add Account"}
            </button>
          </div>

          <div className="account-list">
            {accounts.map((account) => (
              <div
                key={account.email}
                className={`account-chip ${activeAccountEmail === account.email ? "active" : ""}`}
                onClick={() => setActiveAccountEmail(account.email)}
                role="button"
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setActiveAccountEmail(account.email);
                  }
                }}
              >
                <span className="account-dot" style={{ backgroundColor: account.color }} />
                <span className="account-email">{account.email}</span>
                <button
                  className="chip-remove"
                  onClick={(event) => {
                    event.stopPropagation();
                    void disconnectAccount(account.email);
                  }}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>

          {error ? <p className="error">{error}</p> : null}

          <div className="calendar-layout">
            <div className="calendar-pane">
              <div className="weekday-row">
                {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((label) => (
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
                  const isToday = key === todayKey;

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
                      className={`day-cell ${cell.inCurrentMonth ? "" : "day-muted"} ${isSelected ? "day-selected" : ""} ${isToday ? "day-today" : ""}`}
                    >
                      <div className="day-number">{cell.date.getDate()}</div>
                      <ul className="day-events">
                        {dayEvents.map((event) => (
                          <li
                            key={`${event.sourceEmail}:${event.id}`}
                            className="day-event-item"
                            style={{ borderLeftColor: event.sourceColor }}
                          >
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
                    Account
                    <select
                      value={activeAccountEmail}
                      onChange={(event) => setActiveAccountEmail(event.target.value)}
                    >
                      {accounts.map((account) => (
                        <option key={account.email} value={account.email}>
                          {account.email}
                        </option>
                      ))}
                    </select>
                  </label>

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
                  <button type="submit" disabled={isCreatingEvent || accounts.length === 0}>
                    {isCreatingEvent ? "Creating..." : "Create Event"}
                  </button>
                </form>
              ) : null}

              {selectedDayEvents.length === 0 ? (
                <p>No events on this day.</p>
              ) : (
                <ul className="detail-events">
                  {selectedDayEvents.map((event) => (
                    <li
                      key={`${event.sourceEmail}:${event.id}`}
                      className="detail-event-item"
                      style={{ borderLeftColor: event.sourceColor }}
                    >
                      <strong>{event.summary ?? "Untitled event"}</strong>
                      <p>{formatEventTime(event)}</p>
                      <p className="detail-meta">
                        <span className="account-dot" style={{ backgroundColor: event.sourceColor }} />
                        {event.sourceEmail}
                      </p>
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
