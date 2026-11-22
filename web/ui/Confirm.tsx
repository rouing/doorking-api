import { useCallback, useRef, useState, type ReactNode } from 'react';
import { AlertDialog, Box, Button, Flex, Text } from '@radix-ui/themes';
import { useBackLayer } from './back.ts';

interface Ask { title: string; body?: ReactNode; action: string; color?: 'red' | 'blue'; maxWidth?: string }

/**
 * A confirmation dialog: `confirm({ title, body, action })` resolves true when the action button is clicked.
 * Render `dialog` once in the component.
 *
 * @returns `[ReactNode, (ask: Ask) => Promise<boolean>]` result.
 */
export function useConfirm(): [ReactNode, (ask: Ask) => Promise<boolean>] {
  const [ask, setAsk] = useState<Ask | null>(null);
  const resolve = useRef<(ok: boolean) => void>(() => {});
  const confirm = useCallback((ask: Ask) => new Promise<boolean>((res) => { resolve.current = res; setAsk(ask); }), []);
  const close = (ok: boolean) => { setAsk(null); resolve.current(ok); };
  useBackLayer(ask !== null, () => close(false));
  const dialog = (
    <AlertDialog.Root open={ask !== null} onOpenChange={(open) => { if (!open) close(false); }}>
      <AlertDialog.Content maxWidth={ask?.maxWidth || '520px'} aria-describedby={undefined}>
        <AlertDialog.Title>{ask?.title}</AlertDialog.Title>
        {ask?.body && <Box><Text as="div" size="2">{ask.body}</Text></Box>}
        <Flex gap="3" mt="4" justify="end">
          <AlertDialog.Cancel><Button variant="soft" color="gray">Cancel</Button></AlertDialog.Cancel>
          <AlertDialog.Action>
            <Button color={ask?.color || 'blue'} onClick={() => close(true)}>{ask?.action}</Button>
          </AlertDialog.Action>
        </Flex>
      </AlertDialog.Content>
    </AlertDialog.Root>
  );
  return [dialog, confirm];
}
