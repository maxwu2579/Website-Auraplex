import createMiddleware from 'next-intl/middleware';
import { routing } from './lib/navigation';

export default createMiddleware(routing);

export const config = {
  // Exclude `studio` (Sanity Studio lives at /studio, outside the [locale]
  // tree) so next-intl doesn't redirect it to /en/studio → 404. The admin
  // application is also intentionally locale-free and owns its own layout.
  matcher: ['/((?!api|_next|_vercel|studio|admin|.*\\..*).*)'],
};
