import { Badge, Button, Flex, Link, Separator, Text } from '@radix-ui/themes';
import type { GateInfo, Job } from '../../../src/types.ts';
import type { GateApi } from '../api.ts';
import { HelpTip } from '../HelpTip.tsx';
import { roleLabel } from '../Gates.tsx';
import { JOB_COLORS, jobLabel } from '../JobDock.tsx';
import { useGateActions, type WorkingCopyState } from '../panes/WorkingCopyBar.tsx';
import { GateSwitcher } from './GateSwitcher.tsx';
import { NAV, pageShown, PINNED_NAV, type NavKey } from './pages.ts';
import { TAB_PAGES } from './PhoneNav.tsx';

interface SidebarItemsProps {
  gate: GateInfo;
  user: string;
  page: NavKey; // the open page
  phone: boolean; // the phone's More menu: leaves out what the tab bar and Gate sheet have
  elevators: boolean; // the gate's Elevators feature (shows the elevator pages)
  job: Job | null;
  progressShown: boolean; // the progress window is open or minimized
  gapi: GateApi;
  readOnly: boolean;
  workingCopy: WorkingCopyState;
  hasWorkingCopy: boolean;
  onGo: (page: NavKey) => void;
  onSwitchGate: (to: GateInfo) => void;
  onAllGates: () => void;
  onPull: (what: 'residents' | 'transactions') => void;
  onShowProgress: () => void;
  onReset: () => Promise<void>; // reloads after Reset to gate
  onJobStarted: () => void;
  onNotify: (text: string) => void; // the outcome of Send / Reset, shown on the page
  onSignOut: () => void;
}

interface NavButtonProps {
  label: string;
  current: boolean;
  onClick: () => void;
}

/**
 * One page in the menu; the open one is highlighted.
 *
 * @param props - Component props.
 * @param props.label - Display label.
 * @param props.current - Current password or state.
 * @param props.onClick - On click.
 * @returns Rendered React element.
 */
function NavButton({ label, current, onClick }: NavButtonProps) {
  return <Button className="nav-item" variant={current ? 'soft' : 'ghost'} color={current ? undefined : 'gray'} onClick={onClick}>{label}</Button>;
}

interface GateConnectionProps {
  job: Job | null;
  progressShown: boolean;
  gapi: GateApi;
  readOnly: boolean;
  workingCopy: WorkingCopyState;
  hasWorkingCopy: boolean;
  onPull: (what: 'residents' | 'transactions') => void;
  onShowProgress: () => void;
  onReset: () => Promise<void>;
  onJobStarted: () => void;
  onNotify: (text: string) => void;
}

/**
 * The desktop sidebar's gate connection: Send to gate and Reset to gate (admins), the pulls, the running or last
 * connection, and Show progress.
 *
 * @param props - Component props.
 * @param props.job - Job.
 * @param props.progressShown - Progress shown.
 * @param props.gapi - Gate-scoped API fetch helper.
 * @param props.readOnly - Read only.
 * @param props.workingCopy - Working copy.
 * @param props.hasWorkingCopy - Has working copy.
 * @param props.onPull - On pull.
 * @param props.onShowProgress - On show progress.
 * @param props.onReset - On reset.
 * @param props.onJobStarted - On job started.
 * @param props.onNotify - On notify.
 * @returns Rendered React element.
 */
function GateConnection({ job, progressShown, gapi, readOnly, workingCopy, hasWorkingCopy, onPull, onShowProgress, onReset, onJobStarted,
  onNotify }: GateConnectionProps) {
  const running = job?.state === 'running';
  const actions = useGateActions({ gapi, workingCopy, hasWorkingCopy, running, onReset, onJobStarted, onNotify });
  return (
    <>
      {actions.dialog}
      <Separator size="4" />
      <Text size="1" color="gray" weight="bold">Gate connection</Text>
      {!readOnly && (
        <>
          <Button className="nav-action" disabled={!actions.canSend} onClick={() => { onNotify(''); actions.send(); }} title={actions.sendHint}>
            Send to gate
          </Button>
          <Button variant="soft" color="gray" className="nav-action" disabled={!actions.canReset}
            onClick={() => { onNotify(''); actions.reset(); }}>Reset to gate</Button>
        </>
      )}
      <Button variant="soft" className="nav-action" disabled={running} onClick={() => onPull('residents')}>Pull residents</Button>
      <Button variant="soft" className="nav-action" disabled={running} onClick={() => onPull('transactions')}>Pull transactions</Button>
      <Flex direction="column" gap="1" align="stretch">
        {jobLabel(job) && <Badge size="2" color={JOB_COLORS[job!.state]} className="nav-action" style={{ justifyContent: 'center' }}>{jobLabel(job)}</Badge>}
        {!progressShown && job && job.log.length > 0 && (
          <Link href="#" size="1" style={{ textAlign: 'center' }} onClick={(event) => { event.preventDefault(); onShowProgress(); }}>Show progress</Link>
        )}
      </Flex>
    </>
  );
}

