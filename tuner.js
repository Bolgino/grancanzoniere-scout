// tuner.js — accordatore: riconosce la nota suonata dal microfono.
// Metodo: funzione di differenza quadratica normalizzata (NSDF, metodo di McLeod) sul segnale,
// si prende il primo massimo vicino al più alto e lo si affina con un'interpolazione parabolica.
// Solo funzioni "pure": si provano senza microfono.

export const NOTE_NAMES = ["Do", "Do#", "Re", "Re#", "Mi", "Fa", "Fa#", "Sol", "Sol#", "La", "La#", "Si"];

// Corde a vuoto (numero MIDI): chitarra dalla 6ª (Mi basso) alla 1ª, ukulele Sol Do Mi La (Sol acuto)
export const TUNINGS = {
    guitar: { label: "Chitarra", strings: [[40, "6ª"], [45, "5ª"], [50, "4ª"], [55, "3ª"], [59, "2ª"], [64, "1ª"]] },
    uke: { label: "Ukulele", strings: [[67, "4ª"], [60, "3ª"], [64, "2ª"], [69, "1ª"]] },
};

export const midiToFreq = (midi, a4 = 440) => a4 * Math.pow(2, (midi - 69) / 12);
export const centsBetween = (f, ref) => 1200 * Math.log2(f / ref);

// Nota più vicina a una frequenza: { name, octave, midi, cents (-50..+50) }
export function noteInfo(freq, a4 = 440) {
    const m = 69 + 12 * Math.log2(freq / a4);
    const midi = Math.round(m);
    return { name: NOTE_NAMES[((midi % 12) + 12) % 12], octave: Math.floor(midi / 12) - 1, midi, cents: (m - midi) * 100 };
}

// Corda più vicina dello strumento: { index, midi, label, name, target, cents }
export function nearestString(freq, tuning = "guitar", a4 = 440) {
    let best = null;
    TUNINGS[tuning].strings.forEach(([midi, label], index) => {
        const target = midiToFreq(midi, a4);
        const cents = centsBetween(freq, target);
        if (!best || Math.abs(cents) < Math.abs(best.cents)) best = { index, midi, label, name: NOTE_NAMES[midi % 12], target, cents };
    });
    return best;
}

// Frequenza fondamentale del pezzo di segnale (Float32Array, valori -1..1) oppure null se è solo rumore.
// Restituisce { freq, clarity (0..1), rms }.
export function detectPitch(input, sampleRate, opts = {}) {
    const minFreq = opts.minFreq || 60, maxFreq = opts.maxFreq || 1100;
    // sopra i 30 kHz dimezzo i campioni (media a due a due): stessa precisione, 4 volte meno calcoli
    let x = input, sr = sampleRate;
    if (sr > 30000) {
        const half = new Float32Array(Math.floor(input.length / 2));
        for (let i = 0; i < half.length; i++) half[i] = (input[2 * i] + input[2 * i + 1]) / 2;
        x = half; sr = sampleRate / 2;
    }
    const n = x.length;
    let mean = 0;
    for (let i = 0; i < n; i++) mean += x[i];
    mean /= n;
    let energy = 0;
    const y = new Float32Array(n);
    for (let i = 0; i < n; i++) { y[i] = x[i] - mean; energy += y[i] * y[i]; }
    const rms = Math.sqrt(energy / n);
    if (rms < (opts.minRms ?? 0.006)) return null;

    const tauMax = Math.min(n - 2, Math.ceil(sr / minFreq) + 2);
    const tauMin = Math.max(2, Math.floor(sr / maxFreq));
    // NSDF(τ) = 2·Σ y[j]·y[j+τ] / Σ (y[j]² + y[j+τ]²)
    const nsdf = new Float32Array(tauMax + 2);
    let m = 2 * energy;
    for (let tau = 0; tau <= tauMax + 1; tau++) {
        if (tau > 0) m -= y[tau - 1] * y[tau - 1] + y[n - tau] * y[n - tau];
        let acf = 0;
        for (let j = 0, lim = n - tau; j < lim; j++) acf += y[j] * y[j + tau];
        nsdf[tau] = m > 0 ? (2 * acf) / m : 0;
    }
    // massimi tra un passaggio per lo zero in salita e quello in discesa (dopo il primo tratto negativo)
    const peaks = [];
    let tau = 1;
    while (tau < tauMax && nsdf[tau] > 0) tau++;          // salto il lobo iniziale (τ ≈ 0)
    while (tau < tauMax) {
        while (tau < tauMax && nsdf[tau] <= 0) tau++;
        let best = -1, bestTau = -1;
        while (tau < tauMax && nsdf[tau] > 0) {
            if (nsdf[tau] > best) { best = nsdf[tau]; bestTau = tau; }
            tau++;
        }
        if (bestTau > 0 && bestTau >= tauMin) peaks.push(bestTau);
    }
    if (!peaks.length) return null;
    const top = Math.max(...peaks.map(t => nsdf[t]));
    const k = opts.threshold ?? 0.9;
    const chosen = peaks.find(t => nsdf[t] >= k * top);
    // interpolazione parabolica intorno al massimo
    const a = nsdf[chosen - 1], b = nsdf[chosen], c = nsdf[chosen + 1];
    const den = a - 2 * b + c;
    const shift = den !== 0 ? 0.5 * (a - c) / den : 0;
    const period = chosen + shift;
    const clarity = b - 0.25 * (a - c) * shift;
    if (clarity < (opts.minClarity ?? 0.6)) return null;
    const freq = sr / period;
    if (freq < minFreq || freq > maxFreq) return null;
    return { freq, clarity, rms };
}
