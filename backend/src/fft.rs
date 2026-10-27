// SPDX-License-Identifier: GPL-3.0-or-later
// 取自 breadspice 的 fft.rs（同作者、同为 GPL-3），只改了文档措辞。

//! 示波器 FFT：把（可能非均匀采样的）波形做均匀重采样 → Hann 窗 → FFT →
//! 单边幅度谱 → RMS dB（规定 1V RMS = 0dB）→ 对数频率轴（0 ~ max_freq）。

use std::f64::consts::{PI, SQRT_2};

use rustfft::{num_complex::Complex, FftPlanner};

/// FFT 输出：对数频率轴（Hz）与对应 dB 值。
/// `x` 为时间、`y` 为电压（同长），`max_freq` 为频谱上限（Hz）。
pub fn fft_spectrum(x: &[f64], y: &[f64], max_freq: f64) -> Result<(Vec<f64>, Vec<f64>), String> {
    let n_in = x.len();
    if n_in < 4 || n_in != y.len() {
        return Err("波形数据不足".to_string());
    }

    // 1) 估算均匀采样率（用中位步长，抵抗自适应步长的离群点）
    let mut steps: Vec<f64> = (1..n_in)
        .map(|i| x[i] - x[i - 1])
        .filter(|&dt| dt > 0.0)
        .collect();
    if steps.is_empty() {
        return Err("波形时间步长为 0".to_string());
    }
    steps.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let dt = steps[steps.len() / 2];
    let sample_rate = 1.0 / dt;

    // 2) 均匀重采样（线性插值）
    let t0 = x[0];
    let t1 = x[n_in - 1];
    let n = (((t1 - t0) / dt).round() as usize).max(4) + 1;
    let uniform: Vec<f64> = (0..n)
        .map(|i| interp(x, y, t0 + i as f64 * dt))
        .collect();

    // 3) 去直流（均值）后做 FFT（Hann 窗），避免直流分量及其泄漏主导低频
    let mean = uniform.iter().sum::<f64>() / uniform.len() as f64;
    let n_fft = uniform.len();
    let mut planner = FftPlanner::new();
    let fft = planner.plan_fft_forward(n_fft);
    let mut buf: Vec<Complex<f64>> = uniform
        .iter()
        .enumerate()
        .map(|(i, &s)| {
            let w = 0.5 * (1.0 - (2.0 * PI * i as f64 / (n_fft - 1) as f64).cos());
            Complex::new((s - mean) * w, 0.0)
        })
        .collect();
    fft.process(&mut buf);

    // 4) 单边幅度谱 → RMS dB。Hann 相干增益 0.5，幅度校正 2；单边再乘 2 → 总因子 4/N。
    let mut freqs = Vec::new();
    let mut dbs = Vec::new();
    for i in 0..(n_fft / 2) {
        let f = i as f64 * sample_rate / n_fft as f64;
        if f > max_freq {
            break;
        }
        let amp = 4.0 * buf[i].re.hypot(buf[i].im) / (n_fft as f64);
        let rms = amp / SQRT_2;
        let db = if rms > 1e-12 { 20.0 * rms.log10() } else { -140.0 };
        freqs.push(f);
        dbs.push(db);
    }
    if freqs.len() < 2 {
        return Err("频谱点数不足".to_string());
    }

    // 5) 对数频率轴（dec）+ 最大池化（保留窄峰，避免取“最近 bin”落在旁瓣）
    let n_log = 200usize;
    let f_min = sample_rate / n_fft as f64;
    let f_max = max_freq.min(freqs[freqs.len() - 1]).max(f_min);
    let log_f: Vec<f64> = (0..n_log)
        .map(|i| {
            let t = i as f64 / (n_log - 1) as f64;
            f_min * (f_max / f_min).powf(t)
        })
        .collect();
    let log_db: Vec<f64> = log_f
        .iter()
        .enumerate()
        .map(|(j, &f)| {
            let f_lo = if j == 0 { f_min } else { log_f[j - 1] };
            let f_hi = if j == n_log - 1 { f_max } else { log_f[j + 1] };
            let idx_lo =
                ((f_lo / sample_rate * n_fft as f64).ceil() as usize).min(dbs.len().saturating_sub(1));
            let idx_hi = ((f_hi / sample_rate * n_fft as f64).floor() as usize).min(dbs.len() - 1);
            if idx_lo > idx_hi {
                // 对数 bin 比一个线性 bin 还窄（低频端）：取最近 bin，避免空区间产生 -Infinity
                let idx = ((f / sample_rate * n_fft as f64).round() as usize).min(dbs.len() - 1);
                return dbs[idx];
            }
            let mut m = -f64::INFINITY;
            for k in idx_lo..=idx_hi {
                if dbs[k] > m {
                    m = dbs[k];
                }
            }
            m
        })
        .collect();

    Ok((log_f, log_db))
}

