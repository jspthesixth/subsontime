import { code3Of } from "../languages.ts";
import type { Cue } from "../subtitles/cue.ts";

export type RangeReader = {
  size: number;
  read: (start: number, length: number) => Promise<Uint8Array>;
};

export type FileSubtitleTrack = {
  number: number;
  language: string;
  name?: string;
  codec: string;
  forced: boolean;
  cues: Cue[];
  changes: number[];
};

type Element = { id: number; data: number; end: number };

const ids = {
  ebml: 0x1a45dfa3,
  segment: 0x18538067,
  seekHead: 0x114d9b74,
  seek: 0x4dbb,
  seekId: 0x53ab,
  seekPosition: 0x53ac,
  info: 0x1549a966,
  timestampScale: 0x2ad7b1,
  tracks: 0x1654ae6b,
  trackEntry: 0xae,
  trackNumber: 0xd7,
  trackType: 0x83,
  codecId: 0x86,
  language: 0x22b59c,
  languageBCP47: 0x22b59d,
  name: 0x536e,
  flagForced: 0x55aa,
  cues: 0x1c53bb6b,
  cuePoint: 0xbb,
  cueTime: 0xb3,
  cueTrackPositions: 0xb7,
  cueTrack: 0xf7,
  cueDuration: 0xb2,
};

const subtitleType = 17;
const headBytes = 64 * 1024;
const headerBytes = 12;
const maximumElementBytes = 32 * 1024 * 1024;

const vintAt = (bytes: Uint8Array, at: number, keepMarker: boolean) => {
  const first = bytes[at] ?? 0;
  const length = Math.clz32(first) - 23;

  if (first === 0 || at + length > bytes.length) {
    return undefined;
  }

  const rest = Array.from(bytes.subarray(at + 1, at + length));
  const lead = keepMarker ? first : first & (0xff >> length);
  const unknown =
    !keepMarker &&
    [lead, ...rest].every((byte, index) => (index === 0 ? byte === 0xff >> length : byte === 0xff));

  return {
    length,
    value: unknown
      ? Number.POSITIVE_INFINITY
      : rest.reduce((value, byte) => value * 256 + byte, lead),
  };
};

const elementAt = (bytes: Uint8Array, at: number): Element | undefined => {
  const id = vintAt(bytes, at, true);
  const size = id === undefined ? undefined : vintAt(bytes, at + id.length, false);

  if (id === undefined || size === undefined) {
    return undefined;
  }

  const data = at + id.length + size.length;

  return { id: id.value, data, end: data + size.value };
};

function* siblings(bytes: Uint8Array, from: number, to: number) {
  let element = from < to ? elementAt(bytes, from) : undefined;

  while (element !== undefined && element.end <= to) {
    yield element;
    element = element.end < to ? elementAt(bytes, element.end) : undefined;
  }
}

const childrenOf = (bytes: Uint8Array, from: number, to: number) => [...siblings(bytes, from, to)];

const inside = (bytes: Uint8Array, parent: Element) =>
  childrenOf(bytes, parent.data, Math.min(parent.end, bytes.length));

const uintOf = (bytes: Uint8Array, { data, end }: Element) =>
  bytes.subarray(data, end).reduce((value, byte) => value * 256 + byte, 0);

const textOf = (bytes: Uint8Array, { data, end }: Element) =>
  new TextDecoder().decode(bytes.subarray(data, end)).replace(/\0+$/, "");

const fieldsOf = (bytes: Uint8Array, parent: Element) => {
  const children = inside(bytes, parent);
  const find = (id: number) => children.find((child) => child.id === id);

  return {
    uint: (id: number) => {
      const child = find(id);

      return child === undefined ? undefined : uintOf(bytes, child);
    },
    text: (id: number) => {
      const child = find(id);

      return child === undefined ? undefined : textOf(bytes, child);
    },
    all: (id: number) => children.filter((child) => child.id === id),
  };
};

type Body = { bytes: Uint8Array; element: Element };

