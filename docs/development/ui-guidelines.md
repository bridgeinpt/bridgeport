# UI/UX Guidelines

## 1. Persist User Preferences

All user-configurable UI state should be persisted to localStorage via Zustand:

**Must persist:**
- Filter selections (toggles, dropdowns)
- Time range selections
- Collapse/expand states
- Auto-refresh toggles
- Sort preferences

**Use existing patterns:**
- Extend `useAppStore` in `ui/src/lib/store.ts`
- Use Zustand's `persist` middleware with `partialize`
- Key pattern: `{pageName}{PreferenceName}` (e.g., `servicesShowUpdatesOnly`)

## 2. Information Hierarchy

Dashboard and list pages should follow clear hierarchy:
1. **Alerts/Actions first** - Things requiring attention
2. **Summary cards** - High-level counts and status
3. **Primary content** - Main data (services, health grid)
4. **Secondary content** - Updates, activity, detailed tables

Avoid overloading pages with redundant data - link to detail pages instead.

## 3. Consistent Patterns

- **Page titles**: Do NOT add `<h1>` titles in pages - titles are shown in breadcrumbs (TopBar). Pages should only have a description paragraph (`<p className="text-slate-400">`). Detail pages show the item name as styled text (`<span className="text-xl font-bold">`), not `<h1>`.
- **Filters**: Use segmented buttons for time ranges, checkboxes for boolean filters
- **Status colors**: Always use `ui/src/lib/status.ts` utilities
- **Dismissible items**: Alerts/notifications should be dismissible (session-only)
- **Loading states**: Use skeleton placeholders, not spinners
- **Tabs**: Use underline style with `border-brand-600 text-white` for active state

## 4. State Management Rules

- **Page-local state**: Only for truly ephemeral UI (modal open, hover states)
- **Zustand store**: For anything that should survive navigation
- **Session storage**: For dismissals that should reset on browser close

## 5. List Page Patterns

All list pages should follow consistent patterns for layout, navigation, and actions.

### Card Layout (Standard for most lists)

Use this structure for Servers, Databases, Registries, and similar resource lists:

```tsx
<div className="panel">
  <div className="flex items-start justify-between">
    <div className="flex items-start gap-4">
      {/* Icon container */}
      <div className="p-3 bg-slate-800 rounded-lg">
        <ResourceIcon className="w-6 h-6 text-primary-400" />
      </div>
      <div>
        {/* Row 1: Name + badges */}
        <div className="flex items-center gap-2 flex-wrap">
          <Link to={`/resource/${item.id}`} className="text-lg font-semibold text-white hover:text-primary-400">
            {item.name}
          </Link>
          <span className="badge bg-green-500/20 text-green-400 text-xs">status</span>
          <span className="badge bg-slate-700 text-slate-300 text-xs">type</span>
        </div>
        {/* Row 2: Subtitle (monospace for technical info) */}
        <p className="text-slate-400 text-sm mt-1 font-mono">{item.technicalInfo}</p>
        {/* Row 3: Metadata */}
        <div className="flex items-center gap-4 mt-2 text-xs text-slate-500">
          <span>Count info</span>
          <span>Timestamp info</span>
        </div>
      </div>
    </div>
    {/* Action buttons */}
    <div className="flex gap-2">
      <button className="btn btn-ghost text-sm">Secondary</button>
      <button className="btn btn-primary text-sm">Primary</button>
    </div>
  </div>
</div>
```

### Table Layout (For dense tabular data)

Use tables when showing many columns of comparable data where rows need side-by-side comparison:

```tsx
<table className="w-full">
  <thead>
    <tr className="text-left text-slate-400 text-sm border-b border-slate-700">
      <th className="pb-3 font-medium">Name</th>
      {/* More columns... */}
    </tr>
  </thead>
  <tbody className="divide-y divide-slate-700">
    <tr className="text-slate-300">
      <td className="py-4">
        <Link to={`/item/${id}`} className="text-white hover:text-primary-400 font-medium">
          {name}
        </Link>
      </td>
    </tr>
  </tbody>
</table>
```

