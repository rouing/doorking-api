import { useState } from 'react';
import { Button, Card, Flex, Heading, Link, Text } from '@radix-ui/themes';
import type { CameraSettings, GateConfig as Config, GatePrefs, ResidentsReply } from '../../../src/types.ts';
import { errorText, gateUrl, useReadOnly, type GateApi } from '../api.ts';
import { useConfirm } from '../Confirm.tsx';
import { HelpTip } from '../HelpTip.tsx';
import { CameraForm } from './CameraForm.tsx';
import { GateConfig } from './GateConfig.tsx';
import { GateSettingsEditor } from './GateSettingsEditor.tsx';
import { DeviceAssociation } from './LocalPrefs.tsx';
import { useGateSettings } from './useGateSettings.ts';
import { GateLoginCard, GateUsersCard, ApiKeysCard } from './GateAccess.tsx';

interface DeleteGateDataProps {
  phone: string;
  gapi: GateApi;
  onDeleted: () => void;
}

/**
 * Deletes everything this app stores about the gate (database rows for every user and the gate's folder), after a
 * warning. Nothing on the gate changes. Afterwards the gate is gone from every list, so the page returns to the list.
 *
 * @param props - Component props.
 * @param props.phone - Gate system phone number (digits or formatted).
 * @param props.gapi - Gate-scoped API fetch helper.
 * @param props.onDeleted - On deleted.
 * @returns Rendered React element.
 */
function DeleteGateData({ phone, gapi, onDeleted }: DeleteGateDataProps) {
  const [dialog, confirm] = useConfirm();
  const [info, setInfo] = useState('');
  const remove = async () => {
    if (!await confirm({ title: `Delete everything stored about gate ${phone}?`, action: 'Delete all gate data', color: 'red',
      body: 'This permanently deletes, for every account on this computer: the gate and everyone\'s access to it (with its DKS login and master code), '
        + 'gate configuration, relay names, Device association, notes, the transaction history, History, scheduled transfers, '
        + 'camera settings, the pulled files, the working copy with any unsent changes, and every camera picture and video. '
        + 'It can\'t be undone (only from a backup). Nothing on the gate itself changes.' })) return;
    setInfo('Deleting…');
    try {
      const reply = await gapi<{ filesError?: string }>('POST', '/delete-data', { confirm: true });
      if (reply.filesError) { setInfo(`Database data deleted, but some files could not be deleted: ${reply.filesError}`); return; }
      onDeleted();
    } catch (err) { setInfo(`Not deleted: ${errorText(err)}`); }
  };
  return (
    <Card>
      {dialog}
      <Flex direction="column" gap="3">
        <Heading size="3" color="red">Delete stored gate data<HelpTip of="deleteGateData" /></Heading>
        <Text size="2" color="gray">
          Removes everything this app has stored about this gate, for <strong>every account</strong> on this computer, and takes it off
          every gate list. Use it when the gate is no longer managed here. Nothing on the gate changes; to manage it again, add it and pull.
        </Text>
        <Flex gap="3" align="center" wrap="wrap"><Button color="red" onClick={remove}>Delete all data for this gate…</Button>
          <Text size="2" color="gray">{info}</Text></Flex>
      </Flex>
    </Card>
  );
}

interface WorkingCopyFilesProps {
  phone: string;
  available: boolean;
}

/**
 * Downloads of the working copy's board files (names.map flags the 128-byte blocks of names.bin that changed).
 *
 * @param props - Component props.
 * @param props.phone - Gate system phone number (digits or formatted).
 * @param props.available - Available.
 * @returns Rendered React element.
 */
