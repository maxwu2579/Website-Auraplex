'use client';

import { Link } from '@/lib/navigation';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/primitives/button';
import { Magnetic } from '@/components/motion/magnetic';
import { CursorSpotlight } from '@/components/motion/cursor-spotlight';
import { HeroTunnel } from '@/components/sections/hero-tunnel';
import { YoutubeHeroBgLazy } from '@/components/sections/youtube-hero-bg-lazy';
import { whatsappLink } from '@/lib/utils';

/** Auraplex company introduction film used as the hero background. */
const HERO_VIDEO_ID = 'djIrbyer4m4';

/**
 * Hero — the runway INTO the MachineHyperscroll signature.
 *
 * The background is a single bespoke element: HeroTunnel, a receding
 * perspective corridor of signal rings + motes on ink. It reads as "the
 * mouth of the machine tunnel", so when the visitor scrolls the hero
 * dissolves straight into the Hyperscroll flythrough — one continuous dive,
 * no video, no stacked particle systems, no hard cut.
 *
 * Type is deliberately loud (up to ~14vw) and the entrance is cinematic:
 * the headline is the LCP element and paints from server HTML via the
 * CSS-driven .hero-word class (no motion-bundle wait).
 *
 * Scroll-driven (0 → 100vh): headline scales down + lifts, tunnel and copy
 * fade, ink floods so the Hyperscroll's first frame emerges from the centre.
 *
 * MECHANISM: that whole choreography used to be seven framer `useTransform`s
 * hanging off one `useScroll`, which meant nothing moved until the motion
 * bundle had hydrated — on the LCP surface of the site. It is now native CSS
 * scroll-driven animation on a single named view timeline (`--hero-dive`,
 * declared by `.hero-stage` below), so it runs on the compositor and is live
 * from the first paint of the server HTML. All of it lives in
 * styles/motion/hero.css, which documents the range mapping, the inverted
 * fallback story and the reduced-motion override.
 */