/**
 * The sidebar's contents (GateApp puts them in the desktop sidebar or the phone's More menu): the gate switcher, the
 * pages, the pinned pages and Help, the gate connection (desktop) and the user's settings and Sign out.
 *
 * @param props - Component props.
 * @param props.gate - Currently open gate summary (`GateInfo`).
 * @param props.user - Local account username (or actor name for audit logs).
 * @param props.page - Page.
 * @param props.phone - Gate system phone number (digits or formatted).
 * @param props.elevators - Elevators.
 * @param props.job - Job.
 * @param props.progressShown - Progress shown.
 * @param props.gapi - Gate-scoped API fetch helper.
 * @param props.readOnly - Read only.
 * @param props.workingCopy - Working copy.
 * @param props.hasWorkingCopy - Has working copy.
 * @param props.onGo - On go.
 * @param props.onSwitchGate - On switch gate.
 * @param props.onAllGates - On all gates.
 * @param props.onPull - On pull.
 * @param props.onShowProgress - On show progress.
 * @param props.onReset - On reset.
 * @param props.onJobStarted - On job started.
 * @param props.onNotify - On notify.
 * @param props.onSignOut - On sign out.
 * @returns Rendered React element.
 */
export function SidebarItems({ gate, user, page, phone, elevators, job, progressShown, gapi, readOnly, workingCopy, hasWorkingCopy, onGo,
  onSwitchGate, onAllGates, onPull, onShowProgress, onReset, onJobStarted, onNotify, onSignOut }: SidebarItemsProps) {
  const listed = (key: NavKey) => pageShown(key, elevators) && !(phone && TAB_PAGES.includes(key));
  return (
    <>
      <Flex direction="column" gap="1" p="3" className="sidebar-nav">
        <GateSwitcher gate={gate} onSwitch={onSwitchGate} onAllGates={onAllGates} />
        {!phone && (
          <Flex align="center" className="gate-status">
            <Text size="1" color={workingCopy.color}><span className="status-dot" />{workingCopy.label}</Text><HelpTip of="workingCopy" />
          </Flex>
        )}
        {NAV.map((item) => ('section' in item
          ? <Text key={item.section} size="1" color="gray" weight="bold" className="nav-section">{item.section}</Text>
          : listed(item.key) && <NavButton key={item.key} label={item.label} current={page === item.key} onClick={() => onGo(item.key)} />))}
      </Flex>
      <Flex direction="column" gap="1" p="3" className="sidebar-bottom">
        {PINNED_NAV.map((item) => <NavButton key={item.key} label={item.label} current={page === item.key} onClick={() => onGo(item.key)} />)}
        <Button asChild className="nav-item" variant="ghost" color="gray">
          <a href="/help" target="_blank" rel="noopener" title="Open the user guide in a new tab">Help ↗</a>
        </Button>
        {!phone && <GateConnection job={job} progressShown={progressShown} gapi={gapi} readOnly={readOnly} workingCopy={workingCopy}
          hasWorkingCopy={hasWorkingCopy} onPull={onPull} onShowProgress={onShowProgress} onReset={onReset} onJobStarted={onJobStarted}
          onNotify={onNotify} />}
        <Separator size="4" />
        <Text size="1" color="gray">{user} · {roleLabel(gate.role)}</Text>
        <Flex gap="2" wrap="wrap">
          <Button size="1" variant={page === 'user' ? 'solid' : 'soft'} color="gray" onClick={() => onGo('user')}>User settings</Button>
          <Button size="1" variant="soft" color="gray" onClick={onSignOut}>Sign out</Button>
        </Flex>
      </Flex>
    </>
  );
}