**Note:** Prefer card layout for most lists. Tables are best for audit logs, health check history, and similar dense data.

### Navigation Rules

- **If page has a detail view**: Make the item name a `<Link>` - do NOT add a separate "View" button
- **If page uses modals only**: Use action buttons (Edit, Delete) without navigation links
- **Never have both**: A clickable name AND a "View" button (redundant)

### Action Button Conventions (Hybrid Pattern)

Action buttons use a hybrid pattern: context-specific actions as text buttons, standard actions as icon-only buttons.

**Hybrid Layout:**
```tsx
<div className="flex items-center gap-2">
  {/* Context-specific: text buttons */}
  <button className="btn btn-primary text-sm">Deploy latest</button>
  <button className="btn btn-ghost text-sm">Discover</button>

  {/* Standard actions: icon-only buttons */}
  <button className="p-1.5 text-slate-400 hover:text-white rounded" title="View">
    <EyeIcon className="w-4 h-4" />
  </button>
  <button className="p-1.5 text-slate-400 hover:text-white rounded" title="Edit">
    <PencilIcon className="w-4 h-4" />
  </button>
  <button className="p-1.5 text-slate-400 hover:text-red-400 rounded" title="Delete">
    <TrashIcon className="w-4 h-4" />
  </button>
</div>
```

**What goes where:**

| Action Type | Style | Examples |
|-------------|-------|----------|
| Primary/context-specific | Text button (`btn btn-primary`) | Deploy, Backup, Check Updates |
| Secondary context-specific | Text button (`btn btn-ghost`) | Discover, View Services, Reveal/Hide |
| View (detail page) | Icon-only (`EyeIcon`) | View database, View details |
| Edit | Icon-only (`PencilIcon`) | Edit settings, Edit config |
| Delete | Icon-only (`TrashIcon`, red hover) | Delete resource |
| Health Check | Icon-only (`HeartPulseIcon`) | Server/service health check |

**Icon Button Styling:**
```tsx
{/* Standard icon button */}
<button className="p-1.5 text-slate-400 hover:text-white rounded" title="Edit">
  <PencilIcon className="w-4 h-4" />
</button>

{/* Destructive icon button */}
<button className="p-1.5 text-slate-400 hover:text-red-400 rounded" title="Delete">
  <TrashIcon className="w-4 h-4" />
</button>
```

**Important:** Always include `title` attribute on icon-only buttons for accessibility.

### Status Badges

Use consistent badge styling:
```tsx
// Success/Healthy
<span className="badge bg-green-500/20 text-green-400 text-xs">healthy</span>

// Warning/Pending
<span className="badge bg-yellow-500/20 text-yellow-400 text-xs">pending</span>

// Error/Unhealthy
<span className="badge bg-red-500/20 text-red-400 text-xs">unhealthy</span>

// Neutral/Info
<span className="badge bg-slate-700 text-slate-300 text-xs">type</span>

// Special (e.g., Host, Default)
<span className="badge bg-purple-500/20 text-purple-400 text-xs">Host</span>
```

### Empty States

Always use the `EmptyState` component with an icon:
```tsx
<EmptyState
  icon={ResourceIcon}
  message="No items configured"
  description="Add an item to get started"
  action={{ label: 'Add Your First Item', onClick: () => setShowCreate(true) }}
/>
```

### Pagination

- Use `usePagination` hook with `defaultPageSize: 25`
- Place `<Pagination>` component after the list
- Only show pagination when there are items

### Reference Implementations

- **Card layout**: `Services.tsx`, `Servers.tsx`, `Databases.tsx`, `Registries.tsx`, `Secrets.tsx`
- **Table layout**: Health check logs, audit logs (dense tabular data)
- **Grid layout**: `ConfigFiles.tsx` (special case for compact items)
