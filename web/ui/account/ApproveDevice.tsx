// Approving another device to add a passkey: for when the account's passkey is on a device that can't confirm for
// another one (a laptop can't scan a QR code). This device confirms with its passkey (the step-up dialog) and gets a
// one-time code; the new device signs in and enters it under Passkeys, or scans the QR code, which opens the page
// there with the code filled in (App keeps it as APPROVAL_KEY).
import { useEffect, useRef, useState } from 'react';
import { Button, Code, Flex, Text } from '@radix-ui/themes';
import QRCode from 'qrcode';
import { api, errorText } from '../api.ts';

export const APPROVAL_KEY = 'dk-approve'; // sessionStorage: a code from a scanned QR code

interface Approval { code: string; expiresAt: string }

const shown = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;

interface ApprovalQrProps {
  code: string;
}

// The QR code of the page's address with the code (drawn on a canvas: the page's content policy allows no data: images).
function ApprovalQr({ code }: ApprovalQrProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (canvas.current) QRCode.toCanvas(canvas.current, `${window.location.origin}/#approve=${code}`, { width: 180, margin: 1 }).catch(() => {});
  }, [code]);
  return <canvas ref={canvas} aria-label="QR code with the approval code" style={{ borderRadius: 'var(--radius-2)', background: '#fff' }} />;
}

export function ApproveDevice() {
  const [approval, setApproval] = useState<Approval | null>(null);
  const [info, setInfo] = useState('');
  const create = async () => {
    setInfo('');
    try { setApproval(await api<Approval>('POST', '/api/me/passkeys/approval', {})); } catch (err) { setInfo(errorText(err)); }
  };
  return (
    <Flex direction="column" gap="2">
      <Text size="2" weight="bold">Add a passkey on another device</Text>
      <Text size="2" color="gray">
        If your new phone or computer has no passkey for this site yet, approve it from here: you get a code for it, valid for 10 minutes.
        (If your passkey is on a phone, you can also confirm on the new device by choosing a phone or tablet in its browser's prompt.)
      </Text>
      <Flex gap="3" align="center" wrap="wrap">
        <Button variant="soft" onClick={create}>{approval ? 'New code' : 'Approve another device'}</Button>
        {info && <Text size="2" color="red">{info}</Text>}
      </Flex>
      {approval && (
        <Flex gap="4" align="center" wrap="wrap">
          <ApprovalQr code={approval.code} />
          <Flex direction="column" gap="1">
            <Code size="6" variant="ghost" style={{ letterSpacing: '0.1em' }}>{shown(approval.code)}</Code>
            <Text size="2" color="gray">Valid until {new Date(approval.expiresAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}.</Text>
            <Text size="2" color="gray">On the new device, scan the QR code with its camera, or sign in there and enter the code under User Settings → Passkeys.</Text>
          </Flex>
        </Flex>
      )}
    </Flex>
  );
}
