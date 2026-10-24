// Fixture: copied unchanged below this line from getitdone-gmbh/kette-tokens@eed33bc scripts/color-pairs.js (5.22.1). Source of the pairs in src/theme/manifest.json.
// Fill and text pairs that must always travel together (5.21.1). A theme CSS block that sets one side of a pair without the other lets a second stylesheet (generic theme, other mode selector) supply the missing half: blue fill with near-black text.
// A fifth entry 'shared' marks a fill that reuses the text of another pair (hover/active states): the text may be set without it, the fill never without the text.
// Used by build-css-vars.ts (pins every pair variable in every mode block) and scripts/check-pairs.js (gate).
const PAIRS = [
    ['button default', '--colors-button-background-default', '--colors-button-foreground-default'],
    ['button hover', '--colors-button-background-hover', '--colors-button-foreground-hover'],
    ['button primary', '--colors-button-background-primary-default', '--colors-button-foreground-primary-default'],
    ['button primary hover', '--colors-button-background-primary-hover', '--colors-button-foreground-primary-default', 'shared'],
    ['button destructive', '--colors-button-background-destructive', '--colors-button-foreground-destructive'],
    ['button destructive hover', '--colors-button-background-destructive-hover', '--colors-button-foreground-destructive', 'shared'],
    ['brand fill', '--colors-general-brand-default', '--colors-general-brand-on-fill'],
    ['brand active', '--colors-general-brand-active', '--colors-general-brand-on-fill', 'shared'],
    ['brand hover', '--colors-general-brand-hover', '--colors-general-brand-on-hover'],
    ['brand on', '--colors-general-brand-default', '--colors-general-brand-on', 'shared'],
    ['brand container', '--colors-general-brand-container', '--colors-general-brand-on-container'],
    ['brand bold', '--semantic-background-brand-bold-default', '--semantic-text-on-brand'],
    ['brand bold hover', '--semantic-background-brand-bold-hover', '--semantic-text-on-brand', 'shared'],
    ['brand bold active', '--semantic-background-brand-bold-active', '--semantic-text-on-brand', 'shared'],
    ['brand bold icon', '--semantic-background-brand-bold-default', '--semantic-icon-on-brand', 'shared'],
    ['utility primary', '--colors-primary', '--colors-utility-primary-foreground'],
    ['utility destructive', '--colors-utility-destructive', '--colors-utility-destructive-foreground'],
    // 5.22.1: the remaining background/foreground utility pairs (shadcn names and the older colors/background-* aliases). Not a pair on purpose: --colors-background with --colors-utility-foreground, because the client theme escapr pins --colors-background to slate.900 in light mode (a brand decision, reported open in the 5.22.1 changelog)
    ['background destructive', '--colors-background-destructive', '--colors-foreground-destructive'],
    ['background accent', '--colors-background-accent', '--colors-foreground-accent'],
    ['utility accent', '--colors-utility-accent', '--colors-utility-accent-foreground'],
    ['utility secondary', '--colors-utility-secondary', '--colors-utility-secondary-foreground'],
    ['utility card', '--colors-utility-card', '--colors-utility-card-foreground'],
    ['utility popover', '--colors-utility-popover', '--colors-utility-popover-foreground'],
    ['utility muted', '--colors-utility-muted', '--colors-utility-muted-foreground'],
    ['sidebar', '--colors-sidebar-background', '--colors-sidebar-foreground'],
    ['sidebar muted', '--colors-sidebar-background', '--colors-sidebar-muted-foreground', 'shared'],
    ['sidebar accent', '--colors-sidebar-accent', '--colors-sidebar-accent-foreground'],
];
const PAIR_VARS = new Set(PAIRS.flatMap(([, fill, text]) => [fill, text]));
module.exports = { PAIRS, PAIR_VARS };
