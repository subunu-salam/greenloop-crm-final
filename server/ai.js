// GreenLoop AI helpers — rule-based always; optional OpenAI when OPENAI_API_KEY is set
const { q } = require('./db');

async function buildOpsBrief() {
  const today = new Date().toISOString().slice(0, 10);
  const month = today.slice(0, 7);

  const totals = q.get(
    `SELECT COUNT(*) total,
      SUM(status='pending') pending,
      SUM(status='collected') collected,
      SUM(status='canceled') canceled,
      SUM(status='overdue') overdue
     FROM pickups WHERE scheduled_date=? AND status!='rescheduled'`,
    today
  ) || {};

  const late = q.all(
    `SELECT c.name, c.branch, c.zone, p.status, p.stage, p.id
     FROM pickups p JOIN customers c ON c.id=p.customer_id
     WHERE p.scheduled_date=? AND p.status IN ('pending','overdue')
     ORDER BY p.status='overdue' DESC, p.seq LIMIT 15`,
    today
  );

  const topCancel = q.all(
    `SELECT c.name, c.branch, c.zone, p.anomaly_reason, COUNT(*) n
     FROM pickups p JOIN customers c ON c.id=p.customer_id
     WHERE p.scheduled_date LIKE ? AND p.status='canceled'
     GROUP BY c.id, p.anomaly_reason
     ORDER BY n DESC LIMIT 8`,
    month + '%'
  );

  const drivers = q.all(
    `SELECT u.full_name, v.fleet_number,
      SUM(p.status='collected') collected,
      SUM(p.status='pending') pending,
      SUM(p.status='canceled') canceled
     FROM pickups p
     JOIN users u ON u.id=p.driver_id
     LEFT JOIN vehicles v ON v.id=p.vehicle_id
     WHERE p.scheduled_date=?
     GROUP BY u.id ORDER BY pending DESC`,
    today
  );

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

function customerRiskHints(customerId) {
  const month = new Date().toISOString().slice(0, 7);
  const rows = q.all(
    `SELECT anomaly_reason, COUNT(*) n FROM pickups
     WHERE customer_id=? AND scheduled_date LIKE ? AND anomaly_reason IS NOT NULL
     GROUP BY anomaly_reason ORDER BY n DESC`,
    customerId,
    month + '%'
  );
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
