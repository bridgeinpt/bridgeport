import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { EmptyState } from './empty-state';
import { PageHeader, Section, Panel } from './page-header';
import { TableSkeleton } from './table-skeleton';
import { StatusBadge } from './status-badge';
import { Alert, AlertTitle, AlertDescription } from './alert';
import { Progress } from './progress';
import { Switch } from './switch';
import { Tabs, TabsList, TabsTrigger, TabsContent } from './tabs';
import { Button } from './button';

/**
 * Phase 1 acceptance (#244): composites + a representative slice of primitives
 * mount under the Deep Slate token layer. Stands in for the sandbox route.
 */
describe('Phase 1 composites + primitives (Deep Slate smoke)', () => {
  it('mounts the layout composites', () => {
    render(
      <>
        <PageHeader
          title="Servers"
          description="Manage your servers"
          actions={<Button>Create</Button>}
        />
        <Section title="Group">
          <Panel>content</Panel>
        </Section>
        <EmptyState
          message="No servers yet"
          description="Add one to begin"
          action={{ label: 'Add server', onClick: () => {} }}
        />
        <TableSkeleton rows={2} columns={3} />
        <StatusBadge kind="server" value="healthy" />
      </>
    );

    expect(screen.getByRole('heading', { name: 'Servers' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create' })).toBeInTheDocument();
    expect(screen.getByText('No servers yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add server' })).toBeInTheDocument();
    expect(screen.getByText('healthy')).toBeInTheDocument();
  });

  it('mounts primitives with semantic variants', () => {
    render(
      <>
        <Alert variant="success">
          <AlertTitle>Saved</AlertTitle>
          <AlertDescription>Changes persisted</AlertDescription>
        </Alert>
        <Progress value={42} />
        <Switch aria-label="Enable feature" />
        <Tabs defaultValue="a">
          <TabsList>
            <TabsTrigger value="a">A</TabsTrigger>
            <TabsTrigger value="b">B</TabsTrigger>
          </TabsList>
          <TabsContent value="a">Panel A</TabsContent>
        </Tabs>
      </>
    );

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
    expect(screen.getByRole('switch')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'A' })).toBeInTheDocument();
  });
});
