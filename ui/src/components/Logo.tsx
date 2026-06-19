/**
 * BridgePort logo system.
 *
 * The mark is a port gantry crane carrying a shipping container — the "port"
 * in the name and a direct read on the product (deploy & orchestrate
 * containers). It's deliberately name-independent: no bridge, no "B" monogram.
 *
 * The mark is monochrome and drawn with `fill="currentColor"`, so a single
 * source recolors to burgundy / white / ink via a `text-*` class. The same
 * mark doubles as the app's loading animation (`<BrandLoader>` / `animated`):
 * the container lowers to the ground and lifts on a calm loop, driven by the
 * `.bp-crane-load` keyframes in index.css (which honor prefers-reduced-motion).
 */
import { cn } from '@/lib/utils';

/** The crane mark on its own. Defaults to brand burgundy; override with a text-* class. */
export function LogoMark({
  className,
  animated = false,
  title,
}: {
  className?: string;
  animated?: boolean;
  /** Accessible name. Omit when the mark is decorative (e.g. beside the wordmark). */
  title?: string;
}) {
  return (
    <svg
      viewBox="0 0 64 64"
      fill="currentColor"
      className={cn('text-brand', className)}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      {/* The load — cable + corrugated container. This group is what animates. */}
      <g className={animated ? 'bp-crane-load' : undefined}>
        <rect x="30.5" y="9" width="3" height="20" rx="1.5" />
        <rect x="20" y="27" width="24" height="2.6" rx="1.3" />
        <rect x="20" y="38.4" width="24" height="2.6" rx="1.3" />
        <rect x="21" y="29.6" width="2" height="8.8" />
        <rect x="25" y="29.6" width="2" height="8.8" />
        <rect x="29" y="29.6" width="2" height="8.8" />
        <rect x="33" y="29.6" width="2" height="8.8" />
        <rect x="37" y="29.6" width="2" height="8.8" />
        <rect x="41" y="29.6" width="2" height="8.8" />
      </g>
      {/* The gantry frame: splayed legs, feet, top beam, trolley. */}
      <polygon points="13,16 19,16 13,52 7,52" />
      <polygon points="45,16 51,16 57,52 51,52" />
      <rect x="4" y="52" width="14" height="4" rx="1.5" />
      <rect x="46" y="52" width="14" height="4" rx="1.5" />
      <rect x="11" y="9" width="42" height="7" rx="2" />
      <rect x="26" y="16" width="12" height="6" rx="1.5" />
    </svg>
  );
}

/**
 * Full logo. `mark` is the crane alone; `lockup` adds the BRIDGEPORT wordmark.
 * The mark stays brand burgundy; the wordmark uses the theme foreground so it
 * reads on both light and dark. Size the lockup with a text-* class — the mark
 * scales with the font (`em`).
 */
export function Logo({
  variant = 'lockup',
  className,
}: {
  variant?: 'mark' | 'lockup';
  className?: string;
}) {
  if (variant === 'mark') {
    return <LogoMark title="BridgePort" className={cn('size-8', className)} />;
  }
  return (
    <span className={cn('inline-flex items-center gap-2 text-xl', className)}>
      <LogoMark className="h-[1.15em] w-[1.15em] shrink-0" />
      <span className="font-semibold uppercase leading-none tracking-[0.07em] text-foreground">
        BridgePort
      </span>
    </span>
  );
}

/**
 * Loading indicator for big moments — app boot and lazy route loads — in place
 * of a generic spinner. Reduced-motion users see the mark held at the lifted
 * pose. Size the mark with a size-* class (defaults to size-10).
 */
export function BrandLoader({ className }: { className?: string }) {
  return (
    <span role="status" aria-label="Loading" className="inline-flex">
      <LogoMark animated className={cn('size-10', className)} />
    </span>
  );
}
