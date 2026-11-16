import type { Cue } from "../subtitles/cue.ts";
import { parseRelease, sameGroup } from "../subtitles/release.ts";
import { alignCues, alignOffset, bestSpeedRatio, speedRatios } from "../timing/alass.ts";
import { deltasOf, median, retimedMinimumScore } from "../timing/retime.ts";
import type { BenchFile, FileResult, Listed, Run } from "./stremio-bench.ts";
import { truthOf, type Truth } from "./truth.ts";

export type Member = Listed & { cues: Cue[] };

export const agreementMs = 150;
export const agreementShare = 0.9;

export type Counter = { alignments: number };

export const sameTiming = async (reference: Cue[], subtitle: Cue[], counter: Counter) => {
  const speedRatio = bestSpeedRatio(reference, subtitle, speedRatios);

  counter.alignments += speedRatios.length;

  if (speedRatio !== 1) {
    return false;
  }

  const rigid = alignOffset(reference, subtitle);

  counter.alignments += 1;

  if (rigid.score < retimedMinimumScore || Math.abs(rigid.offsetMs) > agreementMs) {
    return false;
  }

  const split = await alignCues(reference, subtitle);

  counter.alignments += 1;

  const deltas = deltasOf(subtitle, split.cues, 1);
  const shift = median(deltas);
  const within = deltas.filter((delta) => Math.abs(delta - shift) <= agreementMs).length;

  return Math.abs(shift) <= agreementMs && within / Math.max(deltas.length, 1) >= agreementShare;
};

export const clustersOf = async (members: Member[], counter: Counter) =>
  members.reduce<Promise<Member[][]>>(async (done, member) => {
    const clusters = await done;
    const home = await clusters.reduce<Promise<Member[] | undefined>>(
      async (found, cluster) =>
        (await found) ??
        ((await sameTiming(cluster[0]?.cues ?? [], member.cues, counter)) ? cluster : undefined),
      Promise.resolve(undefined),
    );

    if (home === undefined) {
      return [...clusters, [member]];
    }

    home.push(member);

    return clusters;
  }, Promise.resolve([]));

const releaseScore = (member: Member, filename: string) => {
  const file = parseRelease(filename);
  const release = parseRelease(member.releaseName ?? "");

  return (
    (sameGroup(release, file) ? 18 : 0) +
    (release.source !== undefined && release.source === file.source ? 4 : 0) +
    (release.resolution !== undefined && release.resolution === file.resolution ? 1 : 0)
  );
};

const largest = (clusters: Member[][]) =>
  clusters.reduce<Member[] | undefined>(
    (best, cluster) => (best === undefined || cluster.length > best.length ? cluster : best),
    undefined,
  );

const withHash = (clusters: Member[][]) =>
  clusters.find((cluster) => cluster.some(({ hashMatch }) => hashMatch));

const byRelease = (clusters: Member[][], filename: string) => {
  const scored = clusters.map((cluster) => ({
    cluster,
    score: Math.max(...cluster.map((member) => releaseScore(member, filename))),
  }));
  const best = Math.max(0, ...scored.map(({ score }) => score));

  return best === 0
    ? undefined
    : largest(scored.filter(({ score }) => score === best).map(({ cluster }) => cluster));
};

const atLeastTwo = (cluster: Member[] | undefined) =>
  cluster !== undefined && cluster.length >= 2 ? cluster : undefined;

export type Strategy = {
  name: string;
  anchor: (clusters: Member[][], filename: string, members: Member[]) => Member[] | undefined;
  sameLanguageMember?: boolean;
};

export const strategies: Strategy[] = [
  { name: "A largest", anchor: largest },
  { name: "B hash, else A", anchor: (clusters) => withHash(clusters) ?? largest(clusters) },
  {
    name: "C release, else A",
    anchor: (clusters, filename) => byRelease(clusters, filename) ?? largest(clusters),
  },
  {
    name: "D1 B, then C, then A",
    anchor: (clusters, filename) =>
      withHash(clusters) ?? byRelease(clusters, filename) ?? largest(clusters),
  },
  { name: "D2 A, size >= 2", anchor: (clusters) => atLeastTwo(largest(clusters)) },
  {
    name: "D3 D1, size >= 2",
    anchor: (clusters, filename) =>
      withHash(clusters) ??
      atLeastTwo(byRelease(clusters, filename)) ??
      atLeastTwo(largest(clusters)),
  },
  {
    name: "D4 D3, same-language member first",
    anchor: (clusters, filename) =>
      withHash(clusters) ??
      atLeastTwo(byRelease(clusters, filename)) ??
      atLeastTwo(largest(clusters)),
    sameLanguageMember: true,
  },
  {
    name: "E hash or release candidate, no clustering",
    anchor: (_clusters, filename, members) => {
      const hashed = members.find(({ hashMatch }) => hashMatch);
      const best = Math.max(0, ...members.map((member) => releaseScore(member, filename)));
      const released = members.find(
        (member) => best > 0 && releaseScore(member, filename) === best,
      );
      const anchor = hashed ?? released;

      return anchor === undefined ? undefined : [anchor];
    },
  },
];

export const retimedTo = (anchor: Cue[], subtitle: Cue[], counter: Counter) => {
  const speedRatio = bestSpeedRatio(anchor, subtitle, speedRatios);
  const aligned = alignOffset(anchor, subtitle, { speedRatio });

  counter.alignments += speedRatios.length + 1;

  return aligned.score >= retimedMinimumScore ? aligned.cues : subtitle;
};

const keyOf = ({ sourceName, ref }: Pick<Listed, "sourceName" | "ref">) => `${sourceName}\n${ref}`;

