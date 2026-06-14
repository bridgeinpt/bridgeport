import { RefreshCw } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface AutoRefreshToggleProps {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
  onRefresh: () => void;
  refreshing?: boolean;
}

export default function AutoRefreshToggle({ enabled, onChange, onRefresh, refreshing }: AutoRefreshToggleProps) {
  return (
    <div className="flex items-center gap-3">
      <Label className="flex items-center gap-2 text-sm text-muted-foreground">
        <Switch checked={enabled} onCheckedChange={onChange} aria-label="Auto-refresh" />
        Auto: 30s
      </Label>
      <Button variant="secondary" size="sm" onClick={onRefresh} disabled={refreshing}>
        <RefreshCw className={cn('size-4', refreshing && 'animate-spin')} />
        {refreshing ? 'Refreshing...' : 'Refresh'}
      </Button>
    </div>
  );
}
