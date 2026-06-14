import {
  Anchor,
  Boxes,
  RefreshCw,
  BarChart3,
  HeartPulse,
  Database,
  Lock,
  Bell,
  Workflow,
  Heart,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';

// App version is baked in at build time via Vite
const appVersion = import.meta.env.VITE_APP_VERSION || 'dev';

const features = [
  { icon: Anchor, label: 'Multi-environment management' },
  { icon: Boxes, label: 'Docker service orchestration' },
  { icon: RefreshCw, label: 'Deployment orchestration with auto-rollback' },
  { icon: BarChart3, label: 'Server, service & database monitoring' },
  { icon: HeartPulse, label: 'Health checks & agent monitoring' },
  { icon: Database, label: 'Database backups & monitoring' },
  { icon: Lock, label: 'Secret & config file management' },
  { icon: Bell, label: 'Multi-channel notifications' },
  { icon: Workflow, label: 'Interactive service topology' },
];

export default function About() {
  return (
    <div className="mx-auto max-w-2xl p-8">
      <Card>
        <CardContent className="text-center">
          {/* Logo and Title */}
          <div className="mb-6">
            <img src="/logo.png" alt="BRIDGEPORT" className="mx-auto mb-4 h-28" />
            <p className="mt-1 font-medium text-primary">Dock. Run. Ship. Repeat.</p>
            <p className="mt-2 text-sm text-muted-foreground">v{appVersion}</p>
          </div>

          <Separator className="my-6" />

          {/* Description */}
          <div className="mb-6 text-left">
            <p className="text-foreground">
              A lightweight deployment management tool for teams who want simple,
              reliable container orchestration without enterprise complexity.
            </p>
          </div>

          {/* Features */}
          <div className="mb-6 text-left">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Features
            </h2>
            <ul className="space-y-2 text-foreground">
              {features.map(({ icon: Icon, label }) => (
                <li key={label} className="flex items-center gap-3">
                  <Icon className="size-5 shrink-0 text-primary" />
                  {label}
                </li>
              ))}
            </ul>
          </div>

          <Separator className="my-6" />

          {/* Credits */}
          <div className="text-center">
            <p className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground">
              Created with
              <Heart className="size-4 fill-destructive text-destructive" aria-label="love" />
              by the Engineering Team at
            </p>
            <a
              href="https://bridgein.pt"
              target="_blank"
              rel="noopener noreferrer"
              className="block text-xl font-bold text-foreground transition-colors hover:text-primary"
            >
              BridgeIn
            </a>
            <p className="mt-1 text-sm text-muted-foreground">bridgein.pt</p>
          </div>

          <Separator className="my-6" />

          {/* Copyright */}
          <p className="text-xs text-muted-foreground">
            &copy; 2024-2026 BridgeIn. All rights reserved.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
