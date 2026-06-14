import * as React from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface CopyButtonProps extends Omit<React.ComponentProps<typeof Button>, 'onClick' | 'children' | 'value'> {
  /** Text to copy to the clipboard. */
  value: string;
  /** Optional visible label; omit for an icon-only button. */
  label?: string;
}

/**
 * Copy-to-clipboard button (#249): copies `value` and briefly swaps to a check.
 * Used for revealed secret values, CLI commands, log blocks, fragment content.
 */
export function CopyButton({ value, label, variant = 'ghost', size, className, ...props }: CopyButtonProps) {
  const [copied, setCopied] = React.useState(false);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (insecure context / denied) — no-op.
    }
  };

  const Icon = copied ? Check : Copy;
  return (
    <Button
      type="button"
      variant={variant}
      size={size ?? (label ? 'sm' : 'icon-sm')}
      onClick={onCopy}
      aria-label={label ? undefined : 'Copy to clipboard'}
      title={copied ? 'Copied' : 'Copy'}
      className={cn(className)}
      {...props}
    >
      <Icon className={cn('size-4', copied && 'text-success')} />
      {label}
    </Button>
  );
}

export default CopyButton;
