use alass_core::{NoProgressHandler, TimePoint, TimeSpan, overlap_scoring, standard_scoring};
use wasm_bindgen::prelude::wasm_bindgen;

fn spans(flat: &[i64]) -> Vec<TimeSpan> {
    flat.as_chunks::<2>()
        .0
        .iter()
        .map(|[start, end]| TimeSpan::new_safe(TimePoint::from(*start), TimePoint::from(*end)))
        .collect()
}

fn scaled(subtitle: &[TimeSpan], speed_ratio: f64) -> Vec<TimeSpan> {
    subtitle
        .iter()
        .map(|span| span.scaled(1.0 / speed_ratio))
        .collect()
}

fn merged(flat: &[i64]) -> Vec<TimeSpan> {
    let mut sorted = spans(flat);

    sorted.sort_by_key(|span| span.start);
    sorted
        .into_iter()
        .fold(Vec::<TimeSpan>::new(), |mut merged, span| {
            match merged.last_mut() {
                Some(last) if span.start <= last.end => last.end = last.end.max(span.end),
                _ => merged.push(span),
            }
            merged
        })
}

fn covered(speech: &[TimeSpan], span: TimeSpan) -> i64 {
    speech
        .iter()
        .map(|part| span.get_overlapping_length(*part).as_i64())
        .sum()
}

#[wasm_bindgen]
pub fn align(
    reference: &[i64],
    subtitle: &[i64],
    split_penalty: f64,
    speed_ratio: f64,
) -> Vec<i64> {
    let original = spans(subtitle);
    let scaled = scaled(&original, speed_ratio);
    let (deltas, _) = alass_core::align(
        &spans(reference),
        &scaled,
        split_penalty,
        Some(1.0),
        standard_scoring,
        NoProgressHandler,
    );

    original
        .iter()
        .zip(&scaled)
        .zip(deltas)
        .map(|((original, scaled), delta)| {
            scaled.start.as_i64() + delta.as_i64() - original.start.as_i64()
        })
        .collect()
}

#[wasm_bindgen]
pub fn align_offset(reference: &[i64], subtitle: &[i64], speed_ratio: f64) -> i64 {
    alass_core::align_nosplit(
        &spans(reference),
        &scaled(&spans(subtitle), speed_ratio),
        overlap_scoring,
        NoProgressHandler,
    )
    .0
    .as_i64()
}

#[wasm_bindgen]
pub fn score(reference: &[i64], subtitle: &[i64]) -> f64 {
    let speech = merged(reference);
    let cues = spans(subtitle);
    let total: i64 = cues.iter().map(|cue| cue.len().as_i64()).sum();
    let overlap: i64 = cues.iter().map(|cue| covered(&speech, *cue)).sum();
    let first = cues.iter().map(|cue| cue.start).min();
    let last = cues.iter().map(|cue| cue.end).max();

    match (first, last) {
        (Some(first), Some(last)) if first < last && total > 0 => {
            let window = TimeSpan::new(first, last);
            let coverage = covered(&speech, window) as f64 / window.len().as_i64() as f64;

            if coverage >= 1.0 {
                0.0
            } else {
                ((overlap as f64 / total as f64 - coverage) / (1.0 - coverage)).clamp(-1.0, 1.0)
            }
        }
        _ => 0.0,
    }
}
