import '@testing-library/jest-dom/vitest';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { renderMarkdown } from './markdown';

function MarkdownPreview({ text }: { text: string }) {
  return <div>{renderMarkdown(text)}</div>;
}

describe('renderMarkdown', () => {
  it('renders safe links with tab-nabbing protection', () => {
    render(<MarkdownPreview text='[docs](https://example.com)' />);

    const link = screen.getByRole('link', { name: 'docs' });
    expect(link).toHaveAttribute('href', 'https://example.com/');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
    expect(link).toHaveAttribute('rel', expect.stringContaining('noreferrer'));
  });

  it('canonicalizes safe markdown link hrefs before rendering', () => {
    render(<MarkdownPreview text='[docs](HTTPS://Example.com/Path?ref=chat)' />);

    const link = screen.getByRole('link', { name: 'docs' });
    expect(link).toHaveAttribute('href', 'https://example.com/Path?ref=chat');
  });

  it('detects and canonicalizes bare uppercase urls', () => {
    render(<MarkdownPreview text='See HTTPS://Example.com/Path?ref=chat for details.' />);

    const link = screen.getByRole('link', { name: 'HTTPS://Example.com/Path?ref=chat' });
    expect(link).toHaveAttribute('href', 'https://example.com/Path?ref=chat');
  });

  it('rejects javascript and data urls in markdown links', () => {
    render(<MarkdownPreview text='[click me](javascript:alert(1)) [raw](data:text/html,<script>alert(1)</script>)' />);

    expect(screen.queryByRole('link', { name: 'click me' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'raw' })).toBeNull();
    expect(screen.getByText('[unsafe link: click me]')).toBeTruthy();
    expect(screen.getByText('[unsafe link: raw]')).toBeTruthy();
  });

  it('rejects relative and protocol-relative markdown links', () => {
    render(<MarkdownPreview text='[docs](/docs/guide) [mirror](//example.com/docs)' />);

    expect(screen.queryByRole('link', { name: 'docs' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'mirror' })).toBeNull();
    expect(screen.getByText('[unsafe link: docs]')).toBeTruthy();
    expect(screen.getByText('[unsafe link: mirror]')).toBeTruthy();
  });
});
