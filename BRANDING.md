# BridgePort Branding Plan

> This document captures the branding decisions and implementation plan for renaming BridgePort to BridgePort.

## Final Decisions

| Aspect | Value |
|--------|-------|
| **Name** | BridgePort |
| **Tagline** | Dock. Run. Ship. Repeat. |
| **License** | Closed source / Proprietary |
| **Created by** | Engineering Team at BridgeIn (bridgein.pt) |

---

## 1. Logo AI Generation Prompts

You need **2 images per option**: a main logo (header) and a favicon (browser tab).

---

### Option A: Port Crane (Recommended)

**Main Logo** (header/login, ~40-60px height):
```
Minimalist shipping port crane logo for "BridgePort" deployment tool,
geometric gantry crane silhouette lifting a container, sky blue
(#0ea5e9) accent on dark slate (#0f172a), modern tech aesthetic,
flat vector, clean angular lines, evokes Docker/containers,
horizontal layout suitable for header, professional SaaS branding
```

**Favicon** (browser tab, 16x16px):
```
Ultra-minimal gantry crane icon for favicon, single geometric shape,
sky blue (#0ea5e9) on transparent background, must be recognizable
at 16x16 pixels, abstract angular crane silhouette, no fine details,
bold simple form, flat vector
```

---

### Option B: Anchor + Crane

**Main Logo** (header/login, ~40-60px height):
```
Minimalist logo for "BridgePort" deployment tool, stylized anchor
integrated with a shipping port crane, geometric design, sky blue
accent color (#0ea5e9) on dark slate background (#0f172a), modern
tech startup aesthetic, flat vector style, clean lines, horizontal
header layout, professional SaaS product
```

**Favicon** (browser tab, 16x16px):
```
Ultra-minimal anchor icon for favicon, single geometric shape,
sky blue (#0ea5e9) on transparent background, must be recognizable
at 16x16 pixels, simplified anchor silhouette, no fine details,
bold simple form, flat vector
```

---

### Option C: Container Ship + Bridge

**Main Logo** (header/login, ~40-60px height):
```
Minimalist logo for "BridgePort", abstract container ship passing
under a bridge arch, single continuous line art style, sky blue
(#0ea5e9) on dark background, geometric and modern, tech company
logo, flat design, horizontal composition for header placement
```

**Favicon** (browser tab, 16x16px):
```
Ultra-minimal bridge arch icon for favicon, single geometric shape,
sky blue (#0ea5e9) on transparent background, must be recognizable
at 16x16 pixels, simple arch or ship bow silhouette, no fine details,
bold simple form, flat vector
```

---

### Option D: Stylized "B" + Waves

**Main Logo** (header/login, ~40-60px height):
```
Letter "B" logo for "BridgePort", stylized with wave elements at
the bottom suggesting water/port, geometric construction, sky blue
(#0ea5e9) on dark background, modern monogram style, professional
tech branding, horizontal layout for header
```

**Favicon** (browser tab, 16x16px):
```
Ultra-minimal letter "B" icon for favicon, geometric construction,
sky blue (#0ea5e9) on transparent background, must be recognizable
at 16x16 pixels, bold simple letterform with subtle wave hint,
no fine details, flat vector
```

---

## 2. About Page

### Location
- Route: `/about`
- File: `ui/src/pages/About.tsx`
- Access: Link in sidebar footer (info icon near user profile)

### Content Structure

```
+-------------------------------------------+
|           [BridgePort Logo]               |
|                                           |
|            BridgePort                     |
|      Dock. Run. Ship. Repeat.             |
|               v1.0.0                      |
+-------------------------------------------+
|                                           |
|  A lightweight deployment management      |
|  tool for teams who want simple,          |
|  reliable container orchestration         |
|  without enterprise complexity.           |
|                                           |
|  - Multi-environment management           |
|  - Docker service orchestration           |
|  - Secret management                      |
|  - Real-time activity monitoring          |
|  - Config file distribution               |
|                                           |
+-------------------------------------------+
|                                           |
|      Created with love by the             |
|      Engineering Team at                  |
|                                           |
|         [BRIDGEIN]                        |
|        bridgein.pt                        |
|                                           |
|   (c) 2024-2025 BridgeIn. All rights      |
|              reserved.                    |
|                                           |
+-------------------------------------------+
```

---

## 3. Files to Modify

| File | Changes |
|------|---------|
| `ui/index.html` | Title -> "BridgePort", add favicon link |
| `ui/src/pages/Login.tsx` | Replace rocket emoji with logo, update name/tagline |
| `ui/src/components/Layout.tsx` | Update sidebar header, add About link |
| `ui/src/pages/About.tsx` | **NEW** - About page component |
| `ui/src/App.tsx` | Add `/about` route |
| `ui/public/logo.svg` | **NEW** - Main logo (user provides) |
| `ui/public/favicon.svg` | **NEW** - Favicon (user provides) |
| `package.json` | Update name to "bridgeport" |
| `ui/package.json` | Update name to "bridgeport-ui" |
| `README.md` | Update all branding references |

---

## 4. Implementation Steps

### Step 1: Add logo files
- Generate logos using AI prompts above
- Save as `ui/public/logo.svg` and `ui/public/favicon.svg`

### Step 2: Update index.html
- Change `<title>BridgePort</title>` -> `<title>BridgePort</title>`
- Add favicon: `<link rel="icon" type="image/svg+xml" href="/favicon.svg" />`

### Step 3: Update Login.tsx
- Replace rocket emoji with `<img src="/logo.svg" />`
- Change "BridgePort" -> "BridgePort"
- Change tagline to "Dock. Run. Ship. Repeat."

### Step 4: Update Layout.tsx
- Replace rocket emoji with small logo
- Change sidebar title to "BridgePort"
- Add About link (info icon) in sidebar footer

### Step 5: Create About.tsx
- New page with branding, features, and BridgeIn credits
- Styled consistently with existing dark theme

### Step 6: Update App.tsx
- Add route: `<Route path="/about" element={<About />} />`

### Step 7: Update package.json files
- Backend: name -> "bridgeport"
- Frontend: name -> "bridgeport-ui"

### Step 8: Update README.md
- Replace all "BridgePort" references with "BridgePort"

---

## 5. Verification

1. `cd bridgeport/ui && npm run dev`
2. Check Login page: new logo, "BridgePort", new tagline
3. Check sidebar: logo and name updated
4. Click About link -> verify About page renders
5. Check browser tab: favicon + "BridgePort" title
6. `npm run build` -> verify production build succeeds

---

## Status

- [ ] Logo generated (main)
- [ ] Favicon generated
- [ ] index.html updated
- [ ] Login.tsx updated
- [ ] Layout.tsx updated
- [ ] About.tsx created
- [ ] App.tsx route added
- [ ] package.json files updated
- [ ] README.md updated
- [ ] Verified in dev
- [ ] Production build tested
