import type { FixRow, MismatchRow, NewReport, ReportRow } from "./db.ts";
import { similarity, type CueHash, type FixCue } from "./fingerprint.ts";

export type ReportReason = NewReport["reason"];

export type FixView = {
  subtitleHashes: CueHash[];
  cues: FixCue[];
  cuesOmitted?: true;
  status: "confirmed" | "hint";
  method: string;
  agreeing: number;
  fromAudio: boolean;
};

export type HiddenView = {
  subtitleHashes: CueHash[];
  reason: "mismatch" | ReportReason;
  count: number;
};

export type VideoTimings = { fixes: FixView[]; hidden: HiddenView[] };

type Row = FixRow | MismatchRow | ReportRow;
type Timed = {
  fix: FixRow;
  ids: number[];
  cues: FixCue[];
  repeatedIds: number[];
};
type Interned = { hashes: CueHash[]; timed: Timed[] };
type Ranked = { view: FixView; newest: number };

const sameSubtitleShare = 0.9;
const toleranceMs = 100;
const agreeingPercent = 80;
const minimumSharedCues = 20;
const mismatchSubmitters = 2;
const reportSubmitters = 3;
const maximumViews = 20;
const hintsWithCues = 5;
const absent = -1;

const byAge = (a: Row, b: Row) => a.createdAt.getTime() - b.createdAt.getTime();

const newestOf = <Item extends Row>(rows: Item[]) =>
  rows.reduce((newest, row) => (row.createdAt >= newest.createdAt ? row : newest));

const submittersOf = (rows: Row[]) => new Set(rows.map((row) => row.submitter));

const connected = <Item>(
  items: Item[],
  candidates: (at: number) => Iterable<number>,
  linked: (a: Item, b: Item) => boolean,
): Item[][] => {
  const labels = items.map((_, index) => index);

  items.forEach((item, at) => {
    for (const other of candidates(at)) {
      const from = labels[at];
      const to = labels[other] ?? other;
      const otherItem = items[other];

      if (from !== to && otherItem !== undefined && linked(item, otherItem)) {
        labels.forEach((label, index) => {
          labels[index] = label === from ? to : label;
        });
      }
    }
  });

  return [...Map.groupBy(items, (_, index) => labels[index]).values()];
};

const sameSubtitle = ([a]: Row[], [b]: Row[]) =>
  similarity(a?.subtitleHashes ?? [], b?.subtitleHashes ?? []) >= sameSubtitleShare;

const orderOf = (hash: CueHash) => Number.parseInt(hash.slice(0, 8), 16);

const prefixOf = (hashes: CueHash[]) => {
  const unique = [...new Set(hashes)];
  const orders = unique.map(orderOf);
  const last =
    Uint32Array.from(orders).toSorted()[
      unique.length - Math.floor(unique.length * sameSubtitleShare)
    ] ?? Infinity;

  return unique.filter((_, index) => (orders[index] ?? 0) <= last);
};

const cluster = <Item extends Row>(rows: Item[]): Item[][] => {
  const buckets = [...Map.groupBy(rows, (row) => row.subtitleHashes.join()).values()];
  const prefixes = buckets.map(([first]) => prefixOf(first?.subtitleHashes ?? []));
  const holders = Map.groupBy(
    prefixes.flatMap((prefix, at) => prefix.map((hash) => ({ hash, at }))),
    ({ hash }) => hash,
  );
  const earlierSharing = (at: number) =>
    [
      ...new Set(
        (prefixes[at] ?? []).flatMap((hash) =>
          (holders.get(hash) ?? []).flatMap((holder) => (holder.at < at ? [holder.at] : [])),
        ),
      ),
    ].toSorted((a, b) => b - a);

  return connected(buckets, earlierSharing, sameSubtitle).map((group) => group.flat());
};

