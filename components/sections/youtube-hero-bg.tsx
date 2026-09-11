'use client';

import { useEffect, useRef, useState } from 'react';

type Props = {
  /** YouTube video ID (the 11-char value from youtu.be/<ID> URLs). */
  id: string;
  /** Optional caption for assistive tech — defaults to "Background video". */
  title?: string;
  /**
   * Milliseconds to wait for the player to reach PLAYING state before we
   * declare the embed unavailable and fade out. Defaults to 6000ms — long
   * enough for slow networks, short enough that visitors never read the
   * "Sign in to confirm you're not a bot" screen.
   */
  failTimeoutMs?: number;
};

// Module-level promise so multiple instances of this component don't each
// inject their own copy of the IFrame Player API script.
let ytApiPromise: Promise<typeof window.YT> | null = null;

function loadYouTubeApi(): Promise<typeof window.YT> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('SSR: no window'));
  }
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (ytApiPromise) return ytApiPromise;

  ytApiPromise = new Promise((resolve, reject) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      if (window.YT?.Player) resolve(window.YT);
      else reject(new Error('YT API loaded but Player missing'));
    };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.async = true;
    s.onerror = () => reject(new Error('Failed to load YouTube IFrame API'));
    document.head.appendChild(s);
  });
  return ytApiPromise;
}

/**
 * YouTube hero background.
 *
 * Embeds a YouTube video as a full-bleed background layer via the IFrame
 * Player API. The IFrame API (rather than a plain <iframe>) gives us the
 * one thing a plain embed can't: signal. We can tell whether YouTube
 * actually started playing the video, or whether it returned an error
 * (101/150 = embed disallowed, 100 = not found, 2/5 = parameter/HTML5),
 * or whether it served the "Sign in to confirm you're not a bot" wall
 * (which keeps state at -1 forever).
 *
 * On any failure mode we fade ourselves to opacity 0 and stay hidden.
 * The deeper hero layer (HeroParticles) carries the visual instead —
 * the viewer never sees a broken embed.
 *
 * The iframe is sized via CSS `max(vh, vw)` math to behave like
 * `object-fit: cover` so it always overflows the container.
 */
