// The phone layout's navigation (GateApp): the top bar, the bottom tab bar, the Gate tab's sheet and the More drawer.
import type { ReactNode } from 'react';
import { Button, Dialog, Flex, Text, VisuallyHidden } from '@radix-ui/themes';
import { ActivityLogIcon, BackpackIcon, DotsHorizontalIcon, PersonIcon } from '@radix-ui/react-icons';
import type { Job } from '../../../src/types.ts';
import type { GateApi } from '../api.ts';
import { JOB_COLORS, jobLabel } from '../JobDock.tsx';
import { useGateActions, type WorkingCopyState } from '../panes/WorkingCopyBar.tsx';

// The pages the tab bar opens (Relays through the Gate sheet's Live relays).
export type TabPage = 'residents' | 'vendors' | 'transactions' | 'relays';
export const TAB_PAGES: readonly string[] = ['residents', 'vendors', 'transactions', 'relays'] satisfies TabPage[];
// The pages with a tab of their own; More is highlighted for every other page (Relays included).
const OWN_TAB: readonly string[] = ['residents', 'vendors', 'transactions'] satisfies TabPage[];

interface PhoneTopBarProps {
  gateName: string;
  workingCopy: WorkingCopyState;
  job: Job | null;
  hasCamera: boolean; // leaves room for the camera button
  onOpenGate: () => void;
  onShowProgress: () => void;
}

// The gate's name with the working copy's state under it (opens the Gate sheet), and the running connection.
export function PhoneTopBar({ gateName, workingCopy, job, hasCamera, onOpenGate, onShowProgress }: PhoneTopBarProps) {
  return (
    <header className={hasCamera ? 'mobile-bar has-camera' : 'mobile-bar'}>
      <button type="button" className="title-button" onClick={onOpenGate}
        aria-label={`${gateName}, working copy: ${workingCopy.label}. Open the gate connection`}>
        <Text as="div" size="3" weight="bold" truncate>{gateName}</Text>
        <Text as="div" size="1" color={workingCopy.color} truncate><span className="status-dot" />{workingCopy.label}</Text>
      </button>
      {jobLabel(job) && <Button size="2" variant="soft" color={JOB_COLORS[job!.state]} onClick={onShowProgress}
        style={{ flexShrink: 0 }} aria-label={`Gate connection ${jobLabel(job)}: show progress`}>{jobLabel(job)}</Button>}
    </header>
  );
}

// A gate, drawn like the app icon (web/ui/public/icon.svg), for the Gate tab.
function GateIcon() {
  return (
    <svg viewBox="96 126 320 300" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="32" strokeLinecap="round"
      strokeLinejoin="round">
      <path d="M120 400V150M392 400V150M120 210q136-70 272 0M120 400h272M166 230v170M256 208v192M346 230v170" />
    </svg>
  );
}

interface TabButtonProps {
  label: string;
  icon: ReactNode;
  current: boolean;
  status?: string; // shown as a dot and added to the spoken label
  className?: string;
  onClick: () => void;
}

// One tab of the bottom bar.
function TabButton({ label, icon, current, status, className = '', onClick }: TabButtonProps) {
  return (
    <button type="button" className={`tab ${className}`} aria-current={current ? 'page' : undefined} aria-label={status && `${label} (${status})`}
      onClick={onClick}>
      <span className="tab-icon">{icon}{status && <span className="tab-dot" />}</span>
      <span className="tab-label">{label}</span>
    </button>
  );
}

interface PhoneTabBarProps {
  page: string; // the open page
  menuOpen: boolean;
  gateOpen: boolean;
  running: boolean;
  onGo: (page: TabPage) => void;
  onOpenGate: () => void;
  onOpenMore: () => void;
}

