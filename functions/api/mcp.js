/* ============================================================
   Command Deck — /api/mcp
   Remote MCP server (Streamable HTTP transport, MCP 2024-11-05).
   Add to claude.ai › Settings › Integrations as:
     URL:  https://commanddeck.huntah.co.uk/api/mcp
   OAuth flow handled by /oauth/* endpoints.
   Fallback (Claude Desktop): append ?key=<SYNC_TOKEN> to the URL.
   ============================================================ */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
};

const jsonResp = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
  });

// Same constant-time HMAC comparison as state.js
const tokenOk = async (given, env) => {
  const expect = env.SYNC_TOKEN || '';
  if (!given || !expect) return false;
  const key = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.sign('HMAC', key, enc.encode(given)),
    crypto.subtle.sign('HMAC', key, enc.encode(expect)),
  ]);
  const ua = new Uint8Array(a), ub = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < ua.length; i++) diff |= ua[i] ^ ub[i];
  return diff === 0;
};

const extractToken = (request) => {
  const auth = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (auth) return auth;
  return new URL(request.url).searchParams.get('key') || '';
};

// ── D1 ────────────────────────────────────────────────────────────────────────

async function loadState(env) {
  const row = await env.DB.prepare('SELECT data FROM state WHERE id = 1').first();
  if (!row?.data) return {};
  try { return JSON.parse(row.data); } catch { return {}; }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const todayStr = () => new Date().toISOString().slice(0, 10);

function computeStreak(completions) {
  let streak = 0;
  const d = new Date();
  while (completions[d.toISOString().slice(0, 10)]) {
    streak++;
    d.setDate(d.getDate() - 1);
  }
  return streak;
}

function buildHabits(state) {
  const today = todayStr();
  return (state.habits || []).map(h => ({
    name:             h.name,
    frequency:        h.frequency,
    todayDone:        !!(h.completions || {})[today],
    streak:           computeStreak(h.completions || {}),
    totalCompletions: Object.keys(h.completions || {}).length,
  }));
}

function buildCalendar(state, daysAhead = 7) {
  const now    = Date.now();
  const cutoff = now + Math.min(daysAhead, 90) * 86_400_000;
  return (state.calendarEvents || [])
    .filter(e => {
      const t = new Date(e.start || e.date).getTime();
      return t >= now - 86_400_000 && t <= cutoff;
    })
    .sort((a, b) => new Date(a.start || a.date) - new Date(b.start || b.date))
    .map(e => ({ title: e.title, start: e.start || e.date, end: e.end, allDay: !!e.allDay }));
}

function buildTasks(state) {
  return (state.tasks || []).map(t => ({
    title:    t.title,
    quadrant: t.quadrant,
    done:     !!t.done,
    dueDate:  t.dueDate || null,
  }));
}

function buildFocus(state) {
  return {
    currentTask:      state.focusTask  || null,
    pomodoroSettings: state.pomodoro   || null,
    recentSessions:   (state.focusSessions || []).slice(-10),
  };
}

// ── Tool registry ─────────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'get_habits',
    description: "Returns all habits with today's completion status, current streak, and total completions.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_calendar',
    description: 'Returns upcoming calendar events, sorted by date.',
    inputSchema: {
      type: 'object',
      properties: {
        daysAhead: { type: 'number', description: 'How many days ahead to include (default 7, max 90)' },
      },
    },
  },
  {
    name: 'get_tasks',
    description: 'Returns all Eisenhower matrix tasks with quadrant (urgentImportant, notUrgentImportant, urgentNotImportant, notUrgentNotImportant), done status, and due date.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_focus',
    description: 'Returns the current focus task, Pomodoro timer settings, and last 10 focus sessions.',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function callTool(name, args, env) {
  const state = await loadState(env);
  switch (name) {
    case 'get_habits':   return buildHabits(state);
    case 'get_calendar': return buildCalendar(state, args?.daysAhead);
    case 'get_tasks':    return buildTasks(state);
    case 'get_focus':    return buildFocus(state);
    default: throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32601 });
  }
}

// ── JSON-RPC dispatcher ───────────────────────────────────────────────────────

async function dispatch(msg, env) {
  const { id, method, params } = msg;

  // Notifications (no id) require no response
  if (id === undefined || id === null) return null;

  try {
    switch (method) {
      case 'initialize':
        return {
          jsonrpc: '2.0', id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'commanddeck', version: '1.0.0' },
          },
        };

      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };

      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools: TOOLS } };

      case 'tools/call': {
        const { name, arguments: args } = params || {};
        const data = await callTool(name, args || {}, env);
        return {
          jsonrpc: '2.0', id,
          result: { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] },
        };
      }

      default:
        return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } };
    }
  } catch (err) {
    return {
      jsonrpc: '2.0', id,
      error: { code: err.code || -32603, message: err.message || 'Internal error' },
    };
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  if (!await tokenOk(extractToken(request), env)) {
    return jsonResp({ error: 'Unauthorized' }, 401);
  }

  if (request.method !== 'POST') {
    return jsonResp({ error: 'Method not allowed' }, 405);
  }

  let body;
  try { body = await request.json(); }
  catch { return jsonResp({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }

  // Batch support
  if (Array.isArray(body)) {
    const results = (await Promise.all(body.map(m => dispatch(m, env)))).filter(Boolean);
    if (results.length === 0) return new Response(null, { status: 204 });
    return jsonResp(results.length === 1 ? results[0] : results);
  }

  const result = await dispatch(body, env);
  return result
    ? jsonResp(result)
    : new Response(null, { status: 204 });
}
