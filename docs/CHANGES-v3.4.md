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

## Going back

Delete the `<link rel="stylesheet" href="aura.css">` line in an app's index.html and that app
shows the v3.3 look again.
