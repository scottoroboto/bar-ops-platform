# ticketsportsbar.com

The public website. Plain static HTML: `index.html` and `logo.png`, no build step.
It is separate from the staff platform in `public/`.

## Placeholders to replace before launch
- Both addresses and phone numbers (made up; the 555 numbers are fictional)
- Weekly specials ("This week at Ticket")
- Menu items and prices (the real PDF menu is still to come)
- `parties@ticketsportsbar.com` (needs an iPower forward, or swap in a real address)
- Photo slots (`.photo` blocks), which become real photos of the bars
- "50+ TVs / 10 DirecTV feeds" figures (taken from the first location's headend notes)

## Going live
Host it as a Render static site with this folder as the publish directory.
Then point only the website DNS records (`@` and `www`) at Render.
Leave the MX records alone so iPower email forwarding keeps working.