function WorkingCopyFiles({ phone, available }: WorkingCopyFilesProps) {
  return (
    <Card>
      <Flex direction="column" gap="3">
        <Heading size="3">Working copy files</Heading>
        <Text size="2" color="gray">
          {available ? 'Download the working copy\'s files, with every change saved to it.' : 'No working copy yet. Pull residents from the gate.'}
        </Text>
        {available && (
          <Flex gap="3" wrap="wrap">
            {['names.bin', 'names.map', 'phone.bin', 'cards.bin'].map((file) => (
              <Link key={file} size="2" href={gateUrl(phone, `/files/${file}`)} download={file}>{file}</Link>
            ))}
          </Flex>
        )}
      </Flex>
    </Card>
  );
}

interface SystemSettingsProps {
  phone: string;
  gapi: GateApi;
  prefs: GatePrefs;
  defaults: Config;
  list: ResidentsReply | null;
  cameras: CameraSettings | null;
  user: string;
  emailEnabled: boolean;
  onReload: () => Promise<void>;
  onSessionChange: () => void;
  onJobStarted: () => void;
}

/**
 * System Settings: gate login and users (admins), gate configuration, gate settings (working copy), working copy
 * files, device association, cameras and deleting the gate's stored data. Relay names are on the
 * Relays page; dark mode is in User Settings. Read-only users see the gate's configuration and settings, disabled.
 *
 * @param props - Component props.
 * @param props.phone - Gate system phone number (digits or formatted).
 * @param props.gapi - Gate-scoped API fetch helper.
 * @param props.prefs - Gate-scoped preferences object.
 * @param props.defaults - Defaults.
 * @param props.list - List of input items.
 * @param props.cameras - Camera runner instance.
 * @param props.user - Local account username (or actor name for audit logs).
 * @param props.emailEnabled - Email enabled.
 * @param props.onReload - Callback to reload the gate data.
 * @param props.onSessionChange - On session change.
 * @param props.onJobStarted - On job started.
 * @returns Rendered React element.
 */
export function SystemSettings({ phone, gapi, prefs, defaults, list, cameras, user, emailEnabled, onReload, onSessionChange, onJobStarted }: SystemSettingsProps) {
  const settings = useGateSettings(gapi);
  const readOnly = useReadOnly();
  const reloadAll = async () => { await onReload(); await settings.load(); };
  const shared = (
    <>
      <GateConfig key={`${JSON.stringify(prefs.gateConfig)}-${list?.dirDigits}`} prefs={prefs} defaults={defaults} list={list} gapi={gapi}
        gate={{ memory: settings.field('systemMemory')?.gate, chips: settings.field('memoryChips')?.gate }}
        onSaved={async () => { onSessionChange(); await reloadAll(); }} />
      <Card>
        <Flex direction="column" gap="3">
          <Heading size="3">Gate settings</Heading>
          <GateSettingsEditor settings={settings} view="prefs" gapi={gapi} onReload={onReload} />
        </Flex>
      </Card>
    </>
  );
  if (readOnly) {
    return (
      <Flex direction="column" gap="4">
        <Heading>System Settings</Heading>
        <fieldset disabled className="readonly-page"><Flex direction="column" gap="4">
          {shared}
          <DeviceAssociation key={JSON.stringify(prefs.deviceAssociation)} prefs={prefs} gapi={gapi} onSaved={onReload} />
        </Flex></fieldset>
      </Flex>
    );
  }
  return (
    <Flex direction="column" gap="4">
      <Heading>System Settings</Heading>
      <GateLoginCard gapi={gapi} onJobStarted={onJobStarted} />
      <GateUsersCard gapi={gapi} me={user} emailEnabled={emailEnabled} onSessionChange={onSessionChange} />
      <ApiKeysCard phone={phone} gapi={gapi} />
      {shared}
      <WorkingCopyFiles phone={phone} available={Boolean(settings.reply)} />
      <DeviceAssociation key={JSON.stringify(prefs.deviceAssociation)} prefs={prefs} gapi={gapi} onSaved={onReload} />
      <CameraForm key={JSON.stringify(cameras)} settings={cameras} phone={phone} gapi={gapi} onSaved={onReload} />
      <DeleteGateData phone={phone} gapi={gapi} onDeleted={onSessionChange} />
    </Flex>
  );
}