// Residents, Vendors, Transactions, Gate (the sheet) and More (the drawer, current for every other page).
export function PhoneTabBar({ page, menuOpen, gateOpen, running, onGo, onOpenGate, onOpenMore }: PhoneTabBarProps) {
  return (
    <nav className="tab-bar" aria-label="Main">
      <TabButton label="Residents" icon={<PersonIcon />} current={page === 'residents'} onClick={() => onGo('residents')} />
      <TabButton label="Vendors" icon={<BackpackIcon />} current={page === 'vendors'} onClick={() => onGo('vendors')} />
      <TabButton label="Transactions" className="wide" icon={<ActivityLogIcon />} current={page === 'transactions'} onClick={() => onGo('transactions')} />
      <TabButton label="Gate" icon={<GateIcon />} current={gateOpen} status={running ? 'connection running' : undefined} onClick={onOpenGate} />
      <TabButton label="More" icon={<DotsHorizontalIcon />} current={menuOpen || !OWN_TAB.includes(page)} onClick={onOpenMore} />
    </nav>
  );
}

interface GateSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  gapi: GateApi;
  job: Job | null;
  readOnly: boolean;
  workingCopy: WorkingCopyState;
  hasWorkingCopy: boolean;
  onPull: (what: 'residents' | 'transactions') => void;
  onShowProgress: () => void;
  onLiveRelays: () => void;
  onReset: () => Promise<void>; // reloads after Reset to gate
  onJobStarted: () => void;
  onNotify: (text: string) => void; // the outcome of Send / Reset, shown on the page
}

// The Gate tab: the working copy's state, Send to gate and Reset to gate (admins), the pulls, progress and live relays.
// Its buttons close the sheet first, so their confirmations show on their own.
export function GateSheet({ open, onOpenChange, gapi, job, readOnly, workingCopy, hasWorkingCopy, onPull, onShowProgress, onLiveRelays, onReset,
  onJobStarted, onNotify }: GateSheetProps) {
  const running = job?.state === 'running';
  const actions = useGateActions({ gapi, workingCopy, hasWorkingCopy, running, onReset, onJobStarted, onNotify });
  const closeThen = (action: () => void) => () => { onOpenChange(false); onNotify(''); action(); };
  return (
    <>
      {actions.dialog}
      <Dialog.Root open={open} onOpenChange={onOpenChange}>
        <Dialog.Content className="sheet" aria-describedby={undefined}>
          <Flex direction="column" gap="3">
            <Dialog.Title size="4" mb="0">Gate connection</Dialog.Title>
            <Text size="2" color="gray">
              {running ? `${jobLabel(job)}. You can keep working; the data reloads when it finishes.` : 'Get the latest data from the gate.'}
            </Text>
            <Text as="div" size="2" color={workingCopy.color}><span className="status-dot" />Working copy: {workingCopy.label}</Text>
            {!readOnly && (
              <>
                <Button size="3" disabled={!actions.canSend} onClick={closeThen(actions.send)}>
                  Send to gate
                </Button>
                {workingCopy.conflicts.length > 0 && <Text size="2" color="red">Decide the conflicts on the Residents page first.</Text>}
                <Button size="3" variant="soft" color="gray" disabled={!actions.canReset} onClick={closeThen(actions.reset)}>Reset to gate</Button>
              </>
            )}
            <Button size="3" variant="soft" disabled={running} onClick={() => onPull('residents')}>Pull residents</Button>
            <Button size="3" variant="soft" disabled={running} onClick={() => onPull('transactions')}>Pull transactions</Button>
            {job && job.log.length > 0 && <Button size="3" variant="soft" color="gray" onClick={closeThen(onShowProgress)}>Show progress</Button>}
            <Button size="3" variant="soft" color="gray" onClick={onLiveRelays}>Live relays</Button>
            <Dialog.Close><Button size="3" variant="ghost" color="gray">Close</Button></Dialog.Close>
          </Flex>
        </Dialog.Content>
      </Dialog.Root>
    </>
  );
}

interface PhoneMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}

// The More drawer: the sidebar's items in a dialog at the left edge.
export function PhoneMenu({ open, onOpenChange, children }: PhoneMenuProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content className="drawer" aria-describedby={undefined}>
        <VisuallyHidden><Dialog.Title>Menu</Dialog.Title></VisuallyHidden>
        <nav className="sidebar">{children}</nav>
      </Dialog.Content>
    </Dialog.Root>
  );
}
