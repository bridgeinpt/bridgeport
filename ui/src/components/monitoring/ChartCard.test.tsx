import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import ChartCard from './ChartCard';

describe('ChartCard', () => {
  it('should render title', () => {
    render(
      <ChartCard
        title="CPU Usage"
        data={[]}
        names={['cpu']}
        formatTime={(t) => t}
      />
    );
    expect(screen.getByText('CPU Usage')).toBeInTheDocument();
  });

  it('should show "No data available" when data is empty', () => {
    render(
      <ChartCard
        title="CPU Usage"
        data={[]}
        names={['cpu']}
        formatTime={(t) => t}
      />
    );
    expect(screen.getByText('No data available')).toBeInTheDocument();
  });

  it('should render chart container when data is provided', () => {
    const data = [
      { time: '2024-01-01T00:00:00Z', cpu: 45.2 },
      { time: '2024-01-01T01:00:00Z', cpu: 67.8 },
    ];

    const { container } = render(
      <ChartCard
        title="CPU Usage"
        data={data}
        names={['cpu']}
        formatTime={(t) => t}
        unit="%"
      />
    );

    // Chart should render (Recharts uses SVG)
    expect(screen.getByText('CPU Usage')).toBeInTheDocument();
    // Should not show empty state
    expect(screen.queryByText('No data available')).not.toBeInTheDocument();
    // ResponsiveContainer renders a div wrapper
    expect(container.querySelector('.recharts-responsive-container')).toBeInTheDocument();
  });
});
