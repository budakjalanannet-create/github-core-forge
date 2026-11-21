// Git core for the forge: a content-addressed object store (SHA-1, exactly as git computes it),
// packfile read/write, pkt-line framing, and the smart-HTTP protocol handlers — upload-pack
// protocol v2 (ls-refs + fetch, with shallow/deepen support) and receive-pack protocol v0
// (report-status-v2 over side-band-64k when negotiated). Objects are stored once, globally,
// keyed by their id; repositories hold only refs into that pool, so a pushed object's bytes
// round-trip byte-exactly by construction.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: ObjType;
  readonly data: Buffer;
}

/** The one object pool every repository shares. */
export const objects = new Map<string, GitObject>();

export const ZERO_OID = '0'.repeat(40);

const TYPE_CODES: Readonly<Record<ObjType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Readonly<Record<number, ObjType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function storeObject(type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!objects.has(oid)) objects.set(oid, { type, data });
  return oid;
}

export function getObject(oid: string): GitObject | undefined {
  return objects.get(oid);
}

// ------------------------------------------------------------------ commits and trees

export interface CommitView {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly authorLine: string;
  readonly committerLine: string;
  readonly message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let authorLine = '';
  let committerLine = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) authorLine = line.slice(7);
    else if (line.startsWith('committer ')) committerLine = line.slice(10);
  }
  return { tree, parents, authorLine, committerLine, message };
}

/** The epoch seconds a commit's author line carries (0 when unparseable). */
export function commitTime(data: Buffer): number {
  const view = parseCommit(data);
  const match = / (\d+) [+-]\d{4}$/.exec(view.authorLine);
  return match ? Number(match[1]) : 0;
}

export function buildCommit(fields: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  let head = `tree ${fields.tree}\n`;
  for (const parent of fields.parents) head += `parent ${parent}\n`;
  head += `author ${fields.author}\ncommitter ${fields.committer}\n\n`;
  return Buffer.from(head + fields.message, 'utf8');
}

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree order: by name, with directories sorting as if their name ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Flatten a tree object (recursively) into path -> {oid, mode}. Directories are not entries. */
export function flattenTree(treeOid: string, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
  const tree = objects.get(treeOid);
  if (!tree || tree.type !== 'tree') return out;
  for (const entry of parseTree(tree.data)) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.mode === '40000') flattenTree(entry.oid, path, out);
    else out.set(path, { oid: entry.oid, mode: entry.mode });
  }
  return out;
}

/** Build (and store) nested trees from a flat path -> {oid, mode} map; returns the root tree oid. */
export function buildTreeFromFiles(files: ReadonlyMap<string, { oid: string; mode: string }>): string {
  interface Dir {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, Dir>;
  }
  const root: Dir = { files: new Map(), dirs: new Map() };
  for (const [path, file] of files) {
    const parts = path.split('/');
    let dir = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      let next = dir.dirs.get(parts[i]);
      if (!next) {
        next = { files: new Map(), dirs: new Map() };
        dir.dirs.set(parts[i], next);
      }
      dir = next;
    }
    dir.files.set(parts[parts.length - 1], file);
  }
  const emit = (dir: Dir): string => {
    const entries: TreeEntry[] = [];
    for (const [name, sub] of dir.dirs) entries.push({ mode: '40000', name, oid: emit(sub) });
    for (const [name, file] of dir.files) entries.push({ mode: file.mode, name, oid: file.oid });
    return storeObject('tree', buildTree(entries));
  };
  return emit(root);
}

/** The commit a ref or oid names, peeled through annotated tags. */
export function peelToCommit(oid: string): string | null {
  let current = oid;
  for (let guard = 0; guard < 16; guard += 1) {
    const obj = objects.get(current);
    if (!obj) return null;
    if (obj.type === 'commit') return current;
    if (obj.type === 'tag') {
      const match = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
      if (!match) return null;
      current = match[1];
      continue;
    }
    return null;
  }
  return null;
}

/** Parsed-commit cache: objects are immutable, so a commit's view never changes. */
const commitViews = new Map<string, CommitView>();

export function commitView(oid: string): CommitView | null {
  const hit = commitViews.get(oid);
  if (hit) return hit;
  const obj = objects.get(oid);
  if (!obj || obj.type !== 'commit') return null;
  const view = parseCommit(obj.data);
  commitViews.set(oid, view);
  return view;
}

/** Every commit reachable from `tip` (full history walk), including `tip`. */
export function commitAncestors(tip: string): Set<string> {
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const commit = peelToCommit(oid);
    if (!commit) continue;
    if (seen.has(commit)) continue;
    seen.add(commit);
    const view = commitView(commit);
    if (view) for (const parent of view.parents) stack.push(parent);
  }
  return seen;
}

export function isAncestor(ancestor: string, tip: string): boolean {
  // Early-exit walk: a fast-forward check only needs to know whether `ancestor`
  // shows up on the way back from `tip`, not the whole ancestry. A push that
  // extends a branch finds its old tip one step down.
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const commit = peelToCommit(oid);
    if (!commit) continue;
    if (commit === ancestor) return true;
    const view = commitView(commit);
    if (view) for (const parent of view.parents) stack.push(parent);
  }
  return false;
}

