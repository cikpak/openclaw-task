import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const css = read('../apps/frontend/src/conversation/Conversation.module.css');
const popup = read('../apps/frontend/src/ui/HoverPopover.tsx');
const popupCss = read('../apps/frontend/src/ui/HoverPopover.module.css');

it('uses inline compact chips rather than large expanding cards or status text reservations', () => {
  expect(css).toMatch(
    /\.tool,\s*\.canonicalTool\s*\{[^}]*display: inline-flex;/,
  );
  expect(css).toMatch(
    /\.toolChip\s*\{[^}]*min-height: 28px;[^}]*padding: 3px 8px;/,
  );
  expect(css).not.toContain('min-width: 9ch;');
  expect(css).not.toContain('.canonicalTool[open]');
});
it('animates the wrapper instead of layout dimensions or SVG icons', () => {
  expect(css).toContain(
    'animation: tool-enter var(--motion-menu) var(--ease-out) both;',
  );
  const motion = css.slice(
    css.indexOf('@keyframes tool-enter'),
    css.indexOf('.toolChevron'),
  );
  expect(motion).toContain('opacity: 0;');
  expect(motion).toContain('transform: translateY(4px);');
  expect(motion).not.toMatch(/height:|width:|padding:|margin:/);
});
it('preserves 44px mobile targets and honors reduced motion', () => {
  expect(css).toMatch(
    /@media \(max-width: 700px\)[\s\S]*\.toolChip,\s*\.toolContent > summary\s*\{[^}]*min-height: 44px;/,
  );
  expect(css).toMatch(
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.canonicalTool,\s*\.toolStatus\[data-tool-status='running'\]\s*\{[^}]*animation: none;/,
  );
  expect(popup).toContain('duration: reducedMotion ? 0 : 160');
});
it('delays hover 200ms, permits safe crossing and uses a viewport-bounded root/dialog portal', () => {
  expect(popup).toContain('delay: { open: 200, close: 80 }');
  expect(popup).toContain('handleClose: safePolygon()');
  expect(popup).toContain("strategy: 'fixed'");
  expect(popup).toContain('flip({ padding: 12, boundary: [] })');
  expect(popup).toContain('shift({ padding: 12, boundary: [] })');
  expect(popup).toContain('maxHeight:');
  expect(popup).toContain('FloatingPortal root={portalRoot ?? undefined}');
  expect(popup).toContain('popup.showPopover()');
  expect(popup).toContain('modal={false}');
  expect(popupCss).toContain('inset: auto;');
  expect(popupCss).toContain('overflow: visible;');
  expect(popupCss).toContain('max-height: inherit;');
});
