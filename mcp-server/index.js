#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const ENDPOINT = process.env.COMMANDDECK_URL || 'https://commanddeck.pages.dev/api/state';
const TOKEN    = process.env.COMMANDDECK_TOKEN;

if (!TOKEN) {
  process.stderr.write('COMMANDDECK_TOKEN env var is required\n');
  process.exit(1);
}

async function fetchState() {
  const r = await fetch(ENDPOINT, {
    cache: 'no-store',
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (r.status === 401) throw new Error('Unauthorized — check COMMANDDECK_TOKEN');
  if (!r.ok) throw new Error(`API returned ${r.status}`);
  return r.json();
}

// ── helpers ──────────────────────────────────────────────────────────────────

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function habitSummary(state) {
  const today = todayStr();
  return (state.habits || []).map(h => {
    const totalDays  = Object.keys(h.completions || {}).length;
    const todayDone  = !!(h.completions || {})[today];
    const streak     = computeStreak(h.completions || {});
    return {
      id:        h.id,
      name:      h.name,
      frequency: h.frequency,
      todayDone,
      streak,
      totalCompletions: totalDays,
    };
  });
}

function computeStreak(completions) {
  let streak = 0;
  const d = new Date();
  while (true) {
    const key = d.toISOString().slice(0, 10);
    if (!completions[key]) break;
    streak++;
    d.setDate(d.getDate() - 1);
  }
  return streak;
}

function calendarSummary(state, daysAhead = 7) {
  const now    = Date.now();
  const cutoff = now + daysAhead * 86_400_000;
  return (state.calendarEvents || [])
    .filter(e => {
      const t = new Date(e.start || e.date).getTime();
      return t >= now - 86_400_000 && t <= cutoff;
    })
    .sort((a, b) => new Date(a.start || a.date) - new Date(b.start || b.date))
    .map(e => ({
      id:    e.id,
      title: e.title,
      start: e.start || e.date,
      end:   e.end,
      allDay: e.allDay,
      color: e.color,
    }));
}

function taskSummary(state) {
  return (state.tasks || []).map(t => ({
    id:        t.id,
    title:     t.title,
    quadrant:  t.quadrant,
    done:      !!t.done,
    dueDate:   t.dueDate,
    priority:  t.priority,
  }));
}

function focusSummary(state) {
  return {
    currentTask:      state.focusTask  || null,
    pomodoroSettings: state.pomodoro   || null,
    sessions:         (state.focusSessions || []).slice(-10),
  };
}

// ── server ───────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'commanddeck',
  version: '1.0.0',
});

server.tool(
  'get_habits',
  'Returns all habits with today\'s completion status, current streak, and total completions.',
  {},
  async () => {
    const state = await fetchState();
    return { content: [{ type: 'text', text: JSON.stringify(habitSummary(state), null, 2) }] };
  }
);

server.tool(
  'get_calendar',
  'Returns upcoming calendar events. Optional daysAhead parameter (default 7).',
  { daysAhead: z.number().int().min(1).max(90).optional() },
  async ({ daysAhead = 7 }) => {
    const state = await fetchState();
    return { content: [{ type: 'text', text: JSON.stringify(calendarSummary(state, daysAhead), null, 2) }] };
  }
);

server.tool(
  'get_tasks',
  'Returns all tasks from the Eisenhower matrix with quadrant, done status, and due date.',
  {},
  async () => {
    const state = await fetchState();
    return { content: [{ type: 'text', text: JSON.stringify(taskSummary(state), null, 2) }] };
  }
);

server.tool(
  'get_focus',
  'Returns the current focus task, Pomodoro settings, and last 10 focus sessions.',
  {},
  async () => {
    const state = await fetchState();
    return { content: [{ type: 'text', text: JSON.stringify(focusSummary(state), null, 2) }] };
  }
);

server.tool(
  'get_full_state',
  'Returns the complete CommandDeck state. Use sparingly — prefer the specific tools above for targeted queries.',
  {},
  async () => {
    const state = await fetchState();
    return { content: [{ type: 'text', text: JSON.stringify(state, null, 2) }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
