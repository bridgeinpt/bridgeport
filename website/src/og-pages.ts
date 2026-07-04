import { getCollection } from 'astro:content';

export interface OgPage {
  title: string;
  description?: string;
}

/**
 * The set of routes that get a generated Open Graph image, keyed by OG path
 * (route path without leading/trailing slashes; '' → 'index').
 *
 * Shared by the /og/[...route].png endpoint (which generates the images) and
 * the Head override (which only points og:image at a generated file when one
 * exists for the route — everything else falls back to the static card).
 */

// Custom .astro pages aren't content-collection entries, so they're listed here.
// Keep in sync when adding marketing pages.
const CUSTOM_PAGES: Record<string, OgPage> = {
  index: {
    title: 'Self-Hosted Docker Deployment, Orchestration & Monitoring',
    description: 'Production-grade ops for your Docker servers — without Kubernetes.',
  },
  faq: {
    title: 'Frequently Asked Questions',
    description: 'What BridgePort is, how it connects to your servers, and how it keeps deployments safe.',
  },
  roadmap: {
    title: "What's Next",
    description: 'The BridgePort roadmap, generated from the GitHub issue tracker.',
  },
  compare: {
    title: 'BridgePort vs the alternatives',
    description: 'Honest comparisons with Kubernetes, Docker Compose, Portainer, Coolify, Dokploy, and CapRover.',
  },
  'compare/kubernetes': {
    title: 'BridgePort vs Kubernetes',
    description: 'Fleet control plane vs cluster orchestrator — an honest comparison.',
  },
  'compare/docker-compose': {
    title: 'BridgePort vs Docker Compose',
    description: 'Fleet control plane vs single-host tooling — an honest comparison.',
  },
  'compare/portainer': {
    title: 'BridgePort vs Portainer',
    description: 'Deployment control plane vs container platform GUI — an honest comparison.',
  },
  'compare/coolify': {
    title: 'BridgePort vs Coolify',
    description: 'Fleet control plane vs self-hosted PaaS — an honest comparison.',
  },
  'compare/dokploy': {
    title: 'BridgePort vs Dokploy',
    description: 'Fleet control plane vs self-hosted PaaS — an honest comparison.',
  },
  'compare/caprover': {
    title: 'BridgePort vs CapRover',
    description: 'Fleet control plane vs Swarm-based PaaS — an honest comparison.',
  },
  'use-cases': {
    title: 'What teams use BridgePort for',
    description: 'Multi-server deploys, self-hosted monitoring, secrets management, and CI/CD rollouts.',
  },
  'use-cases/deploy-docker-multiple-servers': {
    title: 'Deploy Docker Containers to Multiple Servers',
    description: 'One control plane, every server — health-gated rollouts with automatic rollback.',
  },
  'use-cases/docker-monitoring': {
    title: 'Self-Hosted Docker Monitoring',
    description: 'Metrics, health checks, and alerts on your infrastructure — no SaaS, no Prometheus stack.',
  },
  'use-cases/docker-secrets-management': {
    title: 'Docker Secrets & Config Management',
    description: 'AES-256-GCM encryption, templated config, usage tracking, atomic sync.',
  },
  'use-cases/ci-cd-deployments': {
    title: 'Automate Docker Deployments from CI/CD',
    description: 'git push → CI builds → BridgePort ships, with rollback if health checks fail.',
  },
};

let cache: Record<string, OgPage> | null = null;

export async function getOgPages(): Promise<Record<string, OgPage>> {
  if (cache) return cache;
  const docs = await getCollection('docs');
  const pages: Record<string, OgPage> = { ...CUSTOM_PAGES };
  for (const entry of docs) {
    // Entry ids are route-shaped ('getting-started', 'guides/secrets').
    pages[entry.id] = {
      title: entry.data.title,
      description: entry.data.description,
    };
  }
  cache = pages;
  return pages;
}
