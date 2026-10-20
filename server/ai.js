// GreenLoop AI helpers — rule-based always; optional OpenAI when OPENAI_API_KEY is set
const { prisma, join, groupBy, statusCounts, sortBy, desc } = require('./db');

async function buildOpsBrief() {
  const today = new Date().toISOString().slice(0, 10);
  const month = today.slice(0, 7);

  const todays = await prisma.pickup.findMany({
    where: { scheduled_date: today, status: { not: 'rescheduled' } },
    select: { id: true, status: true, stage: true, seq: true, customer_id: true, driver_id: true, vehicle_id: true },
  });
  // COUNT(*) + SUM(status='x') — SUM over no rows is NULL in SQL, kept for the same output
  const c0 = statusCounts(todays);
  const totals = todays.length ? { total: todays.length, ...c0 } : { total: 0, pending: null, collected: null, canceled: null, overdue: null };

  let late = await join(todays.filter(p => ['pending', 'overdue'].includes(p.status)), 'customer_id', 'customer', ['name', 'branch', 'zone'], { inner: true });
  late = sortBy(late, desc(p => (p.status === 'overdue' ? 1 : 0)), p => p.seq, p => p.id).slice(0, 15)
    .map(p => ({ name: p.name, branch: p.branch, zone: p.zone, status: p.status, stage: p.stage, id: p.id }));

  const monthCancels = await join(
    await prisma.pickup.findMany({ where: { scheduled_date: { startsWith: month }, status: 'canceled' }, select: { customer_id: true, anomaly_reason: true } }),
    'customer_id', 'customer', ['name', 'branch', 'zone'], { inner: true });
  const topCancel = [...groupBy(monthCancels, p => p.customer_id + '|' + p.anomaly_reason)]   // GROUP BY customer, reason
    .map(([, list]) => ({ name: list[0].name, branch: list[0].branch, zone: list[0].zone, anomaly_reason: list[0].anomaly_reason, n: list.length }))
    .sort((a, b) => b.n - a.n).slice(0, 8);

  let withDriver = await join(todays.map(p => ({ ...p })), 'driver_id', 'user', ['full_name'], { inner: true });
  withDriver = await join(withDriver, 'vehicle_id', 'vehicle', ['fleet_number']);
  const drivers = [...groupBy(withDriver, p => p.driver_id)]
    .map(([, list]) => { const c = statusCounts(list); return { full_name: list[0].full_name, fleet_number: list[0].fleet_number, collected: c.collected, pending: c.pending, canceled: c.canceled }; })
    .sort((a, b) => b.pending - a.pending);

  const rate =
    totals.collected + totals.canceled + totals.overdue > 0
      ? Math.round(
          (100 * (totals.collected || 0)) /
            ((totals.collected || 0) + (totals.canceled || 0) + (totals.overdue || 0))
        )
      : null;

  const insights = [];
  if ((totals.overdue || 0) > 0) {
    insights.push({
      severity: 'critical',
      text: `${totals.overdue} overdue stop(s) today — prioritise dispatch or reschedule.`,
    });
  }
  if ((totals.pending || 0) > 8) {
    insights.push({
      severity: 'warning',
      text: `High pending load (${totals.pending}). Consider splitting routes or tipping early.`,
    });
  }
  topCancel.slice(0, 3).forEach((r) => {
    insights.push({
      severity: 'info',
      text: `${r.name} (${r.branch}): ${r.n}× ${String(r.anomaly_reason || 'cancel').replace(/_/g, ' ')} this month.`,
    });
  });
  const behind = drivers.filter((d) => (d.pending || 0) >= 5);
  behind.forEach((d) => {
    insights.push({
      severity: 'warning',
      text: `${d.full_name} (${d.fleet_number || '—'}) still has ${d.pending} pending today.`,
    });
  });
  if (!insights.length) {
    insights.push({ severity: 'ok', text: 'Operations look stable for today. Keep monitoring live map.' });
  }

  const brief = {
    date: today,
    totals,
    completion_rate: rate,
    late_stops: late,
    top_cancel_patterns: topCancel,
    drivers,
    insights,
    narrative: null,
  };

  // Optional LLM narrative
  if (process.env.OPENAI_API_KEY) {
    try {
      brief.narrative = await llmNarrative(brief);
    } catch (e) {
      brief.narrative = null;
      brief.llm_error = e.message;
    }
  } else {
    brief.narrative = ruleNarrative(brief);
  }
  return brief;
}

function ruleNarrative(b) {
  const t = b.totals || {};
  return (
    `Today ${b.date}: ${t.collected || 0} collected, ${t.pending || 0} pending, ` +
    `${t.canceled || 0} no-pickup, ${t.overdue || 0} overdue` +
    (b.completion_rate != null ? ` (${b.completion_rate}% completion among closed jobs).` : '.') +
    ' ' +
    (b.insights || []).map((i) => i.text).join(' ')
  );
}

async function llmNarrative(brief) {
  const key = process.env.OPENAI_API_KEY;
  const body = {
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content:
          'You are an ops assistant for GreenLoop waste logistics in the UAE (Majari). ' +
          'Write a short 3-5 sentence morning brief for the fleet owner. Be concrete, no fluff.',
      },
      {
        role: 'user',
        content: JSON.stringify({
          date: brief.date,
          totals: brief.totals,
          completion_rate: brief.completion_rate,
          insights: brief.insights,
          drivers: brief.drivers,
          top_cancel_patterns: brief.top_cancel_patterns?.slice(0, 5),
        }),
      },
    ],
    temperature: 0.3,
    max_tokens: 250,
  };
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + key,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('OpenAI ' + res.status);
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || null;
}

async function customerRiskHints(customerId) {
  const month = new Date().toISOString().slice(0, 7);
  if (!Number.isInteger(customerId)) return [];
  const g = await prisma.pickup.groupBy({
    by: ['anomaly_reason'],
    where: { customer_id: customerId, scheduled_date: { startsWith: month }, anomaly_reason: { not: null } },
    _count: { _all: true },
  });
  const rows = g.map((x) => ({ anomaly_reason: x.anomaly_reason, n: x._count._all })).sort((a, b) => b.n - a.n);
  return rows.map((r) => ({
    reason: r.anomaly_reason,
    count: r.n,
    tip:
      r.anomaly_reason === 'ACCESS_BLOCKED'
        ? 'Confirm gate access / timing with store before dispatch.'
        : r.anomaly_reason === 'BIN_EMPTY'
          ? 'Verify collection frequency; may need schedule reduction.'
          : 'Coordinate with store manager on refusal pattern.',
  }));
}

module.exports = { buildOpsBrief, customerRiskHints, ruleNarrative };