export function HeroCinematic() {
  const t = useTranslations('home');

  const headline = t('heroH1');
  const words = headline.split(/(\s+)/);

  return (
    // .hero-stage names the view timeline every scroll-linked child rides. It
    // has to live here rather than on the children: this section is
    // `overflow-hidden`, which makes it a scroll container, so an anonymous
    // `view()` written on a descendant would bind to this non-scrolling box
    // instead of the document and never advance.
    <section className="hero-stage relative h-[100dvh] w-full overflow-hidden bg-[color:var(--color-ink)]">
      {/* ── Bespoke tunnel background (single element) ──
          Was style={{ opacity: tunnelOpacity, scale: tunnelScale }}. */}
      <div className="hero-tunnel-dive absolute inset-0">
        {/* Static gradient shows through on minimal tier / before mount */}
        <div
          className="absolute inset-0"
          style={{
            background:
              'radial-gradient(ellipse 60% 50% at 50% 52%, color-mix(in oklab, var(--color-signal) 10%, transparent), transparent 70%)',
          }}
        />
        <HeroTunnel />

        {/* Real Auraplex footage, layered OVER the generative tunnel so that
            when the embed plays it is the dominant visual. Lazy-loaded
            (ssr:false) so YouTube's ~100KB IFrame API never touches the LCP
            path, and self-hiding: if the embed is blocked (bot wall, region
            lock, embed disabled) it fades to 0 and the tunnel carries the hero.
            HERO_VIDEO_ID lives here so it is trivial to swap — keep the `title`
            describing whatever that ID actually is, it is the accessible name
            for the background video. */}
        <YoutubeHeroBgLazy id={HERO_VIDEO_ID} title="Auraplex company introduction" />
      </div>

      {/* Cursor spotlight halo */}
      <CursorSpotlight size={460} intensity={0.16} />

      {/* Ink flood — the Hyperscroll below emerges from this centre as we
          scroll. Was style={{ opacity: inkOverlayOpacity }}; the base style is
          opacity 0 so a browser without scroll-driven animations never floods
          the hero. */}
      <div className="hero-ink-flood pointer-events-none absolute inset-0">
        <div className="absolute inset-0 bg-[color:var(--color-ink)]" />
      </div>

      {/* Vignette stack — see styles/motion/hero.css.
          The video is real footage, so a bright frame used to wash out the
          header nav sitting over it. These make legibility a property of the
          layout instead of a property of whatever frame is playing. */}
      <div className="hero-vignette" aria-hidden="true" />
      <div className="hero-scrim-top" aria-hidden="true" />
      {/* Bottom fade — hands the hero off into the section below. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-b from-transparent to-[color:var(--color-ink)]" />

      {/* ── Content ──
          Was style={{ scale: h1Scale, y: h1Y, opacity: copyOpacity }}. This is
          the ancestor of the LCP element, so its opacity is an EXIT only: it is
          exactly 1 at scroll position 0 and holds 1 through the first 5% of the
          hero's scroll range. See RULE ZERO in styles/motion/hero.css. */}
      <div className="hero-copy relative z-10 mx-auto flex h-full max-w-[1600px] flex-col justify-center px-6 pt-24 lg:px-12">
        {/* Eyebrow — SIGNAL SWEEP. CSS-driven so it paints from server HTML.
            The old version animated `letterSpacing`, which is a LAYOUT property:
            it reflowed the eyebrow row on every frame and was a measured CLS
            source (0.005 per shift, three times during load). Tracking is now
            static and only the hairline scales — transform-only, no reflow. */}
        <div className="mb-8 flex items-center gap-3 font-mono text-xs uppercase tracking-[0.3em] text-[color:var(--color-signal)]">
          <span className="signal-sweep h-px w-16 bg-[color:var(--color-signal)]" />
          <span className="hero-rise">{t('heroEyebrow')}</span>
        </div>

        {/* H1 — loud, CSS-driven LCP flight */}
        <h1
          className="font-display tracking-[-0.03em] leading-[0.86] text-[clamp(3.25rem,10.2vw,11rem)] max-w-[15ch]"
          style={{ perspective: 900 }}
        >
          {words.map((word, i) => {
            if (/^\s+$/.test(word)) return <span key={i}>{word}</span>;
            return <HeroWord key={i} word={word} index={i} />;
          })}
        </h1>

        {/* Subtitle — THE LCP ELEMENT (larger than the H1 on mobile).
            CSS transform-only entrance so it paints from the server HTML
            instead of waiting for hydration. See .hero-rise. */}
        <p className="hero-rise hero-rise-2 mt-10 max-w-2xl prose-editorial text-[color:var(--color-steel-soft)] text-lg">
          {t('heroSub')}
        </p>

        {/* CTAs */}
        <div className="hero-rise hero-rise-3 mt-12 flex flex-wrap gap-4">
          <Magnetic strength={0.4} radius={100}>
            <Button asChild size="lg">
              <Link href="/products">{t('ctaPrimary')} →</Link>
            </Button>
          </Magnetic>
          <Magnetic>
            <Button asChild variant="ghost" size="lg">
              <a
                href={whatsappLink(t('heroWhatsappMsg'))}
                target="_blank"
                rel="noreferrer"
              >
                {t('ctaSecondary')} →
              </a>
            </Button>
          </Magnetic>
        </div>
      </div>

      {/* Corner HUD — rhymes with the MachineHyperscroll HUD so the hero reads
          as the entrance to the same system. Fades out as we dive in.
          Two opacity sources (a delayed entrance fade AND the scroll-linked
          copyOpacity) were stacked on one framer element; CSS can only run one
          opacity animation per element, so they are split across this wrapper
          pair — outer = scroll exit, inner = timed entrance. The two opacities
          multiply, which is how framer composed them. The inner box is
          `inset-0` of the outer, so it is the same rectangle and the absolutely
          positioned corner marks land exactly where they did. */}
      <div
        className="hero-hud pointer-events-none absolute inset-x-6 bottom-6 top-24 z-20 hidden font-mono text-[10px] uppercase tracking-[0.3em] text-[color:var(--color-steel)] lg:block"
        aria-hidden="true"
      >
        <div className="hero-hud-in absolute inset-0">
          <div className="absolute top-0 right-0 text-right leading-relaxed">
            <div className="text-[color:var(--color-signal)]">SYS / READY</div>
            <div>DEPTH 0000</div>
          </div>
          <div className="absolute bottom-0 right-0">MY · 03.1189 N · 101.6869 E</div>
          <span className="absolute top-2 right-2 h-3 w-3 border-t border-r border-[color:var(--color-paper)]/25" />
          <span className="absolute bottom-2 right-2 h-3 w-3 border-b border-r border-[color:var(--color-paper)]/25" />
        </div>
      </div>

      {/* Bottom signal line — was style={{ scaleX: signalLineScaleX,
          originX: 0 }}, which starts at 0.1, not 1. */}
      <div className="hero-signal-line absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-[color:var(--color-signal)] via-[color:var(--color-signal-bright)] to-[color:var(--color-signal)]/0" />

      {/* Scroll indicator — same outer/inner split as the HUD above. The
          `-translate-x-1/2` centring stays on the outer element (the animations
          here touch opacity only, so nothing competes for `transform`), and the
          flex column moves inward; the outer is still shrink-to-fit around the
          same content, so the centring is unchanged. */}
      <div className="hero-scroll-cue pointer-events-none absolute bottom-6 left-1/2 z-20 -translate-x-1/2 font-mono text-xs uppercase tracking-widest text-[color:var(--color-steel)]">
        <div className="hero-scroll-cue-in flex flex-col items-center gap-2">
          <span>{t('heroScrollLabel')}</span>
          <div className="scroll-spark h-8 w-px bg-gradient-to-b from-[color:var(--color-steel)] via-[color:var(--color-signal)]/60 to-transparent" />
        </div>
      </div>
    </section>
  );
}

function HeroWord({ word, index }: { word: string; index: number }) {
  // LCP element — CSS-driven (.hero-word) so it paints from server HTML.
  //
  // RULE ZERO: the keyframe animates TRANSFORM ONLY (no opacity), so every word
  // is an LCP candidate from the first frame. The stagger is also capped: the
  // English headline is 15 tokens, and at the old 0.06s/word the last word did
  // not settle until ~1.8s, which put a network-independent floor under LCP.
  // 0.028s/word capped at 0.28s keeps the sweep legible without gating paint.
  return (
    <span
      className="hero-word"
      style={{
        fontVariationSettings: '"wght" 700',
        transformStyle: 'preserve-3d',
        backfaceVisibility: 'hidden',
        animationDelay: `${Math.min(0.06 + index * 0.028, 0.28)}s`,
      }}
    >
      {word}
    </span>
  );
}