export type Simulated = {
  strategy: string;
  lang: string;
  production: Run["outcome"];
  outcome: Run["outcome"];
  anchored: boolean;
  anchorCorrect?: boolean;
  alignments: number;
};

export const simulateFile = async ({
  result,
  file,
  members,
  clusters,
  candidateTruths,
}: {
  result: FileResult;
  file: BenchFile;
  members: Member[];
  clusters: Member[][];
  candidateTruths: Map<string, Truth>;
}): Promise<Simulated[]> => {
  const judged = new Map<string, Promise<Truth>>();
  const judge = (cues: Cue[], lang: string) => {
    const key = `${lang}\n${cues.map(({ start, end, text }) => `${start} ${end} ${text}`).join("\n")}`;
    const truth = judged.get(key) ?? truthOf(cues, lang, file.verified);

    judged.set(key, truth);

    return truth;
  };
  const byKey = new Map(members.map((member) => [keyOf(member), member]));

  const simulateRun = async (strategy: Strategy, run: Run): Promise<Simulated> => {
    const anchor = strategy.anchor(clusters, result.filename, members);
    const served =
      run.servedRef === undefined
        ? undefined
        : byKey.get(keyOf({ sourceName: run.servedRef.n, ref: run.servedRef.r }));
    const base = { strategy: strategy.name, lang: run.lang, production: run.outcome };
    const leader = anchor?.[0];

    if (anchor === undefined || leader === undefined || served === undefined) {
      return { ...base, outcome: run.outcome, anchored: false, alignments: 0 };
    }

    const anchorCorrect = candidateTruths.get(keyOf(leader))?.outcome === "correct";
    const inAnchor = new Set(anchor.map(keyOf));
    const sameLanguage = strategy.sameLanguageMember
      ? run.candidates
          .map((each) => byKey.get(keyOf(each)))
          .find((each) => each !== undefined && inAnchor.has(keyOf(each)))
      : undefined;
    const counter = { alignments: 0 };
    const cues =
      sameLanguage?.cues ??
      (inAnchor.has(keyOf(served)) ? served.cues : retimedTo(leader.cues, served.cues, counter));
    const truth = await judge(cues, run.lang);

    return {
      ...base,
      outcome: truth.outcome,
      anchored: true,
      anchorCorrect,
      alignments: counter.alignments,
    };
  };

  return strategies.reduce<Promise<Simulated[]>>(
    async (done, strategy) => [
      ...(await done),
      ...(await result.runs.reduce<Promise<Simulated[]>>(
        async (runs, run) => [...(await runs), await simulateRun(strategy, run)],
        Promise.resolve([]),
      )),
    ],
    Promise.resolve([]),
  );
};

const outcomeNames = ["correct", "wrong-timing", "wrong-title", "unmeasurable", "nothing"] as const;

const row = (cells: (string | number)[]) => `| ${cells.join(" | ")} |`;

export const anchorTables = (
  perFile: {
    filename: string;
    simulated: Simulated[];
    clusterAlignments: number;
    clusterCPUMs: number;
    members: number;
    clusters: number;
  }[],
) => {
  const all = perFile.flatMap(({ simulated }) => simulated);
  const names = [...new Set(all.map(({ strategy }) => strategy))];
  const production = all.filter(({ strategy }) => strategy === names[0]);
  const count = (runs: { outcome: Run["outcome"] }[]) =>
    outcomeNames.map((outcome) => runs.filter((each) => each.outcome === outcome).length);
  const pooled = [
    row([
      "strategy",
      ...outcomeNames,
      "correct to wrong",
      "wrong to correct",
      "files with a wrong anchor",
      "serving alignments",
    ]),
    row(Array.from({ length: outcomeNames.length + 5 }, () => "---")),
    row([
      "production 37c481c",
      ...count(production.map(({ production: outcome }) => ({ outcome }))),
      0,
      0,
      "-",
      0,
    ]),
    ...names.map((name) => {
      const runs = all.filter(({ strategy }) => strategy === name);
      const wrongAnchors = perFile.filter(({ simulated }) =>
        simulated.some(
          (each) => each.strategy === name && each.anchored && each.anchorCorrect === false,
        ),
      ).length;

      return row([
        name,
        ...count(runs),
        runs.filter((each) => each.production === "correct" && each.outcome !== "correct").length,
        runs.filter((each) => each.production !== "correct" && each.outcome === "correct").length,
        wrongAnchors,
        runs.reduce((sum, each) => sum + each.alignments, 0),
      ]);
    }),
  ];
  const films = [
    row([
      "file",
      "candidates",
      "clusters",
      "clustering alignments",
      "clustering CPU",
      "production correct",
      ...names.map((name) => `${name.split(" ")[0]} correct`),
    ]),
    row(Array.from({ length: names.length + 6 }, () => "---")),
    ...perFile.map(({ filename, simulated, clusterAlignments, clusterCPUMs, members, clusters }) =>
      row([
        filename,
        members,
        clusters,
        clusterAlignments,
        `${(clusterCPUMs / 1000).toFixed(1)} s`,
        simulated.filter((each) => each.strategy === names[0] && each.production === "correct")
          .length,
        ...names.map((name) => {
          const runs = simulated.filter((each) => each.strategy === name);
          const anchorMark = runs.some((each) => each.anchored && each.anchorCorrect === false)
            ? " (wrong anchor)"
            : "";

          return `${runs.filter((each) => each.outcome === "correct").length}/${runs.length}${anchorMark}`;
        }),
      ]),
    ),
  ];

  return [...pooled, "", ...films].join("\n");
};