/** The best common ancestor of two commits (the one with the smallest combined distance). */
export function mergeBase(a: string, b: string): string | null {
  const ancestorsOf = (tip: string): Map<string, number> => {
    const dist = new Map<string, number>();
    let frontier = [tip];
    let depth = 0;
    while (frontier.length) {
      const next: string[] = [];
      for (const oid of frontier) {
        const commit = peelToCommit(oid);
        if (!commit || dist.has(commit)) continue;
        dist.set(commit, depth);
        const view = commitView(commit);
        if (view) next.push(...view.parents);
      }
      frontier = next;
      depth += 1;
    }
    return dist;
  };
  const da = ancestorsOf(a);
  const db = ancestorsOf(b);
  let best: string | null = null;
  let bestScore = Infinity;
  for (const [oid, d] of da) {
    const other = db.get(oid);
    if (other !== undefined && d + other < bestScore) {
      bestScore = d + other;
      best = oid;
    }
  }
  return best;
}

// ------------------------------------------------------------------ packfiles

function encodePackObjectHeader(type: ObjType, size: number): Buffer {
  const bytes: number[] = [];
  let byte = (TYPE_CODES[type] << 4) | (size & 0x0f);
  size = Math.floor(size / 16);
  while (size > 0) {
    bytes.push(byte | 0x80);
    byte = size & 0x7f;
    size = Math.floor(size / 128);
  }
  bytes.push(byte);
  return Buffer.from(bytes);
}

/** A version-2 pack holding the given objects as plain (undeltified) entries. */
export function writePack(oids: Iterable<string>): Buffer {
  const list = [...oids].filter((oid) => objects.has(oid));
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  const parts: Buffer[] = [header];
  for (const oid of list) {
    const obj = objects.get(oid) as GitObject;
    parts.push(encodePackObjectHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset];
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset];
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += delta[offset++] * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += delta[offset++] * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta size mismatch');
  return out;
}

/**
 * Read a pack into the object pool. Handles plain objects plus OFS_DELTA and REF_DELTA
 * (bases inside the pack or already in the pool). Returns the number of objects stored.
 * Throws on any structural problem so receive-pack can answer `unpack` with an error.
 */
export function readPack(pack: Buffer): number {
  if (pack.length < 12 + 20) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack magic');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`bad pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const digest = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!trailer.equals(digest)) throw new Error('pack checksum mismatch');
  let offset = 12;
  interface Pending {
    type: ObjType;
    data: Buffer;
  }
  const pending = new Map<string, Pending>();
  const offsets = new Map<number, string>();
  for (let i = 0; i < count; i += 1) {
    const start = offset;
    let byte = pack[offset];
    offset += 1;
    const code = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset];
      offset += 1;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    let baseOid: string | null = null;
    let baseOffset = -1;
    if (code === 6) {
      // OFS_DELTA: a negative offset back to the base object's start.
      byte = pack[offset];
      offset += 1;
      let back = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[offset];
        offset += 1;
        back = ((back + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = start - back;
    } else if (code === 7) {
      baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const inflated = inflateAt(pack, offset);
    offset = inflated.next;
    if (code === 6 || code === 7) {
      let base: GitObject | undefined;
      if (code === 6) {
        const baseId = offsets.get(baseOffset);
        base = baseId ? (pending.get(baseId) ?? objects.get(baseId)) : undefined;
      } else {
        base = (baseOid && (pending.get(baseOid) ?? objects.get(baseOid))) || undefined;
      }
      if (!base) throw new Error('delta base not found');
      const data = applyDelta(base.data, inflated.data);
      const oid = storeObject(base.type, data);
      pending.set(oid, { type: base.type, data });
      offsets.set(start, oid);
    } else {
      const type = CODE_TYPES[code];
      if (!type) throw new Error(`bad pack object code ${code}`);
      if (inflated.data.length !== size) throw new Error('pack object size mismatch');
      const oid = storeObject(type, inflated.data);
      pending.set(oid, { type, data: inflated.data });
      offsets.set(start, oid);
    }
  }
  return count;
}

// ------------------------------------------------------------------ pkt-line

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

export type Packet =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/** Decode a whole buffer of pkt-lines (requests are small enough to hold whole). */
export function decodePackets(buffer: Buffer, startAt = 0): { packets: Packet[]; rest: Buffer } {
  const packets: Packet[] = [];
  let offset = startAt;
  while (offset + 4 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
    } else if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
    } else if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
    } else if (length < 4 || offset + length > buffer.length) {
      break;
    } else {
      packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
      offset += length;
    }
  }
  return { packets, rest: buffer.subarray(offset) };
}

// ------------------------------------------------------------------ repository refs

export interface RefStore {
  refs: Map<string, string>;
  /** The ref HEAD points at, e.g. refs/heads/main. */
  headRef: string;
}

