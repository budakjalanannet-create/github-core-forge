// The smart-HTTP wire handlers: ref advertisement (v2 for upload-pack when the client asks,
// v0 otherwise and always for receive-pack), the v2 ls-refs and fetch commands, a basic v0
// upload-pack, and receive-pack pushes with per-ref report-status. Repositories are RefStore
// values from git.ts; everything object-shaped lives in the shared pool there.

import {
  ZERO_OID,
  decodePackets,
  getObject,
  isAncestor,
  objects,
  peelToCommit,
  pktLine,
  PKT_FLUSH,
  planFetch,
  readPack,
  sortedRefNames,
  writePack,
  type Packet,
  type RefStore,
} from './git.ts';

export interface WireReply {
  readonly status: number;
  readonly contentType: string;
  readonly body: Buffer;
}

const AGENT = 'forge/1.0';

function notFound(): WireReply {
  return { status: 404, contentType: 'text/plain; charset=utf-8', body: Buffer.from('not found\n') };
}

/** One ref line for a v0 advertisement, with its peeled tag line when annotated. */
function v0RefLines(store: RefStore): string[] {
  const lines: string[] = [];
  for (const name of sortedRefNames(store)) {
    const oid = store.refs.get(name) as string;
    lines.push(`${oid} ${name}\n`);
    const obj = getObject(oid);
    if (obj && obj.type === 'tag') {
      const peeled = peelToCommit(oid);
      if (peeled) lines.push(`${peeled} ${name}^{}\n`);
    }
  }
  return lines;
}

function advertisement(store: RefStore, service: string, v2: boolean): WireReply {
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  if (service === 'git-upload-pack' && v2) {
    parts.push(pktLine('version 2\n'));
    parts.push(pktLine(`agent=${AGENT}\n`));
    parts.push(pktLine('ls-refs=unborn\n'));
    parts.push(pktLine('fetch=shallow\n'));
    parts.push(pktLine('object-format=sha1\n'));
    parts.push(PKT_FLUSH);
  } else if (service === 'git-upload-pack') {
    const caps = `multi_ack_detailed no-done side-band-64k thin-pack ofs-delta symref=HEAD:${store.headRef} agent=${AGENT}`;
    const lines = v0RefLines(store);
    if (lines.length === 0) {
      parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    } else {
      parts.push(pktLine(`${store.refs.get(store.headRef) ?? ZERO_OID} HEAD\0${caps}\n`));
      // HEAD was written with the capabilities; the head ref itself follows as a plain line.
      let headWritten = false;
      for (const line of lines) {
        if (!headWritten && line.endsWith(` ${store.headRef}\n`)) {
          parts.push(pktLine(line));
          headWritten = true;
        } else {
          parts.push(pktLine(line));
        }
      }
    }
    parts.push(PKT_FLUSH);
  } else {
    const caps = `report-status report-status-v2 delete-refs side-band-64k quiet ofs-delta symref=HEAD:${store.headRef} agent=${AGENT}`;
    const lines = v0RefLines(store);
    if (lines.length === 0) {
      parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    } else {
      const headOid = store.refs.get(store.headRef) ?? ZERO_OID;
      let first = true;
      parts.push(pktLine(`${headOid} HEAD\0${caps}\n`));
      for (const line of lines) {
        parts.push(pktLine(first ? line : line));
        first = false;
      }
    }
    parts.push(PKT_FLUSH);
  }
  return { status: 200, contentType: `application/x-${service}-advertisement`, body: Buffer.concat(parts) };
}

export function handleInfoRefs(store: RefStore | null, service: string, v2Requested: boolean): WireReply {
  if (!store) return notFound();
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return notFound();
  return advertisement(store, service, v2Requested);
}

/** Split a request body into its argument lines (data payloads up to the first flush). */
function argLines(packets: Packet[]): { lines: string[]; afterFirstDelim: string[] } {
  const lines: string[] = [];
  const after: string[] = [];
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind === 'flush') break;
    if (packet.kind === 'data') {
      const text = packet.payload.toString('utf8').replace(/\n$/, '');
      if (seenDelim) after.push(text);
      else lines.push(text);
    }
  }
  return { lines, afterFirstDelim: after };
}

