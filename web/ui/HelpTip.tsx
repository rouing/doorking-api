import { useState, type MouseEvent } from 'react';
import { Popover, Tooltip } from '@radix-ui/themes';
import { QuestionMarkCircledIcon } from '@radix-ui/react-icons';
import { HELP } from './help.ts';

// Touch screens have no hover: there a tap opens the text and a tap elsewhere closes it.
const TOUCH = window.matchMedia('(hover: none)').matches;

interface HelpTipProps {
  of?: string;
  text?: string;
}

// A small "?" that shows more detail when hovered or focused with the keyboard (tapped on touch screens). of: a key in
// HELP; text: own text. Clicking it does nothing else, so it can sit inside a label or a clickable row.
export function HelpTip({ of, text }: HelpTipProps) {
  const [open, setOpen] = useState(false);
  const content = text ?? (of ? HELP[of] : undefined);
  if (!content) return null;
  const body = <span style={{ display: 'block', maxWidth: 340, whiteSpace: 'normal' }}>{content}</span>;
  // Touch screens: a button that opens the text (Popover adds aria-expanded); elsewhere the text shows on hover or focus.
  const icon = (onClick: (event: MouseEvent) => void) => (
    <span className="help-tip" tabIndex={0} role={TOUCH ? 'button' : 'img'} aria-label={TOUCH ? `Help: ${content}` : content} onClick={onClick}
      onKeyDown={TOUCH ? (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setOpen(!open); } } : undefined}>
      <QuestionMarkCircledIcon />
    </span>
  );
  const stop = (event: MouseEvent) => { event.preventDefault(); event.stopPropagation(); };
  if (!TOUCH) return <Tooltip content={body}>{icon(stop)}</Tooltip>;
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger>{icon((event) => { stop(event); setOpen(!open); })}</Popover.Trigger>
      <Popover.Content size="1" maxWidth="min(340px, 90vw)" onClick={(event) => event.stopPropagation()}>{body}</Popover.Content>
    </Popover.Root>
  );
}