const interned = (group: FixRow[]): Interned => {
  const ids = new Map<CueHash, number>();
  const idOf = (hash: CueHash) => {
    const id = ids.get(hash) ?? ids.size;

    if (id === ids.size) {
      ids.set(hash, id);
    }

    return id;
  };
  const withIds = group.map((fix) => ({ fix, cueIds: fix.cues.map((cue) => idOf(cue.h)) }));

  const copies = new Int32Array(ids.size);

  return {
    hashes: [...ids.keys()],
    timed: withIds.map(({ fix, cueIds }) => {
      cueIds.forEach((id) => {
        copies[id] = (copies[id] ?? 0) + 1;
      });

      const onceAt = cueIds
        .map((_, index) => index)
        .filter((index) => copies[cueIds[index] ?? 0] === 1);
      const repeatedIds = cueIds.filter((id) => (copies[id] ?? 0) > 1);

      cueIds.forEach((id) => {
        copies[id] = 0;
      });

      return {
        fix,
        ids: onceAt.map((index) => cueIds[index] ?? 0),
        cues: onceAt.flatMap((index) => fix.cues[index] ?? []),
        repeatedIds,
      };
    }),
  };
};

const agreement = ({ hashes }: Interned) => {
  const starts = new Float64Array(hashes.length).fill(absent);
  const ends = new Float64Array(hashes.length);
  let spread: Timed | undefined;

  const spreadOut = (timed: Timed) => {
    spread?.ids.forEach((id) => {
      starts[id] = absent;
    });
    timed.cues.forEach((cue, index) => {
      const id = timed.ids[index] ?? 0;

      starts[id] = cue.s;
      ends[id] = cue.e;
    });
    spread = timed;
  };

  return (left: Timed, right: Timed) => {
    if (spread !== left) {
      spreadOut(left);
    }

    const allowedApart = Math.min(left.ids.length, right.ids.length) * (100 - agreeingPercent);
    let shared = 0;
    let apart = 0;

    for (let index = 0; index < right.ids.length && apart * 100 <= allowedApart; index += 1) {
      const id = right.ids[index] ?? 0;
      const start = starts[id] ?? absent;
      const cue = right.cues[index];

      if (start !== absent && cue !== undefined) {
        shared += 1;
        apart +=
          Math.abs(start - cue.s) <= toleranceMs && Math.abs((ends[id] ?? 0) - cue.e) <= toleranceMs
            ? 0
            : 1;
      }
    }

    return shared >= minimumSharedCues && (shared - apart) * 100 >= shared * agreeingPercent;
  };
};

const agreeingComponents = (group: Interned) => {
  const agree = agreement(group);

  return connected(
    group.timed,
    (at) => group.timed.slice(0, at).keys(),
    (a, b) => a.fix.submitter !== b.fix.submitter && agree(a, b),
  );
};

const largest = (components: Timed[][]) =>
  components.reduce((best, component) =>
    submittersOf(component.map(({ fix }) => fix)).size >
    submittersOf(best.map(({ fix }) => fix)).size
      ? component
      : best,
  );

const hasKey = (fix: FixRow) => (fix.referenceKey ?? "") !== "";

const isConfirmed = (fixes: FixRow[]) =>
  submittersOf(fixes).size >= 2 &&
  (fixes.some((fix) => fix.method === "audio") ||
    fixes.some((one) =>
      fixes.some(
        (other) =>
          one.submitter !== other.submitter &&
          hasKey(one) &&
          hasKey(other) &&
          one.referenceKey !== other.referenceKey,
      ),
    ));

const median = (values: number[]) => {
  const sorted = Int32Array.from(values).toSorted();

  return Math.round(
    ((sorted[(sorted.length - 1) >> 1] ?? 0) + (sorted[sorted.length >> 1] ?? 0)) / 2,
  );
};

