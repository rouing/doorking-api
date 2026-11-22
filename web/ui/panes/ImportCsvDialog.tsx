/**
 * @module web/ui/panes/ImportCsvDialog
 *
 * CSV import dialog for Residents/Vendors with server-side dry-run preview (`POST /residents/import`).
 */
import { useState, type ChangeEvent } from 'react';
import { Badge, Box, Button, Callout, Dialog, Flex, IconButton, Table, Text, TextArea } from '@radix-ui/themes';
import type { SendChange } from '../../../src/types.ts';
import { errorText, type GateApi } from '../api.ts';
import { useBackLayer } from '../back.ts';

interface ImportRow {
  directoryCode: string;
  name: string;
  vendor?: boolean;
  areaCode?: string;
  phone?: string;
  entryCode?: string;
  securityLevel?: number;
  cards?: string[];
  note?: string;
}

interface PreviewReply {
  added: number;
  updated: number;
  errors: { row: number; directoryCode: string; error: string }[];
  changes: SendChange[];
}

/** Splits one CSV line honoring quoted fields and escaped `""`. */
function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { cells.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

/**
 * Parses CSV text (either simple `directoryCode,name,phone,entryCode,securityLevel,cards,note` or DoorKing export
 * headers `Dir,Resident,AAC,PHONE,ENT,SL,Device,Vendor,RESIDENTNOTES`) into import row objects.
 *
 * @param text - Raw CSV text.
 * @param defaultVendor - Whether rows without an explicit Vendor column are imported as vendors.
 * @returns Parsed `ImportRow[]`.
 */
export function parseImportCsv(text: string, defaultVendor: boolean): ImportRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const headers = splitCsvLine(lines[0]).map((h) => h.toLowerCase().replace(/[^a-z0-9]/g, ''));
  const col = (...names: string[]) => headers.findIndex((h) => names.includes(h));
  const iCode = col('directorycode', 'dir', 'code');
  const iName = col('name', 'resident');
  const iAac = col('areacode', 'aac');
  const iPhone = col('phone', 'phonenumber');
  const iEntry = col('entrycode', 'ent');
  const iSec = col('securitylevel', 'security', 'sl');
  const iVendor = col('vendor');
  const iNote = col('note', 'notes', 'residentnotes');
  const iCards = headers.map((h, idx) => (/^(cards?|device\d*)$/.test(h) ? idx : -1)).filter((idx) => idx >= 0);

  const out: ImportRow[] = [];
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line);
    const directoryCode = iCode >= 0 ? cells[iCode] || '' : '';
    const name = iName >= 0 ? cells[iName] || '' : '';
    if (!directoryCode && !name) continue;
    const rawPhone = (iPhone >= 0 ? cells[iPhone] || '' : '').replace(/\D/g, '');
    const rawAac = (iAac >= 0 ? cells[iAac] || '' : '').replace(/\D/g, '');
    let areaCode = rawAac;
    let phone = rawPhone;
    if (!areaCode && rawPhone.length === 10) { areaCode = rawPhone.slice(0, 3); phone = rawPhone.slice(3); }
    else if (!areaCode && rawPhone.length === 11 && rawPhone.startsWith('1')) { areaCode = rawPhone.slice(0, 4); phone = rawPhone.slice(4); }
    const cards = iCards.flatMap((idx) => (cells[idx] || '').split(/[\s;]+/).map((c) => c.trim()).filter(Boolean));
    const secText = iSec >= 0 ? cells[iSec] || '' : '';
    const vendorText = iVendor >= 0 ? (cells[iVendor] || '').toLowerCase() : '';
    out.push({
      directoryCode,
      name,
      vendor: iVendor >= 0 ? (vendorText === 'y' || vendorText === 'yes' || vendorText === 'true') : defaultVendor,
      ...(areaCode && { areaCode }),
      ...(phone && { phone }),
      ...(iEntry >= 0 && cells[iEntry] && { entryCode: cells[iEntry] }),
      ...(secText !== '' && !Number.isNaN(Number(secText)) && { securityLevel: Number(secText) }),
      ...(cards.length > 0 && { cards }),
      ...(iNote >= 0 && cells[iNote] && { note: cells[iNote] }),
    });
  }
  return out;
}

interface ImportCsvDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  vendor: boolean;
  gapi: GateApi;
  onImported: () => Promise<void>;
}

/**
 * Dialog for uploading or pasting CSV resident/vendor rows, previewing the exact working-copy diff, and applying.
 *
 * @param props - Component props.
 * @param props.open - Whether the dialog is open.
 * @param props.onOpenChange - Callback toggling open state.
 * @param props.vendor - Default vendor flag when CSV has no Vendor column.
 * @param props.gapi - Gate-scoped API fetch helper.
 * @param props.onImported - Callback reloading residents after a successful import.
 * @returns Rendered React element.
 */