const bodyAt = async ({ read, size }: RangeReader, at: number): Promise<Body | undefined> => {
  const header = await read(at, Math.min(headerBytes, size - at));
  const element = elementAt(header, 0);

  if (element === undefined || element.end - element.data > maximumElementBytes) {
    return undefined;
  }

  const bytes = await read(at + element.data, Math.min(element.end, size - at) - element.data);

  return { bytes, element: { id: element.id, data: 0, end: bytes.length } };
};

const seeksOf = (bytes: Uint8Array, seekHead: Element, segmentData: number) =>
  new Map(
    fieldsOf(bytes, seekHead)
      .all(ids.seek)
      .map((seek) => {
        const fields = fieldsOf(bytes, seek);
        const id = fields.all(ids.seekId)[0];

        return [
          id === undefined ? 0 : uintOf(bytes, id),
          segmentData + (fields.uint(ids.seekPosition) ?? 0),
        ] as const;
      }),
  );

const trackOf = (bytes: Uint8Array, entry: Element) => {
  const fields = fieldsOf(bytes, entry);

  return {
    number: fields.uint(ids.trackNumber) ?? 0,
    language: code3Of(fields.text(ids.languageBCP47) ?? fields.text(ids.language) ?? "eng"),
    name: fields.text(ids.name),
    codec: fields.text(ids.codecId) ?? "",
    forced: fields.uint(ids.flagForced) === 1,
  };
};

const cueTimingsOf = (bytes: Uint8Array, cues: Element, scale: number) =>
  fieldsOf(bytes, cues)
    .all(ids.cuePoint)
    .flatMap((point) => {
      const fields = fieldsOf(bytes, point);
      const time = fields.uint(ids.cueTime) ?? 0;

      return fields.all(ids.cueTrackPositions).flatMap((positions) => {
        const position = fieldsOf(bytes, positions);
        const duration = position.uint(ids.cueDuration);
        const track = position.uint(ids.cueTrack);

        return track === undefined
          ? []
          : [
              {
                track,
                start: Math.round((time * scale) / 1e6),
                end:
                  duration === undefined
                    ? undefined
                    : Math.round(((time + duration) * scale) / 1e6),
              },
            ];
      });
    });

export const subtitleTracksOf = async (reader: RangeReader): Promise<FileSubtitleTrack[]> => {
  const head = await reader.read(0, Math.min(headBytes, reader.size));
  const ebml = elementAt(head, 0);
  const segment = ebml?.id === ids.ebml ? elementAt(head, ebml.end) : undefined;

  if (segment?.id !== ids.segment) {
    return [];
  }

  const top = childrenOf(head, segment.data, head.length);
  const seekHead = top.find(({ id }) => id === ids.seekHead);
  const seeks =
    seekHead === undefined ? new Map<number, number>() : seeksOf(head, seekHead, segment.data);
  const bodyOf = async (id: number): Promise<Body | undefined> => {
    const inHead = top.find((element) => element.id === id);
    const at = seeks.get(id);

    if (inHead !== undefined) {
      return { bytes: head, element: inHead };
    }

    return at === undefined || at >= reader.size ? undefined : bodyAt(reader, at);
  };
  const [info, tracks, cues] = await Promise.all([ids.info, ids.tracks, ids.cues].map(bodyOf));

  if (tracks === undefined || cues === undefined) {
    return [];
  }

  const scale =
    info === undefined ? 1e6 : (fieldsOf(info.bytes, info.element).uint(ids.timestampScale) ?? 1e6);
  const timings = Map.groupBy(cueTimingsOf(cues.bytes, cues.element, scale), ({ track }) => track);

  return fieldsOf(tracks.bytes, tracks.element)
    .all(ids.trackEntry)
    .filter((entry) => fieldsOf(tracks.bytes, entry).uint(ids.trackType) === subtitleType)
    .map((entry) => trackOf(tracks.bytes, entry))
    .map((track) => {
      const timed = (timings.get(track.number) ?? []).toSorted((a, b) => a.start - b.start);

      return {
        ...track,
        cues: timed.flatMap(({ start, end }) =>
          end === undefined ? [] : [{ start, end, text: "" }],
        ),
        changes: timed.map(({ start }) => start),
      };
    });
};
