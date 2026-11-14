import postgres from "postgres";
import type { CueHash, FixCue } from "./fingerprint.ts";

export type VideoKey = { hash: string; size: number };

export type NewFix = {
  video: VideoKey;
  subtitleHashes: CueHash[];
  cues: FixCue[];
  method: "audio" | "reference" | "release-name";
  referenceKey?: string;
  submitter: string;
};

export type NewMismatch = { video: VideoKey; subtitleHashes: CueHash[]; submitter: string };

export type NewReport = {
  video: VideoKey;
  subtitleHashes: CueHash[];
  reason:
    | "machine-translated"
    | "wrong-language"
    | "lines-missing"
    | "timing-off"
    | "broken-characters";
  submitter: string;
};

export type FixRow = NewFix & { createdAt: Date };
export type MismatchRow = NewMismatch & { createdAt: Date };
export type ReportRow = NewReport & { createdAt: Date };

export type TimingsStore = {
  fixesFor(video: VideoKey): Promise<FixRow[]>;
  mismatchesFor(video: VideoKey): Promise<MismatchRow[]>;
  reportsFor(video: VideoKey): Promise<ReportRow[]>;
  putFix(row: NewFix): Promise<void>;
  putMismatch(row: NewMismatch): Promise<void>;
  putReport(row: NewReport): Promise<void>;
};

type Keyed = { video: VideoKey; submitter: string; subtitleHashes: CueHash[] };

const sameVideo = (a: VideoKey, b: VideoKey) => a.hash === b.hash && a.size === b.size;

const sameSlot = (a: Keyed, b: Keyed) =>
  sameVideo(a.video, b.video) &&
  a.submitter === b.submitter &&
  a.subtitleHashes.join(",") === b.subtitleHashes.join(",");

const memoryTable = <Row extends Keyed>() => {
  let rows: (Row & { createdAt: Date })[] = [];

  return {
    for: (video: VideoKey) => rows.filter((row) => sameVideo(row.video, video)),
    put: (row: Row) => {
      rows = [
        ...rows.filter((existing) => !sameSlot(existing, row)),
        { ...row, createdAt: new Date() },
      ];
    },
  };
};

export const memoryStore = (): TimingsStore => {
  const fixes = memoryTable<NewFix>();
  const mismatches = memoryTable<NewMismatch>();
  const reports = memoryTable<NewReport>();

  return {
    fixesFor: async (video) => fixes.for(video),
    mismatchesFor: async (video) => mismatches.for(video),
    reportsFor: async (video) => reports.for(video),
    putFix: async (row) => fixes.put(row),
    putMismatch: async (row) => mismatches.put(row),
    putReport: async (row) => reports.put(row),
  };
};

type VideoColumns = { video_hash: string; video_size: string | number };

const videoOf = (row: VideoColumns): VideoKey => ({
  hash: row.video_hash,
  size: Number(row.video_size),
});

type FixColumns = VideoColumns & {
  subtitle_hashes: string[];
  cues: FixCue[];
  method: NewFix["method"];
  reference_key: string | null;
  submitter: string;
  created_at: Date;
};

type MismatchColumns = VideoColumns & {
  subtitle_hashes: string[];
  submitter: string;
  created_at: Date;
};

type ReportColumns = MismatchColumns & { reason: NewReport["reason"] };

export const postgresStore = (url: string): TimingsStore => {
  const sql = postgres(url, { max: 1, prepare: false, idle_timeout: 20, connect_timeout: 5 });

  return {
    fixesFor: async (video) => {
      const rows = await sql<FixColumns[]>`
        select video_hash, video_size, subtitle_hashes, cues, method, reference_key, submitter, created_at
        from fixes
        where video_hash = ${video.hash} and video_size = ${video.size}
        order by created_at, id`;

      return rows.map((row) => ({
        video: videoOf(row),
        subtitleHashes: row.subtitle_hashes,
        cues: row.cues,
        method: row.method,
        ...(row.reference_key === null ? {} : { referenceKey: row.reference_key }),
        submitter: row.submitter,
        createdAt: row.created_at,
      }));
    },
    mismatchesFor: async (video) => {
      const rows = await sql<MismatchColumns[]>`
        select video_hash, video_size, subtitle_hashes, submitter, created_at
        from mismatches
        where video_hash = ${video.hash} and video_size = ${video.size}
        order by created_at, id`;

      return rows.map((row) => ({
        video: videoOf(row),
        subtitleHashes: row.subtitle_hashes,
        submitter: row.submitter,
        createdAt: row.created_at,
      }));
    },
    reportsFor: async (video) => {
      const rows = await sql<ReportColumns[]>`
        select video_hash, video_size, subtitle_hashes, reason, submitter, created_at
        from reports
        where video_hash = ${video.hash} and video_size = ${video.size}
        order by created_at, id`;

      return rows.map((row) => ({
        video: videoOf(row),
        subtitleHashes: row.subtitle_hashes,
        reason: row.reason,
        submitter: row.submitter,
        createdAt: row.created_at,
      }));
    },
    putFix: async (row) => {
      await sql`
        insert into fixes (video_hash, video_size, subtitle_hashes, cues, method, reference_key, submitter)
        values (${row.video.hash}, ${row.video.size}, ${row.subtitleHashes}, ${sql.json(row.cues)}, ${row.method}, ${row.referenceKey ?? null}, ${row.submitter})
        on conflict (video_hash, video_size, submitter, subtitle_key) do update
        set cues = excluded.cues, method = excluded.method, reference_key = excluded.reference_key, created_at = now()`;
    },
    putMismatch: async (row) => {
      await sql`
        insert into mismatches (video_hash, video_size, subtitle_hashes, submitter)
        values (${row.video.hash}, ${row.video.size}, ${row.subtitleHashes}, ${row.submitter})
        on conflict (video_hash, video_size, submitter, subtitle_key) do update
        set created_at = now()`;
    },
    putReport: async (row) => {
      await sql`
        insert into reports (video_hash, video_size, subtitle_hashes, reason, submitter)
        values (${row.video.hash}, ${row.video.size}, ${row.subtitleHashes}, ${row.reason}, ${row.submitter})
        on conflict (video_hash, video_size, submitter, subtitle_key) do update
        set reason = excluded.reason, created_at = now()`;
    },
  };
};
