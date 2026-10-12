# GreenLoop v3.4: Aura glow-up and new logo

A visual release. Every screen, feature, route and database table is the same as v3.3
(plus the NOT PICKED UP fix). The look follows the "06 · Aura — Glass & Light" kit from the
team's Figma UI Kit Collection, in GreenLoop's green instead of Aura's pink.

## What changed for the eye

- Type: Outfit everywhere (served from the app, so it works offline), light large figures.
- Background: brighter green, cyan and indigo light behind darker frosted panels.
- Controls: pill buttons, pill tabs, rounded inputs with a green focus ring.
- CRM: full-height side menu, stat cards with the label on top and an icon chip, table
  headers in small capitals, status pills with a dot, calmer row buttons, themed charts.
  On a phone the menu is one row you swipe sideways.
- Driver: shift clock is a solid green hero card, big actions are bright with dark text,
  round keypad, bottom bar with a tinted pill behind the active icon.
- Customer: headline status on the hero card, round keypad, pill tabs, full-width visit rows.
- Logo: a loop that ends in a leaf, on a green tile. Used on all sign-in screens, the CRM
  menu, the browser tab, the phone home-screen icon and the quotation document.

## Files

New (7)
- public/crm/aura.css
- public/driver/aura.css
- public/customer/aura.css
- public/shared/logo.svg
- public/shared/fonts/Outfit.ttf
- public/shared/fonts/OFL.txt   (the font's licence)
- docs/CHANGES-v3.4.md

Changed (13)
- public/crm/index.html         loads aura.css, new logo, tab icon
- public/crm/app.js             chart colours and chart font (2 lines)
- public/crm/sales.js           chart colours (1 line)
- public/crm/fx.js              chart tooltip colours (1 line)
- public/driver/index.html      loads aura.css, logo on sign-in, tab icon
- public/driver/icons.svg       new home-screen icon
- public/driver/manifest.json   splash colours
- public/customer/index.html    loads aura.css, new logo, tab icon
- public/customer/icons.svg     new home-screen icon
- public/customer/manifest.json splash colours
- server/v3.js                  logo on quotation and document pages (2 constants)
- package.json                  version 3.4.0
- README.md                     v3.4 note

Not touched: styles.css and fx.css in all three apps, every other script, the server routes,
the database and the tests.

## v3.4.1: fixes from the end-to-end test pass

Three theme files changed, nothing else:

- public/crm/aura.css       on 1280 to 1500 px laptop screens the tables keep their columns (tighter
                            padding, narrower menu); a table that still cannot fit scrolls inside its
                            card. In v3.4.0 the Customers table spilled out of its card at 1280 px.
- public/customer/aura.css  plan cards and invoice rows: the name and the line under it no longer run
                            together ("Machari waste pickupWeekly", "INV-202610-000210/2026").
- public/driver/aura.css    in Arabic and Urdu the phone number reads +971… and not …971+.
- package.json              version 3.4.1

## v3.4.2: phone rules, email errors, overdue check

- Phone numbers follow each country's real numbering plan, and a refused number says why.
  UAE mobile 9 digits starting 5, landline 8 digits starting 2, 3, 4, 6, 7 or 9. Saudi mobile 9
  digits starting 5, landline 9 digits starting 1. Qatar, Oman, Kuwait and Bahrain 8 digits.
  The field shows the rule under it while you type and turns green on a valid number.
- Email: a failed send always gives the reason (it could be empty before). The sender tries
  port 465, then port 587, over IPv4 first. If the server cannot reach Gmail, the preview offers
  "Open it in my Gmail instead" so the quotation still goes out.
- Overdue check: a stop added to today after the cutoff is no longer marked Overdue a minute
  later. It turns Overdue the next day if nobody did it.
- CRM menu: "Users" is now "Drivers & users", and the page says how to give a driver a truck.

Files
- server/contacts.js           phone rules per country, error wording
- public/shared/phone.js       same rules in the browser, live hint under the field
- server/mailer.js             port fallback, readable errors
- server/v3.js                 error text on send, "open in my Gmail" fallback (5 small edits)
- public/crm/sales.js          fallback button in the quotation preview
- server/services/sla.js       overdue check
- public/crm/app.js            menu label and page text (3 lines)
- test/unit/v342.test.js       new, 13 checks
- test/run.js                  runs the new suite
- package.json                 version 3.4.2

## v3.4.3: Resend and Brevo for email

Two more ways to send email, both over the normal web port, so they work on hosts that block
mail ports (free Render web services) and on networks that block them.

- Resend: set RESEND_API_KEY and MAIL_FROM (an address on a domain verified in Resend).
- Brevo:  set BREVO_API_KEY and MAIL_FROM (a sender verified in Brevo).
- Order when several are set: Resend, Brevo, Gmail API, Gmail app password.
- Used for everything the app emails: quotations, the welcome message with app access, sign-in
  codes and the test email in Settings.

Files
- server/mailer.js        the two services, clear refusal messages
- public/crm/sales.js     the banner names the service in use (1 line)
- deploy/.env.example     the new settings
- package.json            version 3.4.3

## v3.4.4: security fixes from the test pass

- Sign-in code: no longer sent back to the browser. It shows on screen only when OTP_DEV=1 is set on purpose
  for local testing. render.yaml now sets OTP_DEV to 0.
- Demo passwords are no longer printed on the CRM and customer sign-in pages. A new database takes its
  admin password from ADMIN_PASSWORD when that is set.
- Customer text (access notes and other fields) can no longer run as script when staff click Edit in the CRM.
  Plan dates and status are shown as plain text.
- Restart no longer rewrites a customer's phone or gives out a demo code once any customer has a code.
- Customer history report accepts only real dates in its address.
- Driver app: a step saved while the offline queue is sending is kept. Live location starts when the app
  is reopened already signed in.

Files
- server/v3.js                 sign-in code rule, history report dates
- server/customer-api.js       demo codes only on an empty database
- server/db.js, server/db-pg.js  ADMIN_PASSWORD for a new database (1 line each)
- public/crm/index.html        demo line removed
- public/customer/index.html   demo line removed
- public/crm/app.js            safe Edit buttons (4 lines)
- public/crm/sales.js          safe Edit buttons, plan dates as text (2 lines)
- public/driver/app.js         offline queue (3 lines)
- public/driver/tracking.js    start on reopen (1 line)
- render.yaml                  OTP_DEV 0
- test/unit/regression.test.js, test/unit/v33.test.js  updated for the sign-in code rule
- README.md, deploy/.env.example, package.json (3.4.4)

## Going back

Delete the `<link rel="stylesheet" href="aura.css">` line in an app's index.html and that app
shows the v3.3 look again.
