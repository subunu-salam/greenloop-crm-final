# GreenLoop Fleet Tracker — PRD update v3.2

**Status:** implemented in build 3.2.0 · **Date:** 08/10/2026 · **Supersedes:** Fleet Tracker sections of PRD v1.0 / v3.1

## 1. Why this update

The Fleet Tracker so far only knew about *pickup* problems (bin empty, no access…). The fleet itself — tyres, oil, services, what they cost and who paid — lived outside the system. This update turns the tracker into a **vehicle expense and maintenance tracker**, removes the fixed daily capacity of 15, fixes how dates are shown, and makes push notifications the primary alert channel.

## 2. Goals

| # | Goal | Measure |
|---|---|---|
| G1 | Drivers report vehicle issues from the app in under 30 seconds | Report = category + urgency + photo, ≤ 5 taps |
| G2 | Every expense has payment proof | 0 resolved expenses without a receipt photo |
| G3 | Admin sees full service history per vehicle | Any vehicle → all services, costs, proofs, next-due in one view |
| G4 | Capacity reflects reality | Per-vehicle default + per-day changes respected by every scheduling engine |
| G5 | No ambiguous dates | All user-facing dates DD/MM/YYYY |
| G6 | Alerts reach people with the app closed | Push for all driver and customer alerts; admin-wide broadcast |

Out of scope for 3.2: fuel-efficiency analytics, parts inventory, workshop purchase orders, automatic rescheduling when a truck goes off the road (the office is alerted and decides).

## 3. Driver app — vehicle issue reporting (FLT-01 … FLT-06)

| ID | Requirement |
|---|---|
| FLT-01 | New **Vehicle** tab shows the assigned vehicle, last odometer, last oil change, last service and any due / overdue maintenance. |
| FLT-02 | Driver reports an issue by tapping a category tile: **Tyre damage, Oil change, Service due,** Brakes, Battery, Engine / warning light, A/C, Body damage, Fuel, Other. |
| FLT-03 | Each report captures urgency (**Can drive / Fix soon / Cannot drive**), optional odometer (km), optional note and a photo. A photo is **mandatory** for tyre and body damage. |
| FLT-04 | If the driver paid on the spot: amount (AED), method (cash / card / fuel card) and a **receipt photo are mandatory** — no amount is accepted without payment proof. Cash / card are recorded as *paid by driver → to be reimbursed*. |
| FLT-05 | Driver sees their reports with live status (Sent → Approved → In progress → Resolved / Not approved), the office note and reimbursement state. |
| FLT-06 | Driver gets a **push notification** on every status change and on reimbursement. Tab is available in EN / HI / UR / AR. |

Rules: a driver can only report on the vehicle currently assigned to them; a driver without a vehicle is told to contact the office. Photos are reduced to ≤ 1600 px on the phone before upload.

## 4. Admin dashboard — maintenance & expenses (FLT-10 … FLT-18)

| ID | Requirement |
|---|---|
| FLT-10 | New CRM page **Fleet maintenance**. Reports appear live; a CRM alert is raised for each (critical when the vehicle cannot drive). |
| FLT-11 | KPIs: new reports, in progress, vehicles off the road, spend this month, **expenses without payment proof**, amount owed to drivers. Spend this month by category. |
| FLT-12 | Moderation: Open → Approved → In progress → Resolved, or Rejected (a note to the driver is required when rejecting). Ops staff and owner can moderate. |
| FLT-13 | Per record: service date, workshop / vendor, work done, cost, paid by (company / driver), payment method, payment reference, odometer. |
| FLT-14 | **Payment proof**: receipt photo attached by the driver or uploaded / replaced by the office. A cost without a receipt is flagged "missing" everywhere until fixed. |
| FLT-15 | **Service history** per vehicle: chronological timeline of every issue, service and expense with photos, proof, totals (month / year / lifetime) and CSV export. |
| FLT-16 | **Next due** reminder per category by date and/or odometer; shown as *due soon* (14 days / 500 km) or *overdue* on the dashboard and in the driver app. |
| FLT-17 | Office can log a service or expense directly (workshop invoice) without a driver report. |
| FLT-18 | Only the owner can mark a driver expense as reimbursed. |

