import { useState, ReactNode } from 'react';
import { ChevronDownIcon, ChevronRightIcon } from './Icons';

interface CollapsiblePanelProps {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
  badge?: ReactNode;
  className?: string;
}

/**
 * A collapsible panel for grouping related content with progressive disclosure.
 * Use on detail pages (ServiceDetail, ServerDetail) to organize sections.
 */
export function CollapsiblePanel({
  title,
  children,
  defaultOpen = true,
  badge,
  className = '',
}: CollapsiblePanelProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <div className={`panel ${className}`}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center justify-between w-full text-left"
        aria-expanded={isOpen}
      >
        <div className="flex items-center gap-2">
          {isOpen ? (
            <ChevronDownIcon className="w-4 h-4 text-slate-400" />
          ) : (
            <ChevronRightIcon className="w-4 h-4 text-slate-400" />
          )}
          <h3 className="text-lg font-semibold text-white">{title}</h3>
          {badge}
        </div>
      </button>
      {isOpen && <div className="mt-4">{children}</div>}
    </div>
  );
}

export default CollapsiblePanel;
