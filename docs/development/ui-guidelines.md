# UI/UX Guidelines

The UI is built on **shadcn/ui** (Radix primitives + Tailwind v4 + CSS-variable
theming). Primitives live in `ui/src/components/ui/`; app composites and pages
build on them. There is **no** hand-rolled design system anymore — no `.btn` /
`.card` / `.panel` / `.badge` classes, no `window.confirm`, no raw `<select>`,
no `bg-slate-800/900`, no inline icon `<svg>`.

## 1. Theming & tokens

Colors are CSS variables defined in `ui/src/index.css`: `:root` is the **light**
palette, `.dark` is **Deep Slate** (shell `#0a0e14`). `@theme inline` maps each
token to a Tailwind utility, so always style with semantic tokens — never raw
`slate-*`/`primary-600` ramps:

| Token (utility)            | Use                                              |
|----------------------------|--------------------------------------------------|
| `bg-background` / `text-foreground` | app shell surface + text                |
| `bg-card` / `text-card-foreground`  | cards, panels, dialogs                  |
| `bg-muted` / `text-muted-foreground`| subtle fills, secondary text            |
| `border` (border-border)   | default borders/dividers                         |
| `bg-primary` (sky `#0284c7`)| default actions, focus ring, links              |
| `bg-destructive` (red `#dc2626`)| delete / danger                             |
| `bg-brand` (burgundy `#cc0000`)| nav / admin / identity (sidebar active stripe)|
| `bg-success/warning/info`  | semantic status accents                          |
| `--chart-1..5`             | chart series (via `ChartContainer`)              |
| `--sidebar-*`              | the Sidebar block                                |

**Theme switching:** `ThemeProvider` (`@/components/theme-provider`) +
`useTheme()` manage `'system' | 'light' | 'dark'` (default **system**), persist
to `localStorage['bridgeport-theme']`, toggle the `dark` class on `<html>`, and
track OS changes live. A no-FOUC script in `index.html` applies the same
resolution before first paint. Users switch via the **System/Light/Dark**
submenu in the user-menu dropdown.

## 2. Primitives & how to add them

Add new shadcn components with the CLI (config in `ui/components.json`,
`new-york` / `slate` / CSS variables / `lucide`):

```bash
cd ui && pnpm dlx shadcn@latest add <component>
```

The v3 CLI uses the unified `radix-ui` package and may not pull `clsx` /
`tailwind-merge` / `class-variance-authority` / `lucide-react` — add those
explicitly if a fresh component imports them. All shadcn deps are pure-JS (no
`allowBuilds` entry needed).

- **Button** — variants `default | destructive | outline | secondary | ghost |
  link`; sizes `default | xs | sm | lg | icon | icon-xs | icon-sm`. Use
  `asChild` to wrap a `<Link>`.
- **Badge** — variants `default | secondary | destructive | outline | ghost |
  link | success | warning | info | neutral`.
- **Dialog** — all modals. Controlled: `<Dialog open={...} onOpenChange={(o) => !o && onClose()}>`.
- **AlertDialog** — destructive confirmations (used by `useConfirm`).
- Radix `Select` forbids empty-string item values — use a sentinel
  (`'all'` / `'__none__'`) and map back to `''`/`null` at the boundary.

## 3. Status display

Never hand-roll status colors. Use `statusVariant(kind, value)` from
`@/lib/status` (kinds: `container | health | server | deployment | backup | sync
| overall | severity`) and the **StatusBadge** composite:

```tsx
<StatusBadge kind="health" value={server.health} dot />
```

For a non-mapped value, pass an explicit `variant`. For numeric danger zones use
`metricSeverity(value, warn, crit)`.

## 4. Confirmations & toasts

- **`useConfirm()`** (`@/hooks/useConfirm`) replaces `window.confirm`. Mounted
  app-wide via `ConfirmProvider`:
  ```tsx
  const confirm = useConfirm();
  if (await confirm({ title: 'Delete server?', description: '…', destructive: true })) { … }
  ```