export function ImportCsvDialog({ open, onOpenChange, vendor, gapi, onImported }: ImportCsvDialogProps) {
  const [csvText, setCsvText] = useState('');
  const [preview, setPreview] = useState<PreviewReply | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useBackLayer(open, () => onOpenChange(false));

  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setCsvText(await file.text());
    setPreview(null);
    setError('');
  };

  async function runImport(dryRun: boolean) {
    const rows = parseImportCsv(csvText, vendor);
    if (!rows.length) { setError('Paste or upload a CSV with a header row and at least one entry.'); return; }
    setBusy(true);
    setError('');
    try {
      const reply = await gapi<PreviewReply>('POST', '/residents/import', { rows, dryRun });
      if (dryRun) {
        setPreview(reply);
      } else {
        setPreview(null);
        setCsvText('');
        onOpenChange(false);
        await onImported();
      }
    } catch (err) { setError(errorText(err)); }
    setBusy(false);
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content maxWidth="720px" aria-describedby={undefined}>
        <Flex align="center" mb="2">
          <Dialog.Title mb="0">Import CSV to working copy</Dialog.Title>
          <Flex flexGrow="1" />
          <Dialog.Close><IconButton variant="ghost" color="gray" title="Close">✕</IconButton></Dialog.Close>
        </Flex>
        <Flex direction="column" gap="3">
          <Text size="2" color="gray">
            Accepts simple headers (<code>directoryCode,name,phone,entryCode,securityLevel,cards,note</code>) or
            DoorKing's <code>ResidentsExport.csv</code>. Preview shows the exact working-copy diff before saving.
          </Text>
          <input type="file" accept=".csv,text/csv" onChange={onFile} />
          <TextArea rows={6} placeholder="directoryCode,name,phone,entryCode,cards&#10;101,Smith J,2145550101,4821,10234"
            value={csvText} onChange={(e) => { setCsvText(e.target.value); setPreview(null); }} />
          {error && <Callout.Root color="red"><Callout.Text>{error}</Callout.Text></Callout.Root>}
          <Flex gap="2">
            <Button variant="soft" disabled={busy || !csvText.trim()} onClick={() => runImport(true)}>Preview diff</Button>
            {preview && preview.errors.length === 0 && (
              <Button disabled={busy} onClick={() => runImport(false)}>
                Apply import ({preview.added} added, {preview.updated} updated)
              </Button>
            )}
          </Flex>
          {preview && (
            <Flex direction="column" gap="2">
              <Text size="2">
                Preview: <strong>{preview.added}</strong> added, <strong>{preview.updated}</strong> updated
                {preview.errors.length > 0 ? `, ${preview.errors.length} error(s)` : ''}.
              </Text>
              {preview.errors.length > 0 && (
                <Callout.Root color="red">
                  <Flex direction="column" gap="1">
                    {preview.errors.slice(0, 10).map((e) => (
                      <Text key={`${e.row}-${e.directoryCode}`} size="1">Row {e.row} ({e.directoryCode || 'no code'}): {e.error}</Text>
                    ))}
                  </Flex>
                </Callout.Root>
              )}
              {preview.changes.length > 0 && (
                <Box style={{ maxHeight: 240, overflowY: 'auto', border: '1px solid var(--gray-a5)', borderRadius: 'var(--radius-2)' }}>
                  <Table.Root size="1">
                    <Table.Header>
                      <Table.Row>
                        <Table.ColumnHeaderCell>Item</Table.ColumnHeaderCell>
                        <Table.ColumnHeaderCell>Field</Table.ColumnHeaderCell>
                        <Table.ColumnHeaderCell>Before</Table.ColumnHeaderCell>
                        <Table.ColumnHeaderCell>After</Table.ColumnHeaderCell>
                      </Table.Row>
                    </Table.Header>
                    <Table.Body>
                      {preview.changes.slice(0, 40).flatMap((item) => item.fields.map((field, idx) => (
                        <Table.Row key={`${item.key}-${field.field}-${idx}`}>
                          <Table.Cell>{idx === 0 && <Flex gap="1" align="center"><Text weight="medium">{item.label}</Text><Badge size="1" color={item.change === 'added' ? 'green' : 'blue'}>{item.change}</Badge></Flex>}</Table.Cell>
                          <Table.Cell>{field.field}</Table.Cell>
                          <Table.Cell><Text color="gray">{field.from || '—'}</Text></Table.Cell>
                          <Table.Cell>{field.to || '—'}</Table.Cell>
                        </Table.Row>
                      )))}
                    </Table.Body>
                  </Table.Root>
                </Box>
              )}
            </Flex>
          )}
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
}
