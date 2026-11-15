# Alafia Clinic booking page: design handoff

Figma file: https://www.figma.com/design/KMCTW5jIG3splu5m1GtvdK

## What is in the file

| Section | Contents |
|---|---|
| 01 · Brand | Logo (component set: Light / Dark), app icon sizes, type specimens, 14 colour tokens |
| 02 · Components | Button, Input, Badge, Slot card, Alert, App header (all are Figma components with variants) |
| 03 · Desktop (1440) | D1 API key, D2 Available slots, D3 Booking form with 400 errors, D4 Slot taken (409), D5 Too many attempts (429) |
| Still to build | D6 Confirmation, D7 My bookings, and the mobile set (paused by Figma's Starter-plan tool limit) |

## Brand

- **Name:** Alafia Clinic ("Àlàáfíà" means wellbeing and peace in Yorùbá).
- **Mark:** a rounded-square clinical cross with a saffron leaf growing from its top-right arm. On light surfaces use pine square + cream cross; on pine surfaces use cream square + pine cross.
- **Wordmark:** "alafia" in Fraunces SemiBold, tracked -0.6px; "CLINIC" in Geist Mono Medium, 32% tracking.
- Logo SVG (40×40), ready to paste into `public/logo.svg`:

```svg
<svg width="40" height="40" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect width="40" height="40" rx="12" fill="#0F4C45"/>
  <path d="M20 11v18M11 20h18" stroke="#F6F3EC" stroke-width="4.5" stroke-linecap="round"/>
  <path d="M23.5 16.5c0-4.4 2.9-7.3 7.5-7.5-.2 4.6-3.1 7.5-7.5 7.5z" fill="#F2B35B"/>
</svg>
```

## Typography (all free on Google Fonts)

| Role | Font | Use |
|---|---|---|
| Display and headings | **Fraunces** (Light 64/48, Regular 36/28, Light Italic for accent words) | Page titles, slot times, confirmation headline |
| Interface | **Geist** (Regular 17/15/13, Medium labels, SemiBold H3) | Body, forms, buttons, nav |
| Data | **Geist Mono** (Regular 14, Medium 11 uppercase with 8% tracking for overlines) | Booking IDs, API key, times, cursors |

```html
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300..600;1,9..144,300&family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&display=swap" rel="stylesheet">
```

## One library, not two

Using shadcn/ui and DaisyUI together in code clashes: both theme Tailwind, both define `btn`/`card`-style primitives, and their colour variables collide. The design picks **one component language (shadcn/ui)** and borrows **DaisyUI's idea of semantic theme names** (success, warning, info, a single theme file). So:

- If the page becomes React + Tailwind: install shadcn/ui only, paste the variables below into `globals.css`, and do not add the DaisyUI plugin.
- If the page stays plain HTML/CSS/JS with no build step (as PLAN.md section 5 says): skip both libraries, paste the same variables into `public/styles.css`, and build the few components below by hand. The Figma components are named after their shadcn equivalents so either route lines up.

## Theme tokens (shadcn format, HSL)

```css
:root {
  --background: 42 36% 95%;           /* #F6F3EC warm paper */
  --foreground: 172 33% 9%;           /* #10201E */
  --card: 0 0% 100%;
  --card-foreground: 172 33% 9%;
  --primary: 173 67% 18%;             /* #0F4C45 pine */
  --primary-foreground: 42 36% 95%;
  --secondary: 144 23% 91%;           /* #E4EEE8 mint wash */
  --secondary-foreground: 173 67% 18%;
  --muted: 42 29% 91%;                /* #EFEBE2 */
  --muted-foreground: 162 6% 43%;     /* #66736F */
  --accent: 35 85% 65%;               /* #F2B35B saffron */
  --accent-foreground: 35 84% 12%;
  --destructive: 8 62% 47%;           /* #C2412D */
  --destructive-foreground: 42 36% 95%;
  --success: 152 61% 30%;             /* #1E7A4F */
  --warning: 32 93% 33%;              /* #A35A06 */
  --info: 209 52% 36%;                /* #2C5E8C */
  --border: 41 25% 85%;
  --input: 41 22% 81%;
  --ring: 173 67% 18%;
  --radius: 0.75rem;                  /* 12px buttons and inputs; cards 16, panels 24 */
}
```

Shadows: `Shadow/sm` = `0 1px 2px rgb(16 32 30 / .06), 0 4px 12px -2px rgb(16 32 30 / .05)`; `Shadow/lg` = `0 24px 48px -12px rgb(10 26 24 / .10), 0 4px 10px rgb(10 26 24 / .06)`. Focus ring: `0 0 0 4px hsl(var(--primary) / .18)`; error ring uses `--destructive`.

## Component map

| Figma component | shadcn/ui | Notes for the code |
|---|---|---|
| Button (Primary, Secondary, Outline, Ghost, Destructive × Default/Disabled) | `Button` variant `default`, `secondary`, `outline`, `ghost`, `destructive` | Height 44, radius 12. Disable while the POST is in flight. |
| Input (Default, Focus, Error, Disabled) | `Label` + `Input` + `FormMessage` | Error: `aria-invalid`, red border and ring, message shows the API's `error` text (for example "email is invalid"). |
| Badge (Available, Booked, Confirmed, Cancelled, Past, Selected, Info) | `Badge` with custom tone classes | Pill with a 6px dot. |
| Slot card (Available, Selected, Booked, Past) | `Card` rendered as a `<button>` | Booked = `available:false`; Past = `start <= now`; both disabled. Selected = `aria-pressed="true"`. |
| Alert (Error, Warning, Success, Info) | `Alert` | 429 uses Warning with the `Retry-After` seconds; success toast uses Success (`Sonner`/toast in React). |
| 409 dialog | `AlertDialog` | Offers the two nearest open slots and keeps name and email filled in. |
| App header | `NavigationMenu` / tabs | Green dot chip shows the saved key's last 4 characters; "Change key" clears localStorage. |
| Provider filter | `Tabs` (or `Select` on mobile) | "All, Dr Ade, Dr Bello, Dr Chen". |
| My bookings table | `Table` + `Button` "Load more" | Cancel asks inline ("Cancel this booking? Keep / Yes, cancel"), then DELETE. |

## Status code to UI copy

| Status | Where | Copy |
|---|---|---|
| 401 | Key screen, Alert Error | "That key wasn't accepted. Check it and try again." |
| 400 | Under the field | The API's own message, e.g. "name is required", "email is invalid" |
| 404 | Alert Error | "That slot no longer exists." |
| 409 | AlertDialog | "Someone just booked this slot" + nearby times |
| 429 | Alert Warning + disabled button | "Too many attempts… Try again in 42 seconds." Button counts down "Try again in 0:42". |
