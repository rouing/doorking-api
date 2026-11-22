import { Button, Callout, Flex } from '@radix-ui/themes';
import { useRegisterSW } from 'virtual:pwa-register/react';

const CHECK_MS = 60000;

// Registers the service worker (vite.config.mts) and shows a notice when the server has a newer build of the page
// than the one open (after `npm run build`). Checks every minute and when the tab gets focus. None under
// `npm run dev`, which has no service worker.
export function UpdateNotice() {
  const { needRefresh: [newer], updateServiceWorker } = useRegisterSW({
    onRegisteredSW(_url, registration) {
      if (!registration) return;
      const check = () => { if (navigator.onLine) registration.update().catch(() => { /* server not reachable: try again later */ }); };
      setInterval(check, CHECK_MS);
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
    },
  });
  if (!newer) return null;
  return (
    <Callout.Root color="blue" className="update-notice">
      <Flex align="center" gap="3" wrap="wrap">
        <Callout.Text>A new version of this page is available. Unsaved edits on the page are lost when it reloads.</Callout.Text>
        <Button size="1" onClick={() => updateServiceWorker(true)}>Reload</Button>
      </Flex>
    </Callout.Root>
  );
}