function lsRefs(store: RefStore, args: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const parts: Buffer[] = [];
  const headTarget = store.headRef;
  const headOid = store.refs.get(headTarget);
  if (keep('HEAD')) {
    if (headOid) {
      let line = `${headOid} HEAD`;
      if (symrefs) line += ` symref-target:${headTarget}`;
      parts.push(pktLine(`${line}\n`));
    } else if (unborn) {
      let line = 'unborn HEAD';
      if (symrefs) line += ` symref-target:${headTarget}`;
      parts.push(pktLine(`${line}\n`));
    }
  }
  for (const name of sortedRefNames(store)) {
    if (!keep(name)) continue;
    const oid = store.refs.get(name) as string;
    let line = `${oid} ${name}`;
    if (peel) {
      const obj = getObject(oid);
      if (obj && obj.type === 'tag') {
        const peeled = peelToCommit(oid);
        if (peeled) line += ` peeled:${peeled}`;
      }
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** Wrap pack bytes into sideband band-1 pkt-lines (band byte + at most 65515 data bytes). */
function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  if (pack.length === 0) {
    parts.push(pktLine(Buffer.concat([Buffer.from([1])])));
    return Buffer.concat(parts);
  }
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return Buffer.concat(parts);
}

function fetchV2(store: RefStore, args: string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow: string[] = [];
  const deepenNot: string[] = [];
  let depth: number | null = null;
  let deepenSince: number | null = null;
  let done = false;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) clientShallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) depth = Number(arg.slice(7).trim());
    else if (arg.startsWith('deepen-since ')) deepenSince = Number(arg.slice('deepen-since '.length).trim());
    else if (arg.startsWith('deepen-not ')) deepenNot.push(arg.slice('deepen-not '.length).trim());
    else if (arg === 'done') done = true;
  }
  const plan = planFetch(wants, haves, clientShallow, depth, deepenSince, deepenNot);
  const parts: Buffer[] = [];
  if (!done) {
    parts.push(pktLine('acknowledgments\n'));
    const common = haves.filter((have) => {
      const commit = peelToCommit(have);
      return commit !== null && wants.some((want) => {
        const wantCommit = peelToCommit(want);
        return wantCommit !== null && (wantCommit === commit || isAncestor(commit, wantCommit));
      });
    });
    if (common.length === 0) parts.push(pktLine('NAK\n'));
    else for (const oid of common) parts.push(pktLine(`ACK ${oid}\n`));
    parts.push(pktLine('ready\n'));
    parts.push(PKT_FLUSH);
  }
  if (plan.shallow.length || plan.unshallow.length || depth !== null || clientShallow.length) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_FLUSH);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandPack(writePack(plan.send)));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function fetchV0(store: RefStore, packets: Packet[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  let sideband = false;
  let first = true;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    let text = packet.payload.toString('utf8').replace(/\n$/, '');
    if (first) {
      first = false;
      const nul = text.indexOf('\0');
      if (nul >= 0) {
        const caps = text.slice(nul + 1);
        if (caps.split(' ').some((cap) => cap === 'side-band-64k' || cap === 'side-band')) sideband = true;
        text = text.slice(0, nul);
      }
    }
    if (text.startsWith('want ')) wants.push(text.slice(5, 45));
    else if (text.startsWith('have ')) haves.push(text.slice(5, 45));
  }
  const plan = planFetch(wants, haves, [], null, null, []);
  const pack = writePack(plan.send);
  const parts: Buffer[] = [pktLine('NAK\n')];
  if (sideband) {
    parts.push(sidebandPack(pack));
    parts.push(PKT_FLUSH);
  } else {
    parts.push(pack);
  }
  return Buffer.concat(parts);
}