## 5. Capacity moderation (FLT-20 … FLT-23)

| ID | Requirement |
|---|---|
| FLT-20 | The fixed capacity of 15 is replaced by a **per-vehicle default** (1–60), editable by the owner from the Fleet Load Tracker. |
| FLT-21 | Any single day can be changed per vehicle (0–60) with a mandatory reason — e.g. `0 — oil change at workshop`, `20 — extra helper`. Owner and ops staff. Past days cannot be changed. |
| FLT-22 | All engines use the day's capacity: recurring-plan generation, monthly scheduler, auto-allocation, ad-hoc orders, bookings, rescheduling. |
| FLT-23 | Lowering capacity below the stops already scheduled is allowed but flagged: the tracker cell turns red, shows "N stop(s) over capacity" and a CRM alert asks the office to reschedule. Stops are never moved silently. |

## 6. Date display (FLT-30)

All dates shown to users are **DD/MM/YYYY** (date / month / year). In the Fleet Load Tracker each day shows the weekday, `DD/MM/YYYY` with the month tinted, and the month spelled out (`8 Oct 2026`), plus a visible format hint. Storage and CSV sort keys remain ISO `YYYY-MM-DD`. Applies to CRM, driver app, customer app, quotation and invoice PDFs and emails.

## 7. Notifications (NTF-01 … NTF-06) — top priority of this build

| ID | Requirement |
|---|---|
| NTF-01 | Push is the primary channel for every alert to drivers and customers (free Web Push, no SMS / WhatsApp cost). Every alert is also stored in the in-app inbox. |
| NTF-02 | A device is registered on every sign-in and site switch and removed on sign-out, so pushes reach exactly the people signed in. |
| NTF-03 | Multi-site customers receive account-level alerts (invoices) on every device, whichever site is selected. |
| NTF-04 | **Admin-wide broadcast**: one message to all customers, all drivers or everyone; result shows inboxes reached, devices delivered, failed and expired. History is kept. |
| NTF-05 | Driver pushes: route changed, stop added, stop at risk, vehicle report status, reimbursement, announcements. Customer pushes: reminder, driver arrived, completed, not-picked-up confirmation, booking decision, invoice issued / resent, payment received, announcements. |
| NTF-06 | System response messages (success, warning, error) appear at the **top** of the screen in all three apps, colour-coded and dismissible. |

## 8. Quotation & invoice workflow

1. **Send quotation via Gmail (free).** Default channel for quotations. Email carries the summary and one link to view, download the PDF and accept. WhatsApp remains a manual fallback only.
2. **Lead approval & customer registration.** Accepted quote → Convert creates the customer, sites, plan and app access; access details are emailed and a welcome message waits in the app.
3. **Send invoice & PDF via customer app.** Invoices are delivered in-app with push; tapping opens the PDF. The office can resend and sees when it was sent.

## 9. Acceptance criteria (all covered by `npm test`)

- Tyre report without photo, and paid amount without receipt, are rejected.
- "Cannot drive" raises a critical CRM alert; vehicle shows as off the road until resolved.
- Resolved expense without receipt is flagged; attaching the receipt clears the flag.
- Service history totals and last-oil-change / odometer are correct; overdue service is flagged.
- Day capacity 0 blocks auto-allocation and ad-hoc orders for that truck/day and reports the overload; removing it restores the default.
- Broadcast reaches every signed-in customer device, never driver devices; expired devices are cleaned up; failures are reported.
- Quotation without a customer email cannot be "sent"; a Gmail failure never marks it as sent.

## 10. Open questions

1. Should "Cannot drive" automatically set that day's capacity to 0 and propose reschedules, or stay a manual decision?
2. Receipts are photos only (JPEG / PNG / WebP / HEIC). Are PDF workshop invoices needed?
3. Reimbursements: tracked here only, or exported to payroll / accounting?
4. VAT on expenses: is a separate VAT amount per expense needed for input-tax reporting?
5. Invoice PDFs are print-ready pages ("Save as PDF"). Is a generated PDF file attachment required?
