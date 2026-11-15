use alass_core::{NoProgressHandler, TimePoint, TimeSpan, overlap_scoring, standard_scoring};
use earshot::Detector;
use wasm_bindgen::prelude::{JsError, wasm_bindgen};

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

const SPEECH_SAMPLE_RATE: u32 = 16000;
const FRAME_SAMPLES: usize = 256;
const FRAME_MS: i64 = 16;
const ANALYSIS_LAG_MS: i64 = 16;
const SPEECH_THRESHOLD: f32 = 0.5;
const MERGE_GAP_MS: i64 = 200;
const MIN_SPAN_MS: i64 = 300;

#[wasm_bindgen]
pub struct SpeechDetector {
    detector: Box<Detector>,
    remainder: Vec<i16>,
    frames: i64,
    open: Option<(i64, i64)>,
    spans: Vec<i64>,
}

#[wasm_bindgen]
impl SpeechDetector {
    #[wasm_bindgen(constructor)]
    pub fn new(sample_rate: u32) -> Result<SpeechDetector, JsError> {
        if sample_rate != SPEECH_SAMPLE_RATE {
            return Err(JsError::new(&format!(
                "speech detection needs {SPEECH_SAMPLE_RATE} Hz audio, got {sample_rate} Hz"
            )));
        }

        Ok(SpeechDetector {
            detector: Detector::default_boxed(),
            remainder: Vec::with_capacity(FRAME_SAMPLES),
            frames: 0,
            open: None,
            spans: Vec::new(),
        })
    }

    pub fn push(&mut self, samples: &[i16]) {
        let fill = (FRAME_SAMPLES - self.remainder.len()).min(samples.len());
        let (head, rest) = samples.split_at(fill);

        self.remainder.extend_from_slice(head);
        if self.remainder.len() < FRAME_SAMPLES {
            return;
        }

        let score = self.detector.predict_i16(&self.remainder);

        self.remainder.clear();
        self.mark(score);

        let (frames, tail) = rest.as_chunks::<FRAME_SAMPLES>();

        self.remainder.extend_from_slice(tail);
        for frame in frames {
            let score = self.detector.predict_i16(frame);

            self.mark(score);
        }
    }

    pub fn finish(&mut self) -> Vec<i64> {
        if !self.remainder.is_empty() {
            self.remainder.resize(FRAME_SAMPLES, 0);

            let score = self.detector.predict_i16(&self.remainder);

            self.remainder.clear();
            self.mark(score);
        }

        self.close();
        std::mem::take(&mut self.spans)
    }

    fn mark(&mut self, score: f32) {
        let index = self.frames;

        self.frames += 1;
        if score < SPEECH_THRESHOLD {
            return;
        }

        match self.open {
            Some((start, last)) if (index - last - 1) * FRAME_MS < MERGE_GAP_MS => {
                self.open = Some((start, index))
            }
            _ => {
                self.close();
                self.open = Some((index, index));
            }
        }
    }

    fn close(&mut self) {
        if let Some((start, last)) = self.open.take() {
            let start_ms = (start * FRAME_MS - ANALYSIS_LAG_MS).max(0);
            let end_ms = (last + 1) * FRAME_MS - ANALYSIS_LAG_MS;

            if end_ms - start_ms >= MIN_SPAN_MS {
                self.spans.extend([start_ms, end_ms]);
            }
        }
    }
}
