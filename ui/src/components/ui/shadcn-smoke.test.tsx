import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Button } from './button';
import { Card, CardHeader, CardTitle, CardContent } from './card';
import { Badge } from './badge';

/**
 * Phase 0 acceptance (#256): the shadcn primitives compile and render under the
 * Deep Slate token layer. A render smoke test stands in for the "scratch route"
 * so it stays CI-verifiable instead of leaving a throwaway route in the app.
 */
describe('shadcn primitives (Deep Slate smoke test)', () => {
  it('renders Button, Card, and Badge together', () => {
    render(
      <Card>
        <CardHeader>
          <CardTitle>Deep Slate</CardTitle>
        </CardHeader>
        <CardContent>
          <Badge variant="default">Active</Badge>
          <Button>Deploy</Button>
        </CardContent>
      </Card>
    );

    expect(screen.getByRole('button', { name: 'Deploy' })).toBeInTheDocument();
    expect(screen.getByText('Deep Slate')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('applies token-based variant classes', () => {
    render(<Button variant="destructive">Delete</Button>);
    expect(screen.getByRole('button', { name: 'Delete' }).className).toContain('bg-destructive');
  });
});
