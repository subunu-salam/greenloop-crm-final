# GreenLoop v3.5: AI insights and performance reports

Two new CRM pages under Operations. Everything that existed before works as it did.

## AI insights
- Today's read-out: one paragraph with the numbers that matter.
- Recommended actions, each with an AI confidence: driver delay fixes, days that need an extra
  truck, sites to visit less often (bin keeps being empty), sites to move off a day they are closed,
  drivers to coach or recognise, tomorrow's risky stops.
- Demand forecast for 14 days with an 80% range, against fleet capacity.
- AI confidence level: the model forecasts the last 14 days from the weeks before them and is
  scored against what happened (predicted against actual). High is 90% or better, Medium 80–89%, Low below 80%.
- Driver delays over 28 days: on time, average and worst delays, week-on-week change, score.
- Patterns the AI found: a driver who runs late in one zone, on one weekday or in one time window.
- Heatmap of late stops by zone and weekday.
- Tomorrow's stops most likely to run late, with the main reason, and how well the model did on the last 14 days.

## Performance reports
- Daily report (yesterday by default) compared with the last four same weekdays.
- Weekly report compared with the previous week, drivers ranked with score change.
- AI summary at the top of each, charts, driver and zone tables, latest arrivals, no-pickup reasons.
- Pick any day or week, export the driver table as CSV, Print / save as PDF (prints the report only, on white).

## Data
- Uses your own jobs once there are about 150 finished in the last 28 days.
- Until then it shows realistic demo data (five trucks, 120 sites, ten weeks) and says so on the page.
  Demo data is generated in memory and never saved. "My data" / "Demo data" switches it by hand.
- A stop is late when the driver arrives more than 10 minutes after its time window. Dubai time.
- No outside AI service is needed: the models run on the server in about 25 ms.

## Files
New
- server/insights.js           the models: forecast, confidence, delay patterns, risk, reports, recommendations
- public/crm/insights.js       the two pages
- public/crm/insights.css      their styles, print layout
- test/unit/v35.test.js        25 checks
- docs/CHANGES-v3.5.md

Changed
- server/ai-api.js             three routes: GET /ai/insights, /ai/reports/daily, /ai/reports/weekly (office staff only)
- public/crm/app.js            two menu entries (2 lines)
- public/crm/index.html        loads insights.css and insights.js (2 lines)
- test/unit/harness.js         mounts the AI routes for tests (1 line)
- test/run.js                  runs the new suite
- package.json                 version 3.5.0
- README.md                    v3.5 note
