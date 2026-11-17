import csv
import io
import json
from pathlib import Path

from .config import LABELS


def csv_export(result: dict) -> str:
    output = io.StringIO(newline="")
    keys = list(result["runs"][0]["metrics"])
    writer = csv.writer(output)
    writer.writerow(["algorithm", "axis", "axis_value", "seed", *keys])
    for run in result["runs"]:
        writer.writerow(
            [
                run["algorithm"],
                result["request"]["axis"],
                run["axis_value"],
                run["config"]["seed"],
                *[run["metrics"][k] for k in keys],
            ]
        )
    return output.getvalue()


def markdown_report(result: dict) -> str:
    request = result["request"]
    lines = [
        f"# {request['name']}",
        "",
        f"Прогонов: {len(result['runs'])}. Seed: {request['config']['seed']}…",
        "95% ДИ: распределение Стьюдента по независимым seed; при n=1 ДИ не определён.",
        "",
        "| Алгоритм | Ось | Goodput, кбит/с (95% ДИ) | Потери разрешённых | P95, мс | Загрузка |",
        "|---|---:|---:|---:|---:|---:|",
    ]

    def fmt(value):
        return "н/д" if value is None else f"{value:.4g}"

    for row in result["summary"]:
        m = row["metrics"]
        g = m["goodput_kbps"]
        lines.append(
            f"| {LABELS[row['algorithm']]} | {row['axis_value']} | {fmt(g['mean'])} "
            f"[{fmt(g['ci_low'])}; {fmt(g['ci_high'])}] | {fmt(m['resolved_loss_rate']['mean'])} | "
            f"{fmt(m['p95_latency_ms']['mean'])} | {fmt(m['utilization']['mean'])} |"
        )
    lines.extend(
        [
            "",
            "## Интерпретация",
            "",
            "Goodput учитывает уникальные доставки до горизонта моделирования. Незавершённые блоки "
            "показаны отдельно как censored и не объявляются потерянными. Задержка измеряется от "
            "начала первой передачи до первого успешного приёма; очередь источника насыщенная.",
            "RTT в конфигурации исключает время передачи: цикл полного блока = RTT + slot_ms.",
            "CC суммирует линейную SNR, IR: взаимную информацию с учётом длины каждой передачи. "
            "Все стратегии используют одну скорость символов. Энергия на символ постоянна.",
            "Адаптивная стратегия: эвристика; преимущество и оптимальность заранее не предполагаются.",
            "BLER-кривая иллюстративная. Модель не является реализацией 3GPP NR/LDPC. "
            "Буферы резервируются консервативно, без симуляции LLR.",
            "",
            "## Парное сравнение",
            "",
        ]
    )
    for pair in result["paired"]:
        d = pair["goodput_delta_kbps"]
        lines.append(
            f"Ось {pair['axis_value']}: ΔG(adaptive − parallel) = {fmt(d['mean'])} кбит/с, "
            f"95% ДИ [{fmt(d['ci_low'])}; {fmt(d['ci_high'])}]."
        )
    lines.extend(
        [
            "",
            "## Конфигурация",
            "",
            "```json",
            json.dumps(request, ensure_ascii=False, indent=2),
            "```",
            "",
            "## Воспроизводимость",
            "",
            "```json",
            json.dumps(result["metadata"], ensure_ascii=False, indent=2),
            "```",
            "",
            "Источники: [3GPP TR 38.821](https://atisorg.s3.amazonaws.com/archive/3gpp-documents/Rel16/ATIS.3GPP.38.821.V1600.pdf), "
            "[TS 38.300](https://www.etsi.org/deliver/etsi_ts/138300_138399/138300/18.08.00_60/ts_138300v180800p.pdf).",
        ]
    )
    return "\n".join(lines)


def save_artifacts(result: dict, directory: Path):
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "experiment.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (directory / "runs.csv").write_text(csv_export(result), encoding="utf-8-sig")
    (directory / "report.md").write_text(markdown_report(result), encoding="utf-8")
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig, axes = plt.subplots(2, 2, figsize=(12, 8), layout="constrained")
    metrics = [
        ("goodput_kbps", "Goodput, kbit/s"),
        ("resolved_loss_rate", "Resolved packet loss"),
        ("p95_latency_ms", "P95 delivery latency, ms"),
        ("utilization", "Channel utilization"),
    ]
    for ax, (metric, label) in zip(axes.flat, metrics, strict=True):
        for algorithm in result["request"]["algorithms"]:
            rows = [s for s in result["summary"] if s["algorithm"] == algorithm]
            rows.sort(key=lambda r: r["axis_value"] or 0)
            valid = [r for r in rows if r["metrics"][metric]["mean"] is not None]
            x = [r["axis_value"] if r["axis_value"] is not None else 0 for r in valid]
            y = [r["metrics"][metric]["mean"] for r in valid]
            err = [
                (r["metrics"][metric]["ci_high"] or r["metrics"][metric]["mean"])
                - r["metrics"][metric]["mean"]
                for r in valid
            ]
            ax.errorbar(x, y, yerr=err, marker="o", capsize=3, label=LABELS[algorithm])
        ax.set(xlabel=result["request"]["axis"] or "Single configuration", ylabel=label)
        ax.grid(alpha=0.2)
    axes[0, 0].legend(fontsize=8)
    fig.savefig(directory / "comparison.png", dpi=180)
    fig.savefig(directory / "comparison.svg")
    plt.close(fig)