export function handleUploadPack(store: RefStore | null, body: Buffer, v2: boolean): WireReply {
  if (!store) return notFound();
  const { packets } = decodePackets(body);
  const { lines, afterFirstDelim } = argLines(packets);
  const command = lines.find((line) => line.startsWith('command='));
  let reply: Buffer;
  if (v2 && command === 'command=ls-refs') reply = lsRefs(store, afterFirstDelim);
  else if (v2 && command === 'command=fetch') reply = fetchV2(store, afterFirstDelim);
  else if (!v2) reply = fetchV0(store, packets);
  else reply = Buffer.concat([pktLine('error: unsupported command\n'), PKT_FLUSH]);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: reply };
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(store: RefStore | null, body: Buffer): WireReply {
  if (!store) return notFound();
  const { packets, rest } = decodePackets(body);
  const commands: PushCommand[] = [];
  const capabilities = new Set<string>();
  let first = true;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    let text = packet.payload.toString('utf8').replace(/\n$/, '');
    if (first) {
      first = false;
      const nul = text.indexOf('\0');
      if (nul >= 0) {
        for (const cap of text.slice(nul + 1).split(' ')) if (cap) capabilities.add(cap);
        text = text.slice(0, nul);
      }
    }
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(text);
    if (match) commands.push({ oldOid: match[1], newOid: match[2], ref: match[3] });
  }
  const sideband = capabilities.has('side-band-64k');
  const reportLines: string[] = [];
  const updatesRef = commands.some((command) => command.newOid !== ZERO_OID);
  let unpackError: string | null = null;
  if (updatesRef) {
    if (rest.length === 0) unpackError = 'no pack sent';
    else {
      try {
        readPack(rest);
      } catch (err) {
        unpackError = err instanceof Error ? err.message : 'unpack failed';
      }
    }
  }
  if (unpackError) {
    reportLines.push(`unpack ${unpackError.replace(/\s+/g, ' ')}\n`);
    for (const command of commands) reportLines.push(`ng ${command.ref} unpacker error\n`);
  } else {
    reportLines.push('unpack ok\n');
    const wasEmpty = store.refs.size === 0;
    for (const command of commands) {
      const current = store.refs.get(command.ref) ?? ZERO_OID;
      let reason: string | null = null;
      if (!command.ref.startsWith('refs/')) reason = 'bad ref';
      else if (command.oldOid !== current) reason = `expected ${command.oldOid} but ref is ${current}`;
      else if (command.newOid === ZERO_OID) {
        if (command.ref === store.headRef && store.refs.has(command.ref)) reason = 'cannot delete the current branch';
        else if (current === ZERO_OID) reason = 'ref does not exist';
      } else if (!objects.has(command.newOid)) reason = 'new object not in pack';
      else if (command.oldOid !== ZERO_OID) {
        const newCommit = peelToCommit(command.newOid);
        const oldCommit = peelToCommit(command.oldOid);
        if (!newCommit) reason = 'new value is not a commit';
        else if (oldCommit && !isAncestor(oldCommit, newCommit)) reason = 'non-fast-forward';
      }
      if (reason) {
        reportLines.push(`ng ${command.ref} ${reason}\n`);
      } else {
        if (command.newOid === ZERO_OID) store.refs.delete(command.ref);
        else store.refs.set(command.ref, command.newOid);
        if (wasEmpty && command.ref.startsWith('refs/heads/')) store.headRef = command.ref;
        reportLines.push(`ok ${command.ref}\n`);
      }
    }
  }
  const reportStream = Buffer.concat([...reportLines.map((line) => pktLine(line)), PKT_FLUSH]);
  let reply: Buffer;
  if (sideband) {
    const parts: Buffer[] = [];
    const CHUNK = 65515;
    for (let offset = 0; offset < reportStream.length; offset += CHUNK) {
      const chunk = reportStream.subarray(offset, Math.min(reportStream.length, offset + CHUNK));
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
    }
    parts.push(PKT_FLUSH);
    reply = Buffer.concat(parts);
  } else {
    reply = reportStream;
  }
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: reply };
}