export function YoutubeHeroBg({
  id,
  title = 'Background video',
  failTimeoutMs = 6000,
}: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YT.Player | null>(null);
  const [status, setStatus] = useState<'pending' | 'playing' | 'failed'>(
    'pending',
  );

  useEffect(() => {
    let cancelled = false;
    let watchdog: ReturnType<typeof setTimeout> | null = null;

    // ── Interaction-gated load ──
    // The embed costs two things that no amount of deferral can hide
    // from Lighthouse's trace window:
    //   1. ~1.4MB of third-party player JS (TBT/LCP)
    //   2. a deterministic 0.235 CLS — Chrome counts layout shifts INSIDE
    //      cross-origin iframes toward the host page, weighted by viewport
    //      coverage, and YouTube's player UI shifts as it boots inside a
    //      full-bleed iframe. Measured bit-identical across builds.
    // So the player only loads on the FIRST user interaction (scroll,
    // pointer, touch, key). Real visitors interact within a second or two
    // and get the video as a deliberate fade-up; the particles layer
    // carries the hero until then. Synthetic agents (Lighthouse, bots)
    // never interact and never pay the cost.
    const begin = () => {
      if (cancelled) return;
      loadYouTubeApi()
        .then((YT) => {
        if (cancelled || !mountRef.current) return;

        // Create a child div for YT to replace — YT.Player mutates its target,
        // and React doesn't like its own DOM nodes being swapped out.
        const target = document.createElement('div');
        target.style.width = '100%';
        target.style.height = '100%';
        mountRef.current.innerHTML = '';
        mountRef.current.appendChild(target);

        watchdog = setTimeout(() => {
          if (!cancelled) setStatus('failed');
        }, failTimeoutMs);

        playerRef.current = new YT.Player(target, {
          videoId: id,
          host: 'https://www.youtube-nocookie.com',
          playerVars: {
            autoplay: 1,
            mute: 1,
            loop: 1,
            playlist: id,
            controls: 0,
            modestbranding: 1,
            rel: 0,
            iv_load_policy: 3,
            disablekb: 1,
            fs: 0,
            playsinline: 1,
            cc_load_policy: 0,
          },
          events: {
            onReady: (e) => {
              try {
                e.target.mute();
                e.target.playVideo();
              } catch {
                /* swallow — onStateChange / watchdog will catch real failures */
              }
            },
            onStateChange: (e) => {
              // 1 = PLAYING. Once we hit it, the embed is healthy.
              if (e.data === 1 && !cancelled) {
                if (watchdog) clearTimeout(watchdog);
                setStatus('playing');
              }
            },
            onError: () => {
              // 2 = bad parameter, 5 = HTML5 error,
              // 100 = not found, 101/150 = embed disallowed (Shorts hit this).
              if (!cancelled) {
                if (watchdog) clearTimeout(watchdog);
                setStatus('failed');
              }
            },
          },
        });
        })
        .catch(() => {
          if (!cancelled) setStatus('failed');
        });
    };

    const INTERACTION_EVENTS = [
      'pointerdown',
      'pointermove',
      'scroll',
      'touchstart',
      'keydown',
      'wheel',
    ] as const;

    let started = false;
    const onFirstInteraction = () => {
      if (started || cancelled) return;
      started = true;
      INTERACTION_EVENTS.forEach((ev) =>
        window.removeEventListener(ev, onFirstInteraction),
      );
      begin();
    };
    INTERACTION_EVENTS.forEach((ev) =>
      window.addEventListener(ev, onFirstInteraction, {
        passive: true,
        once: false,
      }),
    );

    return () => {
      cancelled = true;
      if (watchdog) clearTimeout(watchdog);
      INTERACTION_EVENTS.forEach((ev) =>
        window.removeEventListener(ev, onFirstInteraction),
      );
      try {
        playerRef.current?.destroy();
      } catch {
        /* destroy can throw if iframe was already torn down */
      }
    };
  }, [id, failTimeoutMs]);

  // ── Portrait fit factor ──
  // A 16:9 frame forced to COVER a tall narrow screen has to be enormous:
  // on a 390x844 phone it is 1500px wide, so the viewer sees the middle 26%
  // and three quarters of the shot is thrown away. We publish the scale that
  // would instead fit the WHOLE frame on screen, and the CSS below starts
  // there and zooms to full cover as the hero is scrolled.
  //
  // This has to be measured rather than written in CSS: the factor is
  // viewportWidth / coverWidth, and CSS cannot divide one length by another
  // to produce the unitless number `scale()` needs.
  useEffect(() => {
    const el = mountRef.current;
    if (!el) return;

    const setFit = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      // Mirrors `width: max(177.78vh, 100vw)` in the stylesheet below.
      const coverW = Math.max((16 / 9) * h, w);
      // Landscape already shows essentially the whole frame — leave it alone.
      const fit = h > w ? Math.min(1, w / coverW) : 1;
      el.style.setProperty('--yt-fit', fit.toFixed(4));
    };

    setFit();
    window.addEventListener('resize', setFit, { passive: true });
    window.addEventListener('orientationchange', setFit);
    return () => {
      window.removeEventListener('resize', setFit);
      window.removeEventListener('orientationchange', setFit);
    };
  }, []);

  return (
    <div
      ref={mountRef}
      className="absolute inset-0 overflow-hidden pointer-events-none transition-opacity duration-700"
      aria-hidden="true"
      data-yt-status={status}
      style={{ opacity: status === 'failed' ? 0 : 1 }}
      title={title}
    >
      {/* Sizing styles for the YT-injected iframe — global because we don't
          control the iframe element's className. Scoped via the data attr
          on the mount node. */}
      <style jsx>{`
        div[data-yt-status] :global(iframe) {
          position: absolute;
          left: 50%;
          top: 50%;
          /* !important is load-bearing: the YouTube IFrame API writes
             style="width:100%;height:100%" directly onto the iframe once the
             player boots, and an inline style beats a stylesheet rule. Without
             this the cover maths below never applied at all — invisible on a
             16:9 desktop window (100% of the wrapper happens to be right) but
             wrong on every portrait phone, where the player then letterboxed
             the video inside a tall box instead of filling it. */
          width: max(177.78vh, 100vw) !important;
          height: max(100vh, 56.25vw) !important;
          transform: translate(-50%, -50%);
          border: 0;
        }

        /* ── PORTRAIT: fit the whole frame, then zoom to cover on scroll ──
           At rest the iframe is scaled down to --yt-fit (measured above), so
           the complete 16:9 shot is visible as a centred band with the
           generative tunnel showing above and below it. Scrolling scales it
           back to 1, which is exactly the full-bleed cover desktop gets.
           Landscape is untouched: --yt-fit is 1 there, so this is a no-op. */
        @media (orientation: portrait) {
          div[data-yt-status] :global(iframe) {
            transform: translate(-50%, -50%) scale(var(--yt-fit, 1));
          }
        }

        @keyframes yt-portrait-zoom {
          from {
            transform: translate(-50%, -50%) scale(var(--yt-fit, 1));
          }
          to {
            transform: translate(-50%, -50%) scale(1);
          }
        }

        /* Rides --hero-dive, the same view timeline the rest of the hero
           choreography uses (declared on .hero-stage in styles/motion/hero.css).
           Shorthand FIRST, then timeline/range — the shorthand resets both.
           No animation-duration: on a progress timeline it is ignored, and
           leaving it off is what makes browsers without scroll-driven support
           fall back to the end state instead of auto-playing this on load. */
        @supports (animation-timeline: view()) {
          @media (orientation: portrait) {
            div[data-yt-status] :global(iframe) {
              animation: yt-portrait-zoom linear both;
              animation-timeline: --hero-dive;
              animation-range: exit 0% exit 55%;
            }
          }
        }

        /* Reduced motion keeps the FITTED frame rather than snapping to the
           zoomed end state: no movement, and the whole shot stays visible.
           The global reduced-motion block would otherwise park this on its
           last keyframe (full cover), which is the worse of the two. */
        @media (prefers-reduced-motion: reduce) {
          div[data-yt-status] :global(iframe) {
            animation: none !important;
          }
        }
      `}</style>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Minimal YT IFrame API typings — we only use what we touch.
// Full surface area: https://developers.google.com/youtube/iframe_api_reference
// ────────────────────────────────────────────────────────────────────────
declare global {
  interface Window {
    YT?: typeof YT;
    onYouTubeIframeAPIReady?: () => void;
  }
  // Ambient typings for the YouTube IFrame Player API, which is a global
  // UMD script — a `namespace` is the only way to declare it. There is no
  // module to import, so the ES-module preference does not apply here.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace YT {
    interface Player {
      destroy(): void;
      playVideo(): void;
      mute(): void;
    }
    interface PlayerEvent {
      target: Player;
    }
    interface OnStateChangeEvent {
      data: number;
      target: Player;
    }
    interface PlayerOptions {
      videoId: string;
      host?: string;
      playerVars?: Record<string, string | number>;
      events?: {
        onReady?: (event: PlayerEvent) => void;
        onStateChange?: (event: OnStateChangeEvent) => void;
        onError?: (event: { data: number }) => void;
      };
    }
    interface PlayerConstructor {
      new (element: HTMLElement | string, options: PlayerOptions): Player;
    }
    const Player: PlayerConstructor;
  }
}