/** Refs in advertisement order: HEAD first, then heads, tags, others, each sorted. */
export function sortedRefNames(store: RefStore): string[] {
  const names = [...store.refs.keys()];
  const rank = (name: string): number =>
    name.startsWith('refs/heads/') ? 0 : name.startsWith('refs/tags/') ? 1 : 2;
  return names.sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
}

/** The peeled commit for an annotated tag ref, or null. */
export function peeledOf(oid: string): string | null {
  const obj = objects.get(oid);
  if (!obj || obj.type !== 'tag') return null;
  return peelToCommit(oid);
}

// ------------------------------------------------------------------ fetch computation

export interface FetchPlan {
  /** Objects to put in the pack. */
  send: string[];
  /** Commits to name in the shallow-info section (the new boundary). */
  shallow: string[];
  /** Commits to name as unshallow (the client's old boundary that is no longer shallow). */
  unshallow: string[];
}

/**
 * Work out what a fetch must carry. `wants`/`haves` are commit ids (peeled), `clientShallow`
 * is the client's current boundary, `depth` the requested deepen/depth (null = full history).
 *
 * Depth counts generations from a want: the want itself is generation 1. The boundary is the
 * set of included commits that have a parent which is not included. Objects reachable from
 * the client's haves — without walking past the client's own shallow boundary — are excluded.
 */
export function planFetch(
  wants: readonly string[],
  haves: readonly string[],
  clientShallow: readonly string[],
  depth: number | null,
  deepenSince: number | null,
  deepenNot: readonly string[],
): FetchPlan {
  const shallowSet = new Set(clientShallow);
  // Exclusion: everything reachable from the haves, but do not walk past the client's
  // shallow boundary (they do not hold anything beyond it).
  const excluded = new Set<string>();
  const excludeStack: Array<{ oid: string; isCommit: boolean }> = [];
  for (const have of haves) {
    const commit = peelToCommit(have);
    if (commit) excludeStack.push({ oid: commit, isCommit: true });
  }
  const excludedCommits = new Set<string>();
  while (excludeStack.length) {
    const { oid, isCommit } = excludeStack.pop() as { oid: string; isCommit: boolean };
    if (excluded.has(oid)) continue;
    excluded.add(oid);
    const obj = objects.get(oid);
    if (!obj) continue;
    if (isCommit && obj.type === 'commit') {
      excludedCommits.add(oid);
      const view = commitView(oid) as CommitView;
      excludeStack.push({ oid: view.tree, isCommit: false });
      if (!shallowSet.has(oid)) {
        for (const parent of view.parents) excludeStack.push({ oid: parent, isCommit: true });
      }
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) excludeStack.push({ oid: entry.oid, isCommit: false });
    } else if (obj.type === 'tag') {
      const target = peelToCommit(oid);
      if (target) excludeStack.push({ oid: target, isCommit: true });
    }
  }

  // The deepen-not exclusion: commits reachable from those refs are cut off entirely.
  const notCommits = new Set<string>();
  for (const ref of deepenNot) {
    const commit = peelToCommit(ref);
    if (commit) for (const oid of commitAncestors(commit)) notCommits.add(oid);
  }

  // Inclusion: BFS by generation from the wants.
  const included = new Set<string>();
  const boundary = new Set<string>();
  const generations = new Map<string, number>();
  let frontier: string[] = [];
  for (const want of wants) {
    const commit = peelToCommit(want);
    if (commit && !generations.has(commit)) {
      generations.set(commit, 1);
      frontier.push(commit);
    }
  }
  const includeObject = (oid: string): void => {
    if (included.has(oid) || excluded.has(oid)) return;
    const obj = objects.get(oid);
    if (!obj) return;
    included.add(oid);
    if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) includeObject(entry.oid);
    }
  };
  while (frontier.length) {
    const next: string[] = [];
    for (const commit of frontier) {
      const generation = generations.get(commit) as number;
      const view = commitView(commit);
      if (!view) continue;
      const beyondDepth = depth !== null && generation >= depth;
      const timeMatch = / (\d+) [+-]\d{4}$/.exec(view.authorLine);
      const beyondSince = deepenSince !== null && (timeMatch ? Number(timeMatch[1]) : 0) <= deepenSince;
      const cut = beyondDepth || beyondSince || notCommits.has(commit);
      if (view.parents.length && cut) boundary.add(commit);
      if (!excludedCommits.has(commit)) {
        included.add(commit);
        includeObject(view.tree);
      }
      if (!cut) {
        for (const parent of view.parents) {
          if (!generations.has(parent)) {
            generations.set(parent, generation + 1);
            next.push(parent);
          }
        }
      }
    }
    frontier = next;
  }
  // Tag objects pointing at included commits travel too (a clone wants its tags).
  for (const want of wants) {
    const obj = objects.get(want);
    if (obj && obj.type === 'tag' && !excluded.has(want)) included.add(want);
  }
  const unshallow = [...shallowSet].filter((oid) => !boundary.has(oid) && included.has(oid));
  return { send: [...included], shallow: [...boundary], unshallow };
}
