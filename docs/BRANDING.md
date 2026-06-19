# BridgePort Branding

> The logo, mark, and loading animation. For the broader UI system (tokens,
> theming, components) see [`docs/development/ui-guidelines.md`](development/ui-guidelines.md).

## The mark

A **port gantry crane carrying a shipping container**. It reads directly on the
product — deploy and orchestrate containers — and it's the *port* in the name.

The mark is deliberately **name-independent**: no bridge, no "B" monogram. The
"Bridge" half of the name is naming, not identity, so the mark survives a rename.

- **Silhouette:** a symmetric gantry — splayed legs, feet, a top beam with a
  trolley, and a corrugated container hanging dead-centre. Symmetry makes it
  balanced as a square favicon; the centred load means it can ride straight up
  and down for the loading animation.
- **Personality:** technical and precise — clean, geometric, engineered.

## Color

| Token | Value | Use |
|---|---|---|
| `--brand` | `oklch(0.53 0.21 28)` ≈ `#CC0000` | The mark, everywhere. |
| `--brand-foreground` | white | The mark knocked out on a burgundy tile. |
| `--foreground` | ink (light) / near-white (dark) | The wordmark. |

The mark is **monochrome**. The SVG uses `fill="currentColor"`, so one source
recolors to burgundy / white / ink with a `text-*` class — no per-context files.

## Components — `ui/src/components/Logo.tsx`

```tsx
import { Logo, LogoMark, BrandLoader } from '@/components/Logo';

<Logo />                              // lockup: mark + BRIDGEPORT wordmark
<Logo variant="mark" />               // the crane alone
<Logo variant="lockup" className="text-2xl" />   // size the lockup via font-size
<LogoMark className="size-6 text-foreground" />   // raw mark, recolored
<BrandLoader className="size-12" />   // the animated loading mark
```

- **Lockup** = the mark (stays brand burgundy) + the **BRIDGEPORT** wordmark set
  in **IBM Plex Sans**, semibold, uppercase, tracked. The wordmark uses
  `text-foreground`, so it's ink on light and white on dark. Size it with a
  `text-*` class — the mark scales with the font (`em`).
- **Mark** is sized with a `size-*`/`h-*` class.

### Where it's used
- **Sidebars** (`AppSidebar`, `AdminSidebar`) — lockup when expanded, mark when
  the app sidebar is collapsed to icons.
- **Login** and **About** — lockup.

## Loading animation — `<BrandLoader>`

The same mark doubles as the app's loading indicator. The container **lowers to
the ground between the feet and lifts back** on a calm ~2.8s loop — "precise
machinery at work," not a frantic spinner.

- Driven by the `.bp-crane-load` keyframes in `ui/src/index.css`.
  `transform-box: view-box` keeps the travel proportional at any render size.
- **Respects `prefers-reduced-motion`**: the mark holds still at the lifted pose.
- **Used on** app boot and lazy route/page loads (`PageFallback` in `App.tsx`),
  replacing the old generic border-spinner. Inline spinners (buttons, dropdowns)
  keep the small `SpinnerIcon` (lucide `Loader2`) — a detailed mark is noise at
  inline sizes.

## Favicon & app-icon set — `ui/public/`

| File | What |
|---|---|
| `favicon.svg` | Primary favicon — burgundy rounded tile, white crane. |
| `favicon.ico` | 16/32 fallback (legacy), simplified solid-box crane. |
| `apple-touch-icon.png` | 180×180, square full-bleed burgundy (iOS rounds it). |
| `icon-192.png`, `icon-512.png` | PWA icons (`any`). |
| `maskable-192.png`, `maskable-512.png` | PWA maskable icons (crane in the safe zone). |
| `site.webmanifest` | Name, `theme_color #cc0000`, icon entries. |
| `logo-mark.svg` | Standalone burgundy mark for docs/external use. |
| `logo.png` | All-burgundy horizontal lockup raster — used by the README. |

`index.html` references `favicon.ico` + `favicon.svg` + `apple-touch-icon` +
the manifest, and sets `<meta name="theme-color" content="#cc0000">`.

### Regenerating the icons

The PNG/ICO set is rasterized from small source SVGs. The source SVGs and the
build steps (render with a rasterizer, downscale to each size, pack the `.ico`)
are not checked in — regenerate from `favicon.svg` / `logo-mark.svg` if the mark
changes. The tile crop (`viewBox="3 3.5 58 58"`) trims the mark's bounding box so
it fills the tile with no dead padding.

## Do / don't

- **Do** recolor the mark with `text-*` (it's `currentColor`); keep it one color.
- **Do** keep the mark symmetric and the container centred.
- **Don't** add a bridge or a "B" — the identity is the crane, not the name.
- **Don't** stretch the lockup; size it by font-size so the mark tracks the type.
- **Don't** reintroduce raster `logo.png`/`favicon.png` in the app — use `<Logo>`.