const confirmedView = (hashes: CueHash[], component: Timed[]): FixView => {
  const fixes = component.map(({ fix }) => fix);
  const starts: number[][] = [];
  const ends: number[][] = [];
  const repeatedIds = new Set(component.flatMap((timed) => timed.repeatedIds));

  component.forEach((timed) =>
    timed.cues.forEach((cue, index) => {
      const id = timed.ids[index] ?? 0;

      (starts[id] ??= []).push(cue.s);
      (ends[id] ??= []).push(cue.e);
    }),
  );

  const cues = hashes.flatMap((h, id) => {
    const cueStarts = starts[id] ?? [];

    return cueStarts.length === 0 || repeatedIds.has(id)
      ? []
      : [{ h, s: median(cueStarts), e: median(ends[id] ?? []) }];
  });
  const fromAudio = fixes.some((fix) => fix.method === "audio");
  const [mostCommon] = [...Map.groupBy(fixes, (fix) => fix.method)].reduce((best, entry) =>
    entry[1].length > best[1].length ? entry : best,
  );

  return {
    subtitleHashes: newestOf(fixes).subtitleHashes,
    cues: cues.toSorted((a, b) => a.s - b.s || a.e - b.e),
    status: "confirmed",
    method: fromAudio ? "audio" : mostCommon,
    agreeing: submittersOf(fixes).size,
    fromAudio,
  };
};

const hintOf = (group: FixRow[]): Ranked => {
  const newest = newestOf(group);

  return {
    view: {
      subtitleHashes: newest.subtitleHashes,
      cues: newest.cues,
      status: "hint",
      method: newest.method,
      agreeing: 1,
      fromAudio: newest.method === "audio",
    },
    newest: newest.createdAt.getTime(),
  };
};

const rankedView = (group: FixRow[]): Ranked => {
  if (submittersOf(group).size < 2) {
    return hintOf(group);
  }

  const internedGroup = interned(group);
  const component = largest(agreeingComponents(internedGroup));
  const fixes = component.map(({ fix }) => fix);

  return isConfirmed(fixes)
    ? {
        view: confirmedView(internedGroup.hashes, component),
        newest: newestOf(fixes).createdAt.getTime(),
      }
    : hintOf(group);
};

const hiddenIn = (
  mismatches: MismatchRow[],
  reports: ReportRow[],
  viewer?: string,
): HiddenView[] => {
  const mismatchers = submittersOf(mismatches);
  const ownMismatch = viewer !== undefined && mismatchers.has(viewer);
  const mismatchViews =
    mismatchers.size >= mismatchSubmitters || ownMismatch
      ? [
          {
            subtitleHashes: newestOf(mismatches).subtitleHashes,
            reason: "mismatch" as const,
            count: mismatchers.size,
          },
        ]
      : [];
  const reportViews = [...Map.groupBy(reports, (row) => row.reason)].flatMap(([reason, rows]) => {
    const count = submittersOf(rows).size;

    return count >= reportSubmitters
      ? [{ subtitleHashes: newestOf(rows).subtitleHashes, reason, count }]
      : [];
  });

  return [...mismatchViews, ...reportViews];
};

const withCuesFor = (views: FixView[]) => {
  const hintsKept = new Set(views.filter((view) => view.status === "hint").slice(0, hintsWithCues));

  return views.map((view) =>
    view.status === "confirmed" || hintsKept.has(view)
      ? view
      : { ...view, cues: [], cuesOmitted: true as const },
  );
};

export const summarize = (
  fixes: FixRow[],
  mismatches: MismatchRow[],
  reports: ReportRow[],
  viewer?: string,
): VideoTimings => {
  const oldestFirst = fixes.toSorted(byAge);
  const subtitles = cluster([...fixes, ...mismatches, ...reports].toSorted(byAge)).map((rows) => {
    const members = new Set<Row>(rows);
    const subtitleFixes = oldestFirst.filter((row) => members.has(row));

    return {
      fixGroups: subtitleFixes.length === rows.length ? [subtitleFixes] : cluster(subtitleFixes),
      hidden: hiddenIn(
        mismatches.filter((row) => members.has(row)),
        reports.filter((row) => members.has(row)),
        viewer,
      ),
    };
  });
  const ranked = subtitles
    .flatMap(({ fixGroups, hidden }) => (hidden.length === 0 ? fixGroups.map(rankedView) : []))
    .toSorted((a, b) => b.view.agreeing - a.view.agreeing || b.newest - a.newest)
    .slice(0, maximumViews);

  return {
    fixes: withCuesFor(ranked.map(({ view }) => view)),
    hidden: subtitles.flatMap(({ hidden }) => hidden),
  };
};
