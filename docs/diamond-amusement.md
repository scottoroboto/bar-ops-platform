# Diamond Amusement — collections app

The coin-op route: games (pool, Golden Tee, Putt Putt, shuffleboard,
basketball, pinball) placed in the bars, collected roughly every two weeks
by Scotto or Ryan, with each location's total rung into that bar's SpotOn
POS as an "Amusement" sale.

Files: `db/patch_041_amusement.sql`, `db/patch_042_amusement_tare_pos_photo.sql`, `db/patch_044_amusement_collection_screen.sql`, `server/amusement.js`, the
`/api/amusement/*` routes at the bottom of `server/index.js`,
`public/amusement.html|js|css`, `public/amusement-tags.html` (printable QR
stickers). App key `amusement` on `employee_apps`; the tile is
"Games" on Apps Home (the toggle in Employees is "Games" too).

## Turning it on (one time)

1. **Database.** Run `db/patch_041_amusement.sql` then
   `db/patch_042_amusement_tare_pos_photo.sql` in Supabase's SQL editor
   with "Run without RLS", same as every other patch. It creates the
   tables, seeds one amusement location per active bar plus "Storage /
   shop", and creates the private `amusement-photos` storage bucket.
2. **Photo reading.** On Render, add the environment variable
   `ANTHROPIC_API_KEY` (an Anthropic API key). Without it the app still
   works fully with typed weights; the "Photo the scale display" button
   just doesn't appear. Reads run on `claude-opus-5-5` at low effort;
   a shrunken phone photo costs well under a cent to read.
3. **Photo storage** uses the existing `SUPABASE_URL` /
   `SUPABASE_SERVICE_ROLE_KEY` (same as cash receipts). If those aren't
   set the reading is still kept, the photo just isn't stored.
4. **Access.** The owner always has the app. For Ryan (or anyone else
   who collects), switch on "Games" in Employees.
5. **Games.** Games → "+ Add game" for each machine, at the right
   location. Each gets a tag code (DA-0001, DA-0002, …). Stickers:
   Admin → "Print QR stickers" for a batch (pick which games, and where
   on a partly used sheet to start), or "Print sticker" on a game's
   page for one. Laid out for **Avery 6578** (2" × 2-5/8", 15 per
   sheet, laser, film with permanent adhesive). Print at 100% scale.
   Wipe the coin box with isopropyl alcohol first, press hard, leave
   it 24 hours.
6. **Coin-box tares.** On each game's page, "Weigh empty coin box":
   photo the scale with the empty box on it (or type the grams). That
   game's box weight is then deducted automatically every collection.
   The sticker goes on the coin box, so the thing scanned is the thing
   on the scale. A game without its own tare uses the default in
   Settings.
7. **Settings** (Admin → Settings): scale unit (grams recommended),
   default tare, quarter weight (leave at 5.670), and the calibration
   weight if you have one — a certified 500 g / 1 kg test weight kept
   with the scale. When set, the start-of-visit check expects it
   instead of the $10 roll (worn quarters run light; a test weight
   doesn't). Admin shows every check with its drift so a scale going
   bad is visible before it costs money.

## Per-game settings that change the collection screen

Each game (Games → the game → Edit) says what it takes:

- **Takes quarters** — off for Golden Tee. With it off there is no
  weighing step for that game at all.
- **Takes bills**, and **which bills** ($1, $5, $10, $20). The collector
  only sees columns for the bills that acceptor takes. With bills off
  the sheet shows no bills card.
- **Has a collection screen** — on for Golden Tee and Power Putt. Each
  visit that game's line starts with a photo of the game's own
  collection screen (the reader pulls the total off it when it can),
  then asks "Did you clear the collection screen?", and only then the
  bills (and quarters, for Power Putt). The photo and the answer are
  stored on the line, and the review page flags a screen total that
  does not match what was counted, and a screen that was not cleared.

- **Collection amount comes from the screen** (Golden Tee). The game
  works out income less its own fees and shows the amount to be split
  between operator and location; that number *is* the collection. The
  bills (and coins) counted are still entered and stored on the line
  as `bills_counted_amount`, for the audit, but add nothing. Set
  **Screen line to read** to the label as printed on the game ("Total
  Due") and the reader pulls that line; it also lists every labelled
  amount it saw so the collector can tap the right one if it guessed
  wrong.

(`db/patch_044_amusement_collection_screen.sql`.)

## How a collection works

Home → "Start collection" at a bar (or "Continue" if one is open). One
draft per location at a time; it saves as you go.

Optional first step: **scale check** — weigh the calibration weight (or
the $10 roll of quarters, 226.8 g, if none is set). Recorded on the
collection with what it expected, with the photo.

Per game: scan its sticker (in-app scanner, or the phone's own camera app
— the QR is a URL that opens the app at that game) or tap it on the sheet.
Then **photo the scale display** → the app reads the number → the
collector checks it against the scale and fixes it if needed → bills by
count (or a flat amount) → coin meter and condition if wanted → Save.
The photo, the number that was read, and who confirmed it are stored on
the line. Typing the weight instead of photographing it always works.

Weight → dollars: net grams = gross − tare; coins = round(net / 5.670);
dollars = coins × $0.25. Each line keeps the weights and the quarter
weight used, so history never changes if settings do.

**Review & finalize** locks the sheet and queues the total for SpotOn.
Whoever rings it in taps **Mark posted**, optionally with the ticket
number and a photo of the SpotOn ticket, so the collection has proof at
both ends. Home and Reports both flag finalized collections not yet
posted.

## Reports (owner)

Earnings per game per day over 30/90/180/365 days, sorted best to worst,
with games well under the route average flagged; totals by location; the
collection log with POS status; and per-game history (with placement
history, so a moved game's earnings follow it) under Games → the game.

## Later

- Posting the sale to SpotOn through its API instead of by hand.
- Reading a game's coin meter from a photo the same way as the scale.
