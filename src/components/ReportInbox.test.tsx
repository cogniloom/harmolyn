// Round-10: the owner-facing moderation inbox actually renders received reports (previously
// nothing consumed runtimeSnapshot.reports) and lets the owner resolve them.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReportInbox } from './ReportInbox';
import type { XoreinReport } from '@/types';

const resolveMutate = vi.fn();

let reports: XoreinReport[] = [];

vi.mock('@/lib/xoreinRuntimeContext', async () => {
  const actual = await vi.importActual<typeof import('@/lib/xoreinRuntimeContext')>('@/lib/xoreinRuntimeContext');
  return { ...actual, useRuntimeSnapshot: () => ({ reports }) };
});

vi.mock('@/hooks/runtime/mutations', () => ({
  useResolveReport: () => ({ mutate: resolveMutate, isPending: false }),
}));

function mkReport(over: Partial<XoreinReport>): XoreinReport {
  return {
    id: 'r1', reason: 'Spam', target_kind: 'message', target_id: 'm1',
    server_id: 'srv1', reporter_peer_id: 'alice', created_at: '2026-01-01T00:00:00.000Z',
    inbound: true, ...over,
  };
}

describe('ReportInbox', () => {
  beforeEach(() => { resolveMutate.mockClear(); reports = []; });

  it('renders inbound reports for the server and resolves one on click', async () => {
    reports = [mkReport({ id: 'r1', reason: 'Harassment', content_excerpt: 'nasty text', reported_peer_id: 'bob' })];
    render(<ReportInbox serverId="srv1" />);

    expect(screen.getByText('Harassment')).toBeInTheDocument();
    expect(screen.getByText('nasty text')).toBeInTheDocument();
    expect(screen.getByText(/1 open report/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /resolve/i }));
    expect(resolveMutate).toHaveBeenCalledWith({ reportId: 'r1', resolved: true });
  });

  it('excludes reports for other servers and outbound (non-inbound) copies', () => {
    reports = [
      mkReport({ id: 'r-other', server_id: 'srv2', reason: 'Elsewhere' }),
      mkReport({ id: 'r-outbound', inbound: false, reason: 'MyOwnReport' }),
    ];
    render(<ReportInbox serverId="srv1" />);
    expect(screen.queryByText('Elsewhere')).not.toBeInTheDocument();
    expect(screen.queryByText('MyOwnReport')).not.toBeInTheDocument();
    expect(screen.getByText('Nothing to review')).toBeInTheDocument();
  });

  it('hides resolved reports until "Show resolved" is toggled', async () => {
    reports = [mkReport({ id: 'r-done', reason: 'Resolved one', resolved: true })];
    render(<ReportInbox serverId="srv1" />);
    expect(screen.queryByText('Resolved one')).not.toBeInTheDocument();
    await userEvent.click(screen.getByText(/show resolved/i));
    expect(screen.getByText('Resolved one')).toBeInTheDocument();
  });
});