- **Toasts** are Sonner. Import `toast` from `@/components/Toast` (or the
  back-compat `useToast()`); the `<Toaster/>` is mounted once in `main.tsx`.
  Surface API errors with `toast.error(getErrorMessage(err, '…'))`.

## 5. Forms

Create/edit forms use **react-hook-form + zod** with the shadcn `Form` set:

```tsx
const schema = z.object({ name: z.string().min(1) });
const form = useForm({ resolver: zodResolver(schema), defaultValues });
<Form {...form}>
  <form onSubmit={form.handleSubmit(onSubmit)}>
    <FormField control={form.control} name="name" render={({ field }) => (
      <FormItem><FormLabel>Name</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
    )} />
  </form>
</Form>
```

Inline validation via `FormMessage`; server errors via `Alert` / `toast`. Dirty
gating with `form.formState.isDirty` (see `HealthConfigEditor`).

## 6. Composites

| Composite | Purpose |
|-----------|---------|
| `PageHeader` / `Section` / `Panel` (`@/components/ui/page-header`) | section title (no `<h1>`) / grouped block / bordered container |
| `EmptyState` (`@/components/ui/empty-state`) | empty lists, with optional icon + action |
| `DataPagination` (`@/components/ui/data-pagination`) | 0-based pager, pairs with `usePagination`/`usePaginatedFetch` |
| `TableSkeleton` (`@/components/ui/table-skeleton`) / `Skeleton` | loading states |
| `CopyButton` (`@/components/ui/copy-button`) | copy secrets / commands / digests |
| `EntityFilterPills` (`@/components/monitoring/EntityFilterPills`) | server/service/db filter pills |
| `ChartCard` / `ChartContainer` | themed Recharts (series from `--chart-1..5`) |

## 7. Icons

`lucide-react` is the single icon source. `components/Icons.tsx` re-exports
lucide under the legacy `*Icon` names; new code may import from `lucide-react`
directly. No hand-defined icon `<svg>`.

## 8. App shell & layout

- Built on the shadcn **Sidebar** block (`SidebarProvider`/`Sidebar`/`SidebarMenu`),
  collapsible to icons + mobile Sheet drawer. Active items show the burgundy
  `--sidebar-primary` stripe.
- **No `<h1>` page titles** — the **Breadcrumb** owns the page title; pages add
  only a description and (on detail pages) the item name as styled text.
- ⌘K / Ctrl-K opens the **Command palette** (page jump + entity search).
- Cards for most lists; **Table** for dense data (audit logs, health history).

## 9. Accessibility

Radix gives focus-trap / Escape / `aria-modal` / `role` / `aria-expanded` /
`progressbar` for free; Sonner provides `aria-live`. Keep it that way:

- Icon-only buttons get an `aria-label` (and/or `title`).
- Form fields get `id` + `<Label htmlFor>` (the `Form` set wires this) and
  appropriate `autoComplete`.
- Prefer **role-based** test queries (`getByRole('dialog' | 'combobox' |
  'switch' | 'tab')` + accessible names) over class/markup assertions. The Radix
  jsdom polyfills in `ui/test/setup.ts` (pointer capture, `scrollIntoView`,
  `ResizeObserver`, `matchMedia`) make the primitives testable.

## 10. Preferences (Zustand)

Persist user-configurable UI state (filters, time ranges, collapse states,
auto-refresh, sort) via `useAppStore` (`ui/src/lib/store.ts`) with the `persist`
middleware + `partialize`. Key pattern: `{pageName}{PreferenceName}`. Dismissals
that should reset on browser close stay session-only.

## Reference implementations

- **List (cards)**: `Servers.tsx`, `Services.tsx`, `Databases.tsx`, `Registries.tsx`
- **List (table)**: `admin/Users.tsx`, `admin/Audit.tsx`
- **Forms**: `AccountModal.tsx`, `HealthConfigEditor.tsx`, `admin/Integrations.tsx`
- **Charts/monitoring**: `MonitoringServers.tsx` + `components/monitoring/*`
- **Shell**: `AppSidebar.tsx`, `TopBar.tsx`, `CommandPalette.tsx`
