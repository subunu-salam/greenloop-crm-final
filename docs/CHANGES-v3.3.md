# GreenLoop v3.3 — files to replace

Built on the v3.2 zip (`greenloop-crm-final-main_6.zip`). Copy these files over your project; every other file is untouched. No new npm packages. The database updates itself on the next start.

## New files (5)
| File | What it is |
|---|---|
| `server/contacts.js` | Phone format, email check, duplicate lookup |
| `server/driver-shift.js` | Clock in/out, arrival photo, finish / report issue, shift report |
| `public/shared/phone.js` | The country-code phone field used by the CRM and customer app |
| `public/driver/shift.js` | Driver shift clock and its four-language text |
| `test/unit/v33.test.js` | 92 checks for this build |

## Changed files (20)
| File | What changed |
|---|---|
| `server/v3.js` | Lead validation and duplicates, frequency pricing, quotation document and email, preview + send rules, 4-digit codes, emailed one-time codes |
| `server/api.js` | Customer / user validation and duplicates, CSV import rules, job start time, ledger times |
| `server/customer-api.js` | Customer sign-in uses the new phone matching; 4-digit code message |
| `server/index.js` | Loads the shift routes; serves `public/shared` |
| `public/crm/app.js` | Phone field in customer and user forms, email on customers, duplicate prompt, ledger shift line and times |
| `public/crm/sales.js` | Lead form, quotation list, builder, document view, preview and confirmation |
| `public/crm/styles.css` | Styles for the above |
| `public/crm/index.html` | Loads `shared/phone.js` |
| `public/customer/app.js` | Sign-in with the phone field, 4-digit code, emailed code |
| `public/customer/index.html` | Sign-in screen |
| `public/customer/styles.css` | Phone field styles |
| `public/driver/app.js` | Start → arrival photo → finish / report issue, timers, ordered offline sending |
| `public/driver/index.html` | Loads `shift.js` |
| `public/driver/styles.css` | Shift card, timers, arrival card |
| `package.json` | Version 3.3.0 |
| `README.md` | v3.3 section |
| `deploy/.env.example` | `OTP_DEV` |
| `test/run.js`, `test/unit/harness.js`, `test/unit/v32.test.js` | Test wiring; older email tests now preview first |

## After deploying
1. Set `GMAIL_USER` and `GMAIL_APP_PASSWORD` on the server (quotations, welcome emails and one-time codes all use it), and `OTP_DEV=0`.
2. Add an email to each customer who should be able to sign in with an emailed code (Customers → Edit).
3. Customers who were given a 6-digit code: reset it in Customer 360 to issue a 4-digit one.
