import { describe, it, expect } from 'vitest';
import { normalizeEmailLinks } from './emailRender';

const LONG =
  'https://drive.google.com/drive/folders/1q7u7Qr7aH1JoP8D5k8rleFSJrgUWv7tf?usp=sharing';

const CANON =
  'color:#0066cc !important;text-decoration:underline !important;overflow-wrap:anywhere;word-break:break-word;';

describe('normalizeEmailLinks', () => {
  it('adds canonical style to a short link and keeps it one anchor', () => {
    const out = normalizeEmailLinks('<a href="https://www.iuovadesign.com">https://www.iuovadesign.com</a>');
    expect(out).toContain(CANON);
    expect((out.match(/<a\b/gi) || []).length).toBe(1);
  });

  it('merges a split URL continuation back into the anchor', () => {
    const split = `<a href="${LONG}">https://drive.google.com/driv</a>\n  e/folders/1q7u7Qr7aH1JoP8D5k8rleFSJrgUWv7tf?usp=sharing`;
    const out = normalizeEmailLinks(split);
    // Single anchor, full URL inside, nothing left outside.
    expect((out.match(/<a\b/gi) || []).length).toBe(1);
    const esc = LONG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    expect(out).toMatch(new RegExp(`<a href="${esc}"[^>]*>${esc}</a>`));
    expect(out).not.toMatch(/<\/a>\s*e\/folders/);
    expect(out).toContain(CANON);
  });

  it('handles a tracking href (continuation matched against original url)', () => {
    const href = `https://x.com/api/tracking/click/abc?url=${encodeURIComponent(LONG)}`;
    const split = `<a href="${href}">https://drive.google.com/driv</a>\n  e/folders/1q7u7Qr7aH1JoP8D5k8rleFSJrgUWv7tf?usp=sharing`;
    const out = normalizeEmailLinks(split);
    expect((out.match(/<a\b/gi) || []).length).toBe(1);
    expect(out).toContain(`https://drive.google.com/drive/folders/1q7u7Qr7aH1JoP8D5k8rleFSJrgUWv7tf?usp=sharing</a>`);
  });

  it('does not touch button or social anchors', () => {
    const btn =
      '<a href="https://x.com" data-te-button="" style="background-color:#2563EB;color:#fff;">Click</a>';
    expect(normalizeEmailLinks(btn)).toContain('background-color:#2563EB');
    const social =
      '<a href="https://instagram.com"><img src="i.png"></a>';
    expect(normalizeEmailLinks(social)).not.toContain(CANON);
  });

  it('normalizes nested spans that override color', () => {
    const out = normalizeEmailLinks(
      `<a href="${LONG}">Catalogue - <span style="color:#000000;">${LONG}</span></a>`,
    );
    expect(out).toContain(CANON);
    expect(out).not.toMatch(/<span[^>]*color:#000000/);
  });

  it('keeps a complete linked line intact (text + url in one anchor)', () => {
    const line = `Catalogue - <a href="${LONG}">${LONG}</a>`;
    const out = normalizeEmailLinks(line);
    expect((out.match(/<a\b/gi) || []).length).toBe(1);
    expect(out).toContain(`Catalogue - <a href="${LONG}" style="${CANON}">${LONG}</a>`);
  });
});
