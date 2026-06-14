import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface EntityFilterPillsProps {
  items: { id: string; name: string }[];
  /** Currently-selected entity ids (empty = no filter / "all"). */
  selected: string[];
  onToggle: (id: string) => void;
  /** When provided, renders a leading "All" pill that clears the filter. */
  onClear?: () => void;
  allLabel?: string;
  className?: string;
}

/**
 * Shared entity filter pills for the monitoring pages (#250) — one toggle pill
 * per server/service/database, replacing the per-page hand-rolled variants.
 */
export function EntityFilterPills({
  items,
  selected,
  onToggle,
  onClear,
  allLabel = 'All',
  className,
}: EntityFilterPillsProps) {
  if (items.length === 0) return null;
  const noneSelected = selected.length === 0;

  return (
    <div className={cn('flex flex-wrap items-center gap-1.5', className)}>
      {onClear && (
        <Button
          type="button"
          size="sm"
          variant={noneSelected ? 'default' : 'outline'}
          aria-pressed={noneSelected}
          onClick={onClear}
          className="rounded-full"
        >
          {allLabel}
        </Button>
      )}
      {items.map((item) => {
        const active = selected.includes(item.id);
        return (
          <Button
            key={item.id}
            type="button"
            size="sm"
            variant={active ? 'default' : 'outline'}
            aria-pressed={active}
            onClick={() => onToggle(item.id)}
            className="rounded-full"
          >
            {item.name}
          </Button>
        );
      })}
    </div>
  );
}

export default EntityFilterPills;