fn interp(x: &[f64], y: &[f64], t: f64) -> f64 {
    if t <= x[0] {
        return y[0];
    }
    if t >= x[x.len() - 1] {
        return y[y.len() - 1];
    }
    let mut lo = 0;
    let mut hi = x.len() - 1;
    while hi - lo > 1 {
        let mid = (lo + hi) >> 1;
        if x[mid] <= t {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    let span = x[hi] - x[lo];
    if span <= 0.0 {
        return y[lo];
    }
    let k = (t - x[lo]) / span;
    y[lo] + (y[hi] - y[lo]) * k
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fft_of_sine_has_peak_at_fundamental() {
        // 1kHz、1V 峰值正弦，采样 100kHz，共 0.1s
        let fs = 100_000.0;
        let n = 10_000usize;
        let x: Vec<f64> = (0..n).map(|i| i as f64 / fs).collect();
        let y: Vec<f64> = x.iter().map(|&t| (2.0 * PI * 1000.0 * t).sin()).collect();

        let (freqs, dbs) = fft_spectrum(&x, &y, 40_000.0).unwrap();
        assert!(!freqs.is_empty() && !dbs.is_empty());
        // 1kHz 处附近应有峰值（1V 峰值 → RMS 0.707V → 约 -3dB）
        let mut peak = -f64::INFINITY;
        let mut peak_f = 0.0;
        for i in 0..freqs.len() {
            if freqs[i] > 200.0 && freqs[i] < 5000.0 && dbs[i] > peak {
                peak = dbs[i];
                peak_f = freqs[i];
            }
        }
        assert!((peak_f - 1000.0).abs() < 200.0, "峰值频率 {peak_f}");
        assert!((peak - (-3.0)).abs() < 1.5, "1V 峰值正弦应约 -3dB，实际 {peak}");
    }

    #[test]
    fn dc_offset_is_removed() {
        // 5V 直流偏置 + 0.2V 峰值 1kHz 正弦：直流应被去除，低频不再主导
        let fs = 100_000.0;
        let n = 10_000usize;
        let x: Vec<f64> = (0..n).map(|i| i as f64 / fs).collect();
        let y: Vec<f64> = x.iter().map(|&t| 5.0 + 0.2 * (2.0 * PI * 1000.0 * t).sin()).collect();

        let (freqs, dbs) = fft_spectrum(&x, &y, 40_000.0).unwrap();
        // 低频（<100Hz）不应有大的分量
        let low_max = freqs
            .iter()
            .zip(&dbs)
            .filter(|(f, _)| **f < 100.0)
            .map(|(_, d)| *d)
            .fold(-f64::INFINITY, f64::max);
        assert!(low_max < -60.0, "低频分量应很小，实际 {low_max}dB");
        // 1kHz 处峰值约 0.2V 峰值 → 0.141V RMS → 约 -17dB
        let peak = freqs
            .iter()
            .zip(&dbs)
            .filter(|(f, _)| **f > 200.0 && **f < 5000.0)
            .map(|(_, d)| *d)
            .fold(-f64::INFINITY, f64::max);
        assert!((peak - (-17.0)).abs() < 2.0, "0.2V 峰值正弦应约 -17dB，实际 {peak}dB");
    }

    #[test]
    fn output_is_finite() {
        // 带直流偏置的波形：输出频谱不应含 NaN / -Infinity（此前低频空区间会产出 -Infinity）
        let fs = 100_000.0;
        let n = 10_000usize;
        let x: Vec<f64> = (0..n).map(|i| i as f64 / fs).collect();
        let y: Vec<f64> = x.iter().map(|&t| 3.0 + 0.2 * (2.0 * PI * 1000.0 * t).sin()).collect();
        let (freqs, dbs) = fft_spectrum(&x, &y, 40_000.0).unwrap();
        for (f, d) in freqs.iter().zip(&dbs) {
            assert!(f.is_finite() && d.is_finite(), "f={f} d={d} 应为有限值");
        }
    }
}
