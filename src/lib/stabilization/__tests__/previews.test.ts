import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { extractMediaPreviews, MAX_MEDIA_PREVIEWS, MAX_PREVIEW_SCAN, safeDownloadName, safePreviewMime } from '../previews';

describe('untrusted media previews', () => {
  it('bounds preview count and deduplicates canonical URLs', () => {
    assert.equal(extractMediaPreviews('https://example.com/a.png https://example.com/a.png').length, 1);
    assert.equal(extractMediaPreviews(Array.from({ length: 10_000 }, (_, i) => `https://example.com/${i}.png`).join(' ')).length, MAX_MEDIA_PREVIEWS);
  });
  it('does not request a truncated URL prefix', () => {
    const content = `${' '.repeat(MAX_PREVIEW_SCAN - 24)}https://example.com/image.png?secret=not-a-new-url`;
    assert.deepEqual(extractMediaPreviews(content), []);
  });
  it('recognizes only actual YouTube hosts, not deceptive substrings', () => {
    assert.equal(extractMediaPreviews('https://youtu.be/abcdefghijk')[0].kind, 'video');
    assert.equal(extractMediaPreviews('https://evil.example/youtube.com/watch?v=abcdefghijk')[0].kind, 'link');
    assert.equal(extractMediaPreviews('https://youtube.com.evil.example/watch?v=abcdefghijk')[0].kind, 'link');
  });
  it('does not embed credentials, scripts or literal private-address images', () => {
    assert.deepEqual(extractMediaPreviews('https://user:password@example.com/a.png javascript:alert(1) data:image/png;base64,AA=='), []);
    for (const host of ['localhost', '127.0.0.1', '2130706433', '10.0.0.1', '192.168.0.1', '172.16.0.1', '[::1]', 'printer.local']) assert.equal(extractMediaPreviews(`http://${host}/x.png`)[0].kind, 'link');
  });
  it('serves executable attachments as downloads, not same-origin documents', () => {
    for (const type of ['image/svg+xml', 'text/html', 'application/xhtml+xml', 'text/javascript']) assert.equal(safePreviewMime(type), 'application/octet-stream');
    assert.equal(safePreviewMime('IMAGE/PNG; charset=utf-8'), 'image/png');
    assert.equal(safeDownloadName('../\u202eexample\u0000.svg'), '..__example_.svg');
    assert.equal(safeDownloadName(''), 'attachment');
  });
});

